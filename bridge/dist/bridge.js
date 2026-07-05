"use strict";
// The MCP bridge WebSocket server. Runs INSIDE the EEZ Studio renderer (which has
// nodeIntegration), binds to 127.0.0.1 only, authenticates with a shared token, and
// dispatches requests straight against the live ProjectStore. A handshake file lets
// the standalone MCP server auto-discover the port + token.
//
// Configuration + control: the bridge reads a persisted config file
// (<userData>/eez-mcp-bridge-config.json = { enabled, port }); env vars override it.
// It can be started/stopped/restarted at runtime from the "MCP Bridge" menu (which
// sends ipc "mcp-bridge/*") or the console global window.eezMcpBridge.
Object.defineProperty(exports, "__esModule", { value: true });
exports.bridgeStatus = bridgeStatus;
exports.stopMcpBridge = stopMcpBridge;
exports.restartMcpBridge = restartMcpBridge;
exports.startMcpBridge = startMcpBridge;
const tslib_1 = require("tslib");
const fs = tslib_1.__importStar(require("fs"));
const path = tslib_1.__importStar(require("path"));
const crypto = tslib_1.__importStar(require("crypto"));
const protocol_1 = require("mcp-bridge/protocol");
const handlers_1 = require("mcp-bridge/handlers");
const console_capture_1 = require("mcp-bridge/console-capture");
const notification_capture_1 = require("mcp-bridge/notification-capture");
const PREFIX = "[mcp-bridge]";
function logInfo(msg) {
    // eslint-disable-next-line no-console
    console.info(`${PREFIX} ${msg}`);
}
function logError(msg, err) {
    // eslint-disable-next-line no-console
    console.error(`${PREFIX} ${msg}`, err ?? "");
}
let controlInstalled = false;
let started = false;
let server;
let currentPort = protocol_1.DEFAULT_PORT;
let currentToken = "";
// --- Configuration ---------------------------------------------------------
function configFilePath() {
    try {
        const app = require("@electron/remote").app;
        return path.join(app.getPath("userData"), "eez-mcp-bridge-config.json");
    }
    catch (e) {
        return undefined;
    }
}
function loadConfig() {
    const config = { enabled: true, port: protocol_1.DEFAULT_PORT };
    const file = configFilePath();
    if (file) {
        try {
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
                if (typeof parsed.enabled === "boolean") {
                    config.enabled = parsed.enabled;
                }
                if (Number.isFinite(parsed.port)) {
                    config.port = parsed.port;
                }
            }
            else {
                fs.writeFileSync(file, JSON.stringify(config, null, 2));
            }
        }
        catch (e) {
            logError("failed to read config; using defaults", e);
        }
    }
    // Env vars override the file.
    if (process.env.EEZ_MCP_BRIDGE === "0") {
        config.enabled = false;
    }
    const envPort = Number(process.env.EEZ_MCP_BRIDGE_PORT);
    if (Number.isFinite(envPort) && envPort > 0) {
        config.port = envPort;
    }
    return config;
}
function saveConfig(patch) {
    const file = configFilePath();
    if (!file)
        return;
    try {
        const current = loadConfig();
        const next = { ...current, ...patch };
        fs.writeFileSync(file, JSON.stringify(next, null, 2));
    }
    catch (e) {
        logError("failed to save config", e);
    }
}
// --- Request handling ------------------------------------------------------
async function handleRequest(req) {
    const handler = handlers_1.handlers[req.method];
    if (!handler) {
        return {
            id: req.id,
            ok: false,
            error: { code: "BAD_PARAMS", message: `Unknown method "${req.method}".` }
        };
    }
    try {
        const result = await handler(req.params || {});
        return { id: req.id, ok: true, result };
    }
    catch (e) {
        if (e instanceof protocol_1.BridgeError) {
            return { id: req.id, ok: false, error: { code: e.code, message: e.message } };
        }
        const message = e instanceof Error ? e.message : String(e);
        logError(`method "${req.method}" failed`, e);
        return { id: req.id, ok: false, error: { code: "INTERNAL", message } };
    }
}
function writeHandshake(port, token) {
    let eezStudioVersion = "unknown";
    try {
        eezStudioVersion = require("@electron/remote").app.getVersion();
    }
    catch (e) {
        /* ignore */
    }
    const payload = {
        port,
        token,
        pid: process.pid,
        protocolVersion: protocol_1.PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
        eezStudioVersion
    };
    try {
        fs.writeFileSync(protocol_1.HANDSHAKE_FILE, JSON.stringify(payload, null, 2));
    }
    catch (e) {
        logError("failed to write handshake file", e);
    }
}
function removeHandshake() {
    try {
        if (fs.existsSync(protocol_1.HANDSHAKE_FILE)) {
            fs.unlinkSync(protocol_1.HANDSHAKE_FILE);
        }
    }
    catch (e) {
        /* ignore */
    }
}
// --- Server lifecycle ------------------------------------------------------
function startServer(port) {
    if (started) {
        return;
    }
    const token = process.env.EEZ_MCP_BRIDGE_TOKEN ||
        crypto.randomBytes(16).toString("hex");
    let WSModule;
    try {
        WSModule = require("ws");
    }
    catch (e) {
        logError("the 'ws' module is not available; bridge not started", e);
        return;
    }
    // ws 8 exposes WebSocketServer; ws 7 (bundled in the official release binary)
    // exposes it as Server. Support both so the same bridge works from-source and
    // when injected into the release binary.
    const WSServer = WSModule.WebSocketServer || WSModule.Server;
    try {
        server = new WSServer({
            host: "127.0.0.1",
            port,
            verifyClient: (info, cb) => {
                try {
                    const url = new URL(info.req.url, "http://127.0.0.1");
                    if (url.searchParams.get("token") === token) {
                        cb(true);
                    }
                    else {
                        cb(false, 401, "Unauthorized");
                    }
                }
                catch (e) {
                    cb(false, 400, "Bad Request");
                }
            }
        });
    }
    catch (e) {
        logError("failed to create WebSocket server", e);
        return;
    }
    started = true;
    currentPort = port;
    currentToken = token;
    server.on("listening", () => {
        writeHandshake(port, token);
        logInfo(`listening on 127.0.0.1:${port} (handshake: ${protocol_1.HANDSHAKE_FILE})`);
    });
    server.on("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
            logError(`port ${port} is already in use — another EEZ Studio bridge may be running. ` +
                `Change the port in the MCP Bridge settings.`);
        }
        else {
            logError("server error", err);
        }
        started = false;
    });
    server.on("connection", (socket) => {
        let hello = null;
        try {
            hello = handlers_1.handlers.get_project_info({});
        }
        catch (e) {
            hello = null;
        }
        try {
            socket.send(JSON.stringify({ event: "hello", data: hello }));
        }
        catch (e) {
            /* ignore */
        }
        socket.on("message", async (data) => {
            let req;
            try {
                req = JSON.parse(data.toString());
            }
            catch (e) {
                socket.send(JSON.stringify({
                    id: "",
                    ok: false,
                    error: { code: "BAD_PARAMS", message: "Invalid JSON." }
                }));
                return;
            }
            const res = await handleRequest(req);
            try {
                socket.send(JSON.stringify(res));
            }
            catch (e) {
                logError("failed to send response", e);
            }
        });
    });
}
function stopServer() {
    removeHandshake();
    if (server) {
        try {
            server.close();
        }
        catch (e) {
            /* ignore */
        }
        server = undefined;
    }
    started = false;
}
function bridgeStatus() {
    return {
        running: started,
        port: currentPort,
        token: started ? currentToken : null,
        handshakeFile: protocol_1.HANDSHAKE_FILE,
        configFile: configFilePath() || null
    };
}
function stopMcpBridge() {
    stopServer();
    saveConfig({ enabled: false });
    logInfo("stopped");
}
function restartMcpBridge() {
    stopServer();
    const config = loadConfig();
    startServer(config.port);
    saveConfig({ enabled: true, port: config.port });
}
// --- Renderer control wiring (menu ipc + console global) -------------------
function installControl() {
    if (controlInstalled)
        return;
    controlInstalled = true;
    const notifyStatus = () => {
        const s = bridgeStatus();
        try {
            const notification = require("eez-studio-ui/notification");
            notification.info(s.running
                ? `MCP bridge running on 127.0.0.1:${s.port}`
                : "MCP bridge is stopped");
        }
        catch (e) {
            logInfo(s.running ? `running on ${s.port}` : "stopped");
        }
    };
    try {
        const { ipcRenderer, shell } = require("electron");
        ipcRenderer.on("mcp-bridge/start", () => {
            const config = loadConfig();
            startServer(config.port);
            saveConfig({ enabled: true, port: config.port });
            notifyStatus();
        });
        ipcRenderer.on("mcp-bridge/stop", () => {
            stopMcpBridge();
            notifyStatus();
        });
        ipcRenderer.on("mcp-bridge/restart", () => {
            restartMcpBridge();
            notifyStatus();
        });
        ipcRenderer.on("mcp-bridge/status", () => notifyStatus());
        ipcRenderer.on("mcp-bridge/settings", () => {
            const file = configFilePath();
            if (file) {
                try {
                    loadConfig(); // ensure the file exists
                    shell.openPath(file);
                }
                catch (e) {
                    logError("failed to open config file", e);
                }
            }
        });
    }
    catch (e) {
        logError("failed to wire menu control", e);
    }
    // Console-friendly control global.
    try {
        window.eezMcpBridge = {
            start: () => startServer(loadConfig().port),
            stop: stopMcpBridge,
            restart: restartMcpBridge,
            status: bridgeStatus,
            setPort: (port) => {
                saveConfig({ port });
                restartMcpBridge();
            }
        };
    }
    catch (e) {
        /* ignore */
    }
    // Tear down on renderer reload/close so the port is released.
    if (typeof window !== "undefined") {
        window.addEventListener("beforeunload", stopServer);
    }
}
/**
 * Start the MCP bridge. Idempotent and non-fatal: any failure is logged and swallowed
 * so it can never break EEZ Studio's boot. Honors the config file + env vars, and wires
 * the runtime start/stop/restart control (menu + console).
 */
function startMcpBridge() {
    // Capture console + toast notifications ASAP so early diagnostics (e.g. font
    // extraction failures on open) are available via get_notifications/get_console_log.
    (0, console_capture_1.installConsoleCapture)();
    (0, notification_capture_1.installNotificationCapture)();
    installControl();
    const config = loadConfig();
    if (!config.enabled) {
        logInfo("disabled (config.enabled=false or EEZ_MCP_BRIDGE=0)");
        return;
    }
    startServer(config.port);
}
