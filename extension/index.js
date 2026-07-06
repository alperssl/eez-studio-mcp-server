// EEZ Studio MCP Bridge — project extension (pext).
//
// EEZ Studio auto-loads every folder in its user-data `extensions/` dir at startup:
// it does `require(folder).default` and calls `.init()`. Because EEZ registers `build/`
// as a global Node module root (app-module-path, packages/main/fix-path.ts), code that
// runs in the renderer can `require("project-editor/store")` / `require("home/tabs-store")`
// and reach the SAME live singletons the editor uses. That is all the bridge needs —
// so this ships as a drop-in extension with NO app patching.
//
// The bundled bridge lives in ./mcp-bridge/ (assembled from bridge/dist by install.mjs /
// pack.mjs, with its intra-bundle `mcp-bridge/*` requires rewritten to relative paths).

"use strict";

// Make EEZ Studio's OWN node_modules resolvable from this external extension folder.
// EEZ registers build/ as a global module root (app-module-path) — which is why the
// bridge can require("project-editor/store") — but that root does NOT cover node_modules.
// The bridge needs app packages, above all mobx: it MUST be the app's single instance so
// observables/actions coordinate with the editor (a second copy would silently no-op).
// Patch _nodeModulePaths (the same technique app-module-path uses) to append the app's
// node_modules dirs, so mobx (and any other app dep) resolves to the app's own copy.
(function addAppNodeModules() {
    try {
        const Module = require("module");
        const path = require("path");
        if (Module.__eezMcpBridgePatched || !process.resourcesPath) return;
        const roots = [
            path.join(process.resourcesPath, "app.asar", "node_modules"),
            path.join(process.resourcesPath, "app", "node_modules"),
            path.join(process.resourcesPath, "app.asar.unpacked", "node_modules")
        ];
        Module.__eezMcpBridgePatched = true;
        const orig = Module._nodeModulePaths;
        Module._nodeModulePaths = function (from) {
            const paths = orig.call(this, from);
            for (const r of roots) {
                if (paths.indexOf(r) === -1) paths.push(r);
            }
            return paths;
        };
    } catch (e) {
        // Non-fatal: on layouts where this fails, bundled deps still cover ws/tslib.
    }
})();

let _bridge = null;
function bridge() {
    if (!_bridge) {
        _bridge = require("./mcp-bridge/bridge");
    }
    return _bridge;
}

function isRenderer() {
    return typeof process !== "undefined" && process.type === "renderer";
}

function safeStatus() {
    try {
        return bridge().bridgeStatus();
    } catch (e) {
        return { running: false, port: null, token: null, handshakeFile: null, configFile: null };
    }
}

// ---------------------------------------------------------------------------
// Home-tab "MCP Bridge" settings + status panel (plain React, no JSX build).
// ---------------------------------------------------------------------------
function McpBridgePanel() {
    const React = require("react");
    const h = React.createElement;

    const [status, setStatus] = React.useState(safeStatus);
    const [port, setPort] = React.useState(function () {
        const s = safeStatus();
        return s.port || 38017;
    });
    const [copied, setCopied] = React.useState("");

    const refresh = React.useCallback(function () {
        setStatus(safeStatus());
    }, []);

    React.useEffect(function () {
        const t = setInterval(refresh, 1500);
        return function () {
            clearInterval(t);
        };
    }, [refresh]);

    const control = function (name) {
        try {
            const b = bridge();
            if (name === "start") b.startMcpBridge();
            else if (name === "stop") b.stopMcpBridge();
            else if (name === "restart") b.restartMcpBridge();
        } catch (e) {
            /* swallowed — bridge logs its own errors */
        }
        setTimeout(refresh, 250);
    };

    const applyPort = function () {
        try {
            const p = parseInt(port, 10);
            if (!isNaN(p) && p > 0 && window.eezMcpBridge && window.eezMcpBridge.setPort) {
                window.eezMcpBridge.setPort(p);
            }
        } catch (e) {}
        setTimeout(refresh, 300);
    };

    const copy = function (label, value) {
        try {
            require("electron").clipboard.writeText(String(value || ""));
            setCopied(label);
            setTimeout(function () {
                setCopied("");
            }, 1200);
        } catch (e) {}
    };

    const openConfig = function () {
        try {
            if (status.configFile) require("electron").shell.openPath(status.configFile);
        } catch (e) {}
    };

    const running = !!status.running;

    // --- styles (inline; no external CSS dependency) ---
    const box = { padding: "12px 16px", maxWidth: 640, fontSize: 13, lineHeight: 1.5 };
    const row = { display: "flex", alignItems: "center", gap: 10, margin: "8px 0", flexWrap: "wrap" };
    const dot = {
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: running ? "#2e7d32" : "#9e9e9e",
        boxShadow: running ? "0 0 6px #2e7d32" : "none",
        flex: "0 0 auto"
    };
    const mono = { fontFamily: "monospace", background: "rgba(127,127,127,.15)", padding: "1px 6px", borderRadius: 4 };
    const btn = function (primary) {
        return {
            padding: "4px 12px",
            borderRadius: 5,
            border: "1px solid rgba(127,127,127,.4)",
            background: primary ? "#1e88e5" : "transparent",
            color: primary ? "#fff" : "inherit",
            cursor: "pointer",
            fontSize: 13
        };
    };
    const label = { opacity: 0.7, minWidth: 84, display: "inline-block" };
    const link = { color: "#1e88e5", cursor: "pointer", textDecoration: "underline", wordBreak: "break-all" };

    return h(
        "div",
        { style: box },
        h(
            "div",
            { style: Object.assign({}, row, { fontSize: 15, fontWeight: 600 }) },
            h("span", { style: dot }),
            h("span", null, running ? "Running" : "Stopped"),
            running && status.port
                ? h("span", { style: mono }, "127.0.0.1:" + status.port)
                : null
        ),
        h(
            "div",
            { style: row },
            h("button", { style: btn(!running), onClick: function () { control("start"); } }, "Start"),
            h("button", { style: btn(false), onClick: function () { control("stop"); }, disabled: !running }, "Stop"),
            h("button", { style: btn(false), onClick: function () { control("restart"); } }, "Restart"),
            h("button", { style: btn(false), onClick: refresh }, "Refresh")
        ),
        h(
            "div",
            { style: row },
            h("span", { style: label }, "Port"),
            h("input", {
                type: "number",
                value: port,
                onChange: function (e) { setPort(e.target.value); },
                style: Object.assign({}, mono, { width: 96, fontFamily: "monospace" })
            }),
            h("button", { style: btn(false), onClick: applyPort }, "Apply & restart")
        ),
        h(
            "div",
            { style: row },
            h("span", { style: label }, "Token"),
            status.token
                ? h("code", { style: mono }, String(status.token).slice(0, 12) + "…")
                : h("span", { style: { opacity: 0.6 } }, "—"),
            status.token
                ? h("button", { style: btn(false), onClick: function () { copy("token", status.token); } },
                    copied === "token" ? "Copied ✓" : "Copy")
                : null
        ),
        status.configFile
            ? h(
                  "div",
                  { style: row },
                  h("span", { style: label }, "Config"),
                  h("span", { style: link, onClick: openConfig }, status.configFile)
              )
            : null,
        status.handshakeFile
            ? h(
                  "div",
                  { style: Object.assign({}, row, { fontSize: 12, opacity: 0.7 }) },
                  h("span", { style: label }, "Handshake"),
                  h("code", { style: mono }, status.handshakeFile)
              )
            : null,
        h(
            "div",
            { style: { marginTop: 12, fontSize: 12, opacity: 0.75 } },
            "The eez-studio-mcp server auto-discovers this bridge via the handshake file and connects over the token-authenticated localhost WebSocket. Disable at startup with EEZ_MCP_BRIDGE=0."
        )
    );
}

// ---------------------------------------------------------------------------
// Extension definition (the object EEZ Studio loads).
// ---------------------------------------------------------------------------
const extension = {
    init: function () {
        if (!isRenderer()) {
            return; // only the renderer has the live ProjectStore + LVGL-WASM preview
        }
        try {
            bridge().startMcpBridge();
        } catch (e) {
            try {
                console.error("[eez-studio-mcp-bridge] init failed:", e);
            } catch (e2) {}
        }
    },

    destroy: function () {
        try {
            bridge().stopMcpBridge();
        } catch (e) {}
    },

    homeSections: [
        {
            id: "eez-studio-mcp-bridge",
            title: "MCP Bridge",
            icon: "material:developer_board",
            category: "common",
            renderContent: function () {
                const React = require("react");
                return React.createElement(McpBridgePanel);
            }
        }
    ]
};

module.exports.default = extension;
