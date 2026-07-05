#!/usr/bin/env node
// patch-release.mjs — inject the MCP bridge into an OFFICIAL EEZ Studio 0.28.0 release
// install, for exact parity with the release binary (zero dependency divergence).
//
// Strategy: "directory mode". Electron runs from resources/app.asar if present, else from
// resources/app/. We extract app.asar -> app/, overlay the unpacked native modules, drop the
// prebuilt bridge into app/build/mcp-bridge/, inject a startup call into app/build/home/main.js,
// then disable app.asar so Electron runs the (patched) app/ directory. No asar repacking, no
// native-module unpack globs — the release code is otherwise byte-for-byte untouched.
//
// Usage:
//   node scripts/patch-release.mjs --app "<EEZ Studio install dir>" [--out "<dir>"] [--revert]
//     --app     path to an EEZ Studio 0.28.0 install (contains resources/app.asar; on macOS an
//               "EEZ Studio.app"). Required.
//     --out     patch a COPY at this path (leaves the original untouched). Recommended.
//     --revert  undo the patch (restore app.asar, remove app/).
//     --help
//
// Requires: Node 18+, and `npx @electron/asar` (fetched/cached on first run).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const BRIDGE_DIST = path.join(REPO, "bridge", "dist");

const MARKER = "/* mcp-bridge-injected */";
const INJECT =
    `\n;try{require("mcp-bridge").startMcpBridge();}catch(e){` +
    `console.error("[mcp-bridge] start failed",e);}${MARKER}\n`;

const c = { reset: "\x1b[0m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", b: "\x1b[36m" };
const log = m => console.log(m);
const ok = m => console.log(`${c.g}  ✓${c.reset} ${m}`);
const skip = m => console.log(`${c.y}  •${c.reset} ${m}`);
const step = m => console.log(`${c.b}▸${c.reset} ${m}`);
const fail = m => { console.error(`${c.r}✗ ${m}${c.reset}`); process.exit(1); };

function parseArgs(argv) {
    const a = { app: undefined, out: undefined, revert: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === "--help" || t === "-h") a.help = true;
        else if (t === "--revert") a.revert = true;
        else if (t === "--app") a.app = argv[++i];
        else if (t === "--out") a.out = argv[++i];
        else fail(`unknown argument: ${t}`);
    }
    return a;
}

function usage() {
    log(`patch-release.mjs — inject the MCP bridge into an official EEZ Studio 0.28.0 release
  node scripts/patch-release.mjs --app "<install dir>" [--out "<dir>"] [--revert]
    --app     EEZ Studio install (has resources/app.asar; macOS: the .app bundle). Required.
    --out     patch a COPY here (original untouched). Recommended.
    --revert  restore app.asar and remove app/.
Requires: npx @electron/asar (fetched on first run).`);
}

// resources dir: <app>/resources (win/linux) or <app>/Contents/Resources (mac .app)
function resolveResources(appPath) {
    const candidates = [
        path.join(appPath, "resources"),
        path.join(appPath, "Contents", "Resources")
    ];
    for (const rdir of candidates) {
        if (fs.existsSync(path.join(rdir, "app.asar")) ||
            fs.existsSync(path.join(rdir, "app"))) {
            return rdir;
        }
    }
    fail(`could not find resources/app.asar under ${appPath}`);
}

function asarExtract(asarFile, dest) {
    // execSync runs via the shell (cmd.exe on Windows), so `npx` resolves and the
    // quoted paths tolerate spaces — unlike execFileSync("npx.cmd", …) which EINVALs.
    execSync(`npx --yes @electron/asar extract "${asarFile}" "${dest}"`, {
        stdio: "inherit"
    });
}

function copyDir(src, dst) {
    fs.cpSync(src, dst, { recursive: true });
}

function injectBridge(appDir) {
    // 1. drop the prebuilt bridge modules
    const target = path.join(appDir, "build", "mcp-bridge");
    fs.mkdirSync(target, { recursive: true });
    let n = 0;
    for (const f of fs.readdirSync(BRIDGE_DIST)) {
        if (f.endsWith(".js")) {
            fs.copyFileSync(path.join(BRIDGE_DIST, f), path.join(target, f));
            n++;
        }
    }
    ok(`copied ${n} bridge modules -> build/mcp-bridge/`);

    // 2. inject the startup call into the renderer entry
    const mainJs = path.join(appDir, "build", "home", "main.js");
    if (!fs.existsSync(mainJs)) fail(`renderer entry not found: ${mainJs}`);
    let src = fs.readFileSync(mainJs, "utf8");
    if (src.includes(MARKER)) {
        skip("build/home/main.js already has the bridge startup call");
    } else {
        fs.writeFileSync(mainJs, src + INJECT);
        ok("injected startMcpBridge() into build/home/main.js");
    }
}

function apply(resourcesDir) {
    const asar = path.join(resourcesDir, "app.asar");
    const asarUnpacked = path.join(resourcesDir, "app.asar.unpacked");
    const appDir = path.join(resourcesDir, "app");
    const asarDisabled = asar + ".mcp-orig";

    if (!fs.existsSync(BRIDGE_DIST) || !fs.existsSync(path.join(BRIDGE_DIST, "index.js"))) {
        fail(`prebuilt bridge not found at ${BRIDGE_DIST} (expected bridge/dist/*.js)`);
    }

    if (fs.existsSync(appDir) && fs.existsSync(asarDisabled)) {
        // Already in directory mode — just refresh the bridge (idempotent update).
        step("already patched (directory mode) — refreshing bridge");
        injectBridge(appDir);
        ok("done (refreshed)");
        return;
    }
    if (!fs.existsSync(asar)) fail(`app.asar not found at ${asar}`);

    step(`extracting app.asar -> app/  (${resourcesDir})`);
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    asarExtract(asar, appDir);
    ok("extracted");

    if (fs.existsSync(asarUnpacked)) {
        step("overlaying unpacked native modules -> app/");
        copyDir(asarUnpacked, appDir);
        ok("native modules overlaid");
    }

    step("injecting the MCP bridge");
    injectBridge(appDir);

    step("disabling app.asar so Electron runs the patched app/ directory");
    fs.renameSync(asar, asarDisabled);
    if (fs.existsSync(asarUnpacked)) {
        fs.renameSync(asarUnpacked, asarUnpacked + ".mcp-orig");
    }
    ok("app.asar disabled (backup: app.asar.mcp-orig)");

    log(`\n${c.g}Patched.${c.reset} Launch the app in this install and open a project — the MCP`);
    log(`bridge starts automatically (127.0.0.1). Control it from the console global`);
    log(`window.eezMcpBridge or the config file %APPDATA%/eezstudio/eez-mcp-bridge-config.json.`);
}

function revert(resourcesDir) {
    const asar = path.join(resourcesDir, "app.asar");
    const asarUnpacked = path.join(resourcesDir, "app.asar.unpacked");
    const appDir = path.join(resourcesDir, "app");
    const asarDisabled = asar + ".mcp-orig";
    const unpackedDisabled = asarUnpacked + ".mcp-orig";

    if (!fs.existsSync(asarDisabled)) fail("nothing to revert (no app.asar.mcp-orig backup)");
    step("restoring app.asar");
    if (fs.existsSync(asar)) fs.rmSync(asar, { force: true });
    fs.renameSync(asarDisabled, asar);
    if (fs.existsSync(unpackedDisabled)) {
        if (fs.existsSync(asarUnpacked)) fs.rmSync(asarUnpacked, { recursive: true, force: true });
        fs.renameSync(unpackedDisabled, asarUnpacked);
    }
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    ok("reverted to the pristine release (app.asar restored, app/ removed)");
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.app) { usage(); process.exit(args.help ? 0 : 1); }
    if (!fs.existsSync(args.app)) fail(`--app path not found: ${args.app}`);

    let appPath = args.app;
    if (args.out && !args.revert) {
        step(`copying install to ${args.out} (original left untouched)`);
        if (fs.existsSync(args.out)) fail(`--out already exists: ${args.out} (remove it or pick another)`);
        copyDir(args.app, args.out);
        appPath = args.out;
        ok("copied");
    } else if (args.out && args.revert) {
        appPath = args.out;
    }

    const resourcesDir = resolveResources(appPath);
    if (args.revert) revert(resourcesDir);
    else apply(resourcesDir);
}

main();
