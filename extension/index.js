// EEZ Studio MCP Bridge — project extension (pext).
//
// EEZ Studio auto-loads every folder in its user-data `extensions/` dir at startup:
// it does `require(folder).default` and calls `.init()`. Because EEZ registers `build/`
// as a global Node module root (app-module-path, packages/main/fix-path.ts), code that
// runs in the renderer can `require("project-editor/store")` / `require("home/tabs-store")`
// and reach the SAME live singletons the editor uses. That is all the bridge needs —
// so this ships as a drop-in extension with NO app patching.
//
// UI: EEZ Studio 0.28.0 ships the extension "home section" slot commented out, so a
// registered home-section panel never renders. Instead, init() injects a small floating
// "MCP Bridge" panel straight into the renderer DOM (still 100% inside the extension — no
// app modification): a collapsed status pill that expands to start/stop/port/token controls.
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

function control(name) {
    try {
        const b = bridge();
        // stopMcpBridge() persists { enabled: false }, and startMcpBridge() honors that
        // flag (it doubles as the autostart entry point, so it MUST). That means a plain
        // startMcpBridge() no-ops after a Stop. restartMcpBridge() re-enables and starts,
        // so the panel's Start routes through it too (a stopped server makes its internal
        // stop a no-op) — otherwise Start-after-Stop does nothing.
        if (name === "start" || name === "restart") b.restartMcpBridge();
        else if (name === "stop") b.stopMcpBridge();
    } catch (e) {
        /* swallowed — bridge logs its own errors */
    }
}

// ---------------------------------------------------------------------------
// Floating "MCP Bridge" panel — plain DOM injected into the renderer.
// No react-dom dependency, so it is robust across EEZ Studio versions.
// ---------------------------------------------------------------------------
const WIDGET_ID = "eez-mcp-bridge-widget";
let pollTimer = null;

function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
}

function mountFloatingPanel() {
    if (!isRenderer() || typeof document === "undefined") return;
    // Body may not exist yet at extension-load time — wait for it.
    if (!document.body) {
        window.addEventListener("DOMContentLoaded", mountFloatingPanel, { once: true });
        return;
    }
    if (document.getElementById(WIDGET_ID)) return; // already mounted in this document

    let expanded = false;

    const wrap = el("div", {
        position: "fixed",
        right: "14px",
        bottom: "14px",
        zIndex: "2147483000",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        fontSize: "12px",
        color: "#e8e8e8",
        userSelect: "none"
    });
    wrap.id = WIDGET_ID;

    // --- collapsed pill ---
    const pill = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "7px",
        padding: "6px 11px",
        background: "rgba(28,28,30,0.92)",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: "999px",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
        cursor: "pointer",
        backdropFilter: "blur(6px)"
    });
    const pillDot = el("span", dotStyle(false));
    const pillText = el("span", { fontWeight: "600", letterSpacing: "0.3px" }, "MCP");
    pill.appendChild(pillDot);
    pill.appendChild(pillText);
    pill.title = "MCP Bridge — click to open";
    pill.onclick = () => { expanded = true; render(); };

    // --- expanded card ---
    const card = el("div", {
        width: "252px",
        padding: "12px 13px 11px",
        background: "rgba(28,28,30,0.94)",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: "10px",
        boxShadow: "0 8px 26px rgba(0,0,0,0.45)",
        backdropFilter: "blur(8px)"
    });

    wrap.appendChild(pill);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    function btn(label, kind) {
        const b = el("button", {
            flex: "1",
            padding: "5px 0",
            fontSize: "12px",
            color: kind === "primary" ? "#fff" : "#e8e8e8",
            background: kind === "primary" ? "#2f7bd6" : "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: "6px",
            cursor: "pointer"
        }, label);
        return b;
    }

    function labeledRow(labelText) {
        const row = el("div", {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            margin: "7px 0"
        });
        row.appendChild(el("span", { opacity: "0.6", minWidth: "44px" }, labelText));
        return row;
    }

    function render() {
        const s = safeStatus();
        const running = !!s.running;

        // pill reflects state even while collapsed
        Object.assign(pillDot.style, dotStyle(running));
        pillText.textContent = running && s.port ? "MCP " + s.port : "MCP";
        pill.style.display = expanded ? "none" : "flex";
        card.style.display = expanded ? "block" : "none";
        if (!expanded) return;

        card.textContent = "";

        // header
        const header = el("div", { display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px" });
        header.appendChild(el("span", dotStyle(running)));
        header.appendChild(el("span", { fontWeight: "700", fontSize: "13px" }, "MCP Bridge"));
        const spacer = el("span", { flex: "1" });
        header.appendChild(spacer);
        const collapse = el("span", {
            cursor: "pointer", opacity: "0.6", padding: "0 4px", fontSize: "16px", lineHeight: "1"
        }, "–");
        collapse.title = "Collapse";
        collapse.onclick = () => { expanded = false; render(); };
        header.appendChild(collapse);
        card.appendChild(header);

        // status line
        card.appendChild(el("div", { opacity: "0.85", margin: "6px 0 9px" },
            running ? "Running · 127.0.0.1:" + s.port : "Stopped"));

        // start / stop / restart
        const btnRow = el("div", { display: "flex", gap: "6px", marginBottom: "3px" });
        const startB = btn("Start", running ? "" : "primary");
        startB.disabled = running;
        if (running) startB.style.opacity = "0.5";
        startB.onclick = () => act(() => control("start"));
        const stopB = btn("Stop");
        stopB.disabled = !running;
        if (!running) stopB.style.opacity = "0.5";
        stopB.onclick = () => act(() => control("stop"));
        const restartB = btn("Restart");
        restartB.onclick = () => act(() => control("restart"));
        btnRow.appendChild(startB);
        btnRow.appendChild(stopB);
        btnRow.appendChild(restartB);
        card.appendChild(btnRow);

        // port
        const portRow = labeledRow("Port");
        const portInput = el("input", {
            width: "72px",
            padding: "3px 6px",
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#e8e8e8",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: "5px"
        });
        portInput.type = "number";
        portInput.value = String(s.port || 38017);
        const applyB = btn("Apply", "");
        applyB.style.flex = "0 0 auto";
        applyB.style.padding = "3px 10px";
        applyB.onclick = () => {
            const p = parseInt(portInput.value, 10);
            try {
                if (!isNaN(p) && p > 0 && window.eezMcpBridge && window.eezMcpBridge.setPort) {
                    window.eezMcpBridge.setPort(p);
                }
            } catch (e) {}
            act(() => {});
        };
        portRow.appendChild(portInput);
        portRow.appendChild(applyB);
        card.appendChild(portRow);

        // token
        const tokRow = labeledRow("Token");
        if (s.token) {
            tokRow.appendChild(el("code", {
                fontFamily: "monospace", flex: "1",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
            }, String(s.token).slice(0, 12) + "…"));
            const copyB = btn("Copy", "");
            copyB.style.flex = "0 0 auto";
            copyB.style.padding = "3px 10px";
            copyB.onclick = () => {
                try { require("electron").clipboard.writeText(String(s.token)); } catch (e) {}
                copyB.textContent = "Copied ✓";
                setTimeout(() => { copyB.textContent = "Copy"; }, 1100);
            };
            tokRow.appendChild(copyB);
        } else {
            tokRow.appendChild(el("span", { opacity: "0.5" }, "—"));
        }
        card.appendChild(tokRow);

        // config file link
        if (s.configFile) {
            const cfgRow = labeledRow("Config");
            const link = el("span", {
                color: "#5aa9ff", cursor: "pointer", textDecoration: "underline",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1"
            }, "eez-mcp-bridge-config.json");
            link.title = s.configFile;
            link.onclick = () => { try { require("electron").shell.openPath(s.configFile); } catch (e) {} };
            cfgRow.appendChild(link);
            card.appendChild(cfgRow);
        }

        // footer note
        card.appendChild(el("div", { marginTop: "9px", fontSize: "11px", opacity: "0.55", lineHeight: "1.4" },
            "eez-studio-mcp auto-discovers this bridge via the handshake file. Disable autostart with EEZ_MCP_BRIDGE=0."));
    }

    // run an action, then re-render shortly after so state settles
    function act(fn) {
        try { fn(); } catch (e) {}
        setTimeout(render, 250);
    }

    // Click anywhere outside the widget collapses it back to the pill. Capture phase so
    // it fires before other handlers; the pill's own expand click is inside wrap, so it
    // is ignored here.
    const onDocPointerDown = (e) => {
        if (expanded && !wrap.contains(e.target)) {
            expanded = false;
            render();
        }
    };
    document.addEventListener("mousedown", onDocPointerDown, true);

    render();
    pollTimer = setInterval(render, 1500);
    wrap.__cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        document.removeEventListener("mousedown", onDocPointerDown, true);
    };

    // Self-check for headless verification (captured by the bridge console ring buffer).
    try {
        // eslint-disable-next-line no-console
        console.log("[eez-studio-mcp-bridge] floating panel mounted:", document.body.contains(wrap));
    } catch (e) {}
}

function unmountFloatingPanel() {
    try {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        const existing = typeof document !== "undefined" && document.getElementById(WIDGET_ID);
        if (existing) {
            if (typeof existing.__cleanup === "function") existing.__cleanup();
            existing.remove();
        }
    } catch (e) {}
}

function dotStyle(running) {
    return {
        display: "inline-block",
        width: "9px",
        height: "9px",
        borderRadius: "50%",
        background: running ? "#37c46a" : "#8a8a8a",
        boxShadow: running ? "0 0 6px #37c46a" : "none",
        flex: "0 0 auto"
    };
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
        try {
            mountFloatingPanel();
        } catch (e) {
            try {
                console.error("[eez-studio-mcp-bridge] panel mount failed:", e);
            } catch (e2) {}
        }
    },

    destroy: function () {
        unmountFloatingPanel();
        try {
            bridge().stopMcpBridge();
        } catch (e) {}
    }
};

module.exports.default = extension;
