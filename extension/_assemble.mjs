// Shared assembly for the EEZ Studio MCP Bridge extension.
// Builds a self-contained extension folder: the manifest + entry point + the bridge
// modules (from ../bridge/dist), with the bridge's intra-bundle `mcp-bridge/*` requires
// rewritten to relative paths so they resolve inside the extension folder. The bridge's
// `project-editor/*` / `home/*` requires are left untouched — they resolve against EEZ
// Studio's own build/ module root at runtime.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(EXT_DIR, "..");
export const BRIDGE_DIST = path.join(REPO, "bridge", "dist");
export const EXTENSION_ID = "eez-studio-mcp-bridge";

/** Assemble the extension into `targetDir` (removes and recreates it). */
export function assembleInto(targetDir) {
    if (!fs.existsSync(path.join(BRIDGE_DIST, "index.js"))) {
        throw new Error(
            `bridge not built at ${BRIDGE_DIST} (expected bridge/dist/*.js). ` +
                `Build it first (see bridge/README.md).`
        );
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(targetDir, "mcp-bridge"), { recursive: true });

    // top-level extension files
    for (const f of ["package.json", "index.js", "README.md"]) {
        const src = path.join(EXT_DIR, f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(targetDir, f));
        }
    }

    // bridge modules -> <target>/mcp-bridge/, rewriting sibling requires to relative
    let n = 0;
    for (const f of fs.readdirSync(BRIDGE_DIST)) {
        if (!f.endsWith(".js")) continue;
        let code = fs.readFileSync(path.join(BRIDGE_DIST, f), "utf8");
        // require("mcp-bridge/protocol") -> require("./protocol") (all siblings here)
        code = code.replace(/require\((["'])mcp-bridge\//g, "require($1./");
        fs.writeFileSync(path.join(targetDir, "mcp-bridge", f), code);
        n++;
    }

    // Bundle the bridge's plain node_modules deps into <target>/node_modules/. Unlike
    // "project-editor/*" (resolved via EEZ's global build/ module root, app-module-path),
    // ordinary deps do NOT resolve from an external extension folder — so we ship them.
    //   ws    — the WebSocket server (zero deps)
    //   tslib — TypeScript emit helpers (the bridge is compiled with importHelpers)
    // Both are zero-dependency, so their folders alone suffice.
    const bundled = [];
    for (const dep of RUNTIME_DEPS) {
        const src = findDep(dep);
        if (!src) {
            throw new Error(
                `could not find the \`${dep}\` package to bundle (looked in mcp-server/, ` +
                    `bridge/, studio/ node_modules). Run \`npm install\` there first.`
            );
        }
        copyDir(src, path.join(targetDir, "node_modules", dep));
        bundled.push(dep);
    }

    return { targetDir, bridgeModules: n, bundledDeps: bundled };
}

const RUNTIME_DEPS = ["ws", "tslib"];

function findDep(name) {
    for (const base of ["mcp-server", "bridge", "studio"]) {
        const p = path.join(REPO, base, "node_modules", name);
        if (fs.existsSync(path.join(p, "package.json"))) return p;
    }
    return null;
}

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

/** The EEZ Studio user-data extensions folder for the current OS. */
export function extensionsFolderPath() {
    const home = os.homedir();
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appData, "eezstudio", "extensions");
    }
    if (process.platform === "darwin") {
        return path.join(home, "Library", "Application Support", "eezstudio", "extensions");
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    return path.join(xdg, "eezstudio", "extensions");
}
