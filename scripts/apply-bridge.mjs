#!/usr/bin/env node
// apply-bridge.mjs — apply (or revert) the EEZ Studio MCP bridge to an EEZ Studio source tree.
//
// This makes the fork reproducible: it copies the published bridge sources into
// <studio>/packages/mcp-bridge and wires startMcpBridge() into packages/home/main.tsx.
// It is idempotent (safe to re-run) and uses only Node built-ins.
//
//   node scripts/apply-bridge.mjs --studio ./studio
//   node scripts/apply-bridge.mjs --studio ./studio --revert
//   node scripts/apply-bridge.mjs --help
//
// Run this from the root of the EEZ Studio MCP Server repo, pointed at YOUR clone
// of https://github.com/eez-open/studio.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_SRC_DIR = path.join(REPO_ROOT, "bridge", "src");
const BRIDGE_PACKAGE_NAME = "mcp-bridge";

const MAIN_IMPORT_LINE = `import { startMcpBridge } from "${BRIDGE_PACKAGE_NAME}";`;
const MAIN_FUNCTION_ANCHOR = "async function main() {";
const DRAG_ANCHOR_MATCH = "handleDragAndDrop();";

// The block injected immediately after the handleDragAndDrop(); line.
// Kept at the surrounding 8-space indentation so main.tsx stays lint-clean.
const START_BRIDGE_BLOCK = [
    "",
    "        // Start the MCP bridge (localhost WebSocket) so the eez-studio-mcp",
    "        // server can inspect/edit/render the live project. Non-fatal; EEZ_MCP_BRIDGE=0 disables.",
    "        try {",
    "            startMcpBridge();",
    "        } catch (err) {",
    '            console.error("Failed to start MCP bridge", err);',
    "        }",
].join("\n");

// A regex that matches the injected startMcpBridge block regardless of the exact
// blank-line/whitespace layout, so --revert can strip it cleanly.
const START_BRIDGE_BLOCK_RE =
    /\n[ \t]*\/\/ Start the MCP bridge[\s\S]*?startMcpBridge\(\);[\s\S]*?console\.error\("Failed to start MCP bridge", err\);[\s\S]*?\}\n/;

// The native `lz4` dependency line (see note printed at runtime).
const LZ4_LINE_RE = /^[ \t]*"lz4"\s*:\s*"[^"]*",?[ \t]*\r?\n/m;

// The unpinned `lv_font_conv` GitHub dependency (drifts to a version whose LVGL
// font-source writer breaks font extraction — see note printed at runtime).
const LVFC_LINE_RE = /^([ \t]*"lv_font_conv"\s*:\s*)"[^"]*"(,?[ \t]*\r?\n)/m;
const LVFC_PIN = "1.5.2";

// ---------------------------------------------------------------------------
// Tiny logging helpers
// ---------------------------------------------------------------------------

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const skip = (msg) => console.log(`  – ${msg}`);
const note = (msg) => console.log(`  → ${msg}`);

function fail(msg) {
    console.error(`\nERROR: ${msg}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { studio: "./studio", revert: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            args.help = true;
        } else if (a === "--revert") {
            args.revert = true;
        } else if (a === "--studio") {
            const next = argv[i + 1];
            if (!next || next.startsWith("--")) {
                fail("--studio requires a path argument, e.g. --studio ./studio");
            }
            args.studio = next;
            i++;
        } else if (a.startsWith("--studio=")) {
            args.studio = a.slice("--studio=".length);
        } else {
            fail(`Unknown argument: ${a}\nRun with --help for usage.`);
        }
    }
    return args;
}

function printHelp() {
    log(`
apply-bridge.mjs — apply or revert the EEZ Studio MCP bridge

Usage:
  node scripts/apply-bridge.mjs [--studio <path>] [--revert]
  node scripts/apply-bridge.mjs --help

Options:
  --studio <path>   Path to your EEZ Studio source tree (default: ./studio)
  --revert          Undo the bridge changes instead of applying them
  --help, -h        Show this help

What "apply" does (idempotent):
  1. Copies bridge/src/*.ts  ->  <studio>/packages/${BRIDGE_PACKAGE_NAME}/
  2. Inserts  ${MAIN_IMPORT_LINE}
     into <studio>/packages/home/main.tsx (before "async function main() {").
  3. Inserts a startMcpBridge() call after the handleDragAndDrop(); line.
  4. Removes the native "lz4" dependency from <studio>/package.json if present
     (it fails to build on modern toolchains and is optional).

What "--revert" does:
  - Removes <studio>/packages/${BRIDGE_PACKAGE_NAME}/
  - Strips the injected import and startMcpBridge() block from main.tsx
  - Does NOT re-add lz4 (its removal is intentional).

Run this from the root of the EEZ Studio MCP Server repo, pointed at your own
clone of https://github.com/eez-open/studio.
`);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readText(file) {
    return fs.readFileSync(file, "utf8");
}

function writeText(file, content) {
    fs.writeFileSync(file, content, "utf8");
}

function rmDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function copyBridgeSources(studioDir) {
    log("Bridge sources -> packages/mcp-bridge/");

    if (!fs.existsSync(BRIDGE_SRC_DIR)) {
        fail(
            `Bridge sources not found at ${BRIDGE_SRC_DIR}\n` +
                `Expected bridge/src/*.ts to exist in this repo.`
        );
    }

    const entries = fs
        .readdirSync(BRIDGE_SRC_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => e.name);

    if (entries.length === 0) {
        fail(`No .ts files found in ${BRIDGE_SRC_DIR}`);
    }

    const destDir = path.join(studioDir, "packages", BRIDGE_PACKAGE_NAME);
    fs.mkdirSync(destDir, { recursive: true });

    for (const name of entries) {
        const src = path.join(BRIDGE_SRC_DIR, name);
        const dest = path.join(destDir, name);
        const nextContent = readText(src);
        if (fs.existsSync(dest) && readText(dest) === nextContent) {
            skip(`${name} (unchanged)`);
        } else {
            writeText(dest, nextContent);
            ok(`${name}`);
        }
    }
}

function patchMainImport(content) {
    if (content.includes("startMcpBridge")) {
        skip("import already present in main.tsx");
        return { content, changed: false };
    }

    const anchorIndex = content.indexOf(MAIN_FUNCTION_ANCHOR);
    if (anchorIndex === -1) {
        fail(
            `Could not find "${MAIN_FUNCTION_ANCHOR}" in main.tsx.\n` +
                `The EEZ Studio version may differ from the one this script targets.`
        );
    }

    const before = content.slice(0, anchorIndex);
    const after = content.slice(anchorIndex);
    ok("inserted import into main.tsx");
    return { content: `${before}${MAIN_IMPORT_LINE}\n\n${after}`, changed: true };
}

function patchMainStartBlock(content) {
    if (content.includes("startMcpBridge();")) {
        skip("startMcpBridge() block already present in main.tsx");
        return { content, changed: false };
    }

    const anchorIndex = content.indexOf(DRAG_ANCHOR_MATCH);
    if (anchorIndex === -1) {
        fail(
            `Could not find "${DRAG_ANCHOR_MATCH}" in main.tsx.\n` +
                `The EEZ Studio version may differ from the one this script targets.`
        );
    }

    // Insert the block at the end of the line that contains handleDragAndDrop();
    const lineEnd = content.indexOf("\n", anchorIndex);
    const insertAt = lineEnd === -1 ? content.length : lineEnd;

    const before = content.slice(0, insertAt);
    const after = content.slice(insertAt);
    ok("inserted startMcpBridge() block into main.tsx");
    return { content: `${before}${START_BRIDGE_BLOCK}${after}`, changed: true };
}

function patchMainTsx(studioDir) {
    log("Wiring packages/home/main.tsx");

    const mainPath = path.join(studioDir, "packages", "home", "main.tsx");
    if (!fs.existsSync(mainPath)) {
        fail(`main.tsx not found at ${mainPath}`);
    }

    let content = readText(mainPath);
    let changed = false;

    const imp = patchMainImport(content);
    content = imp.content;
    changed = changed || imp.changed;

    const block = patchMainStartBlock(content);
    content = block.content;
    changed = changed || block.changed;

    if (changed) {
        writeText(mainPath, content);
    } else {
        skip("main.tsx already fully patched");
    }
}

function removeLz4(studioDir) {
    log("Native lz4 dependency in package.json");

    const pkgPath = path.join(studioDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
        fail(`package.json not found at ${pkgPath}`);
    }

    const content = readText(pkgPath);
    if (!LZ4_LINE_RE.test(content)) {
        skip("lz4 not present (nothing to remove)");
        return;
    }

    const next = content.replace(LZ4_LINE_RE, "");
    writeText(pkgPath, next);
    ok("removed native \"lz4\" dependency from package.json");
    note(
        "lz4 is a native node-gyp addon that fails to build on modern Node/MSVC toolchains."
    );
    note(
        "It is optional: EEZ's real lz4 compression is a bundled WASM module; the npm"
    );
    note(
        "native lz4 is only used by LVGL-v9 image conversion behind a try/catch. Removing"
    );
    note("it lets `npm install` / `npm run build` succeed on Node 20/24.");
}

function pinLvFontConv(studioDir) {
    log("lv_font_conv dependency pin in package.json");

    const pkgPath = path.join(studioDir, "package.json");
    const content = readText(pkgPath);
    const m = content.match(LVFC_LINE_RE);
    if (!m) {
        skip("lv_font_conv line not found (leaving as-is)");
        return;
    }
    if (m[0].includes(`"${LVFC_PIN}"`)) {
        skip(`lv_font_conv already pinned to ${LVFC_PIN}`);
        return;
    }

    const next = content.replace(LVFC_LINE_RE, `$1"${LVFC_PIN}"$2`);
    writeText(pkgPath, next);
    ok(`pinned lv_font_conv to ${LVFC_PIN} in package.json`);
    note(
        "EEZ v0.28.0 declares lv_font_conv as an UNPINNED github branch; fresh installs"
    );
    note(
        "get >=1.5.3, whose LVGL font-source writer needs an `align` arg EEZ leaves"
    );
    note(
        'commented out -> Buffer.alloc(NaN) -> "Font ... extraction failed" and boxed'
    );
    note("glyphs. 1.5.2 matches the released binary and extracts fonts correctly.");
}

function apply(studioDir) {
    log(`\nApplying MCP bridge to: ${studioDir}\n`);
    copyBridgeSources(studioDir);
    patchMainTsx(studioDir);
    removeLz4(studioDir);
    pinLvFontConv(studioDir);
    log(`\nDone. Next steps (inside ${studioDir}):`);
    log("  npm install");
    log("  npm run build");
    log('  npm start -- "path/to/your.eez-project"');
    log("");
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

function revertBridgeSources(studioDir) {
    log("Removing packages/mcp-bridge/");
    const destDir = path.join(studioDir, "packages", BRIDGE_PACKAGE_NAME);
    if (fs.existsSync(destDir)) {
        rmDir(destDir);
        ok(`removed ${path.relative(studioDir, destDir)}`);
    } else {
        skip("packages/mcp-bridge/ not present");
    }
}

function revertMainTsx(studioDir) {
    log("Un-wiring packages/home/main.tsx");

    const mainPath = path.join(studioDir, "packages", "home", "main.tsx");
    if (!fs.existsSync(mainPath)) {
        skip("main.tsx not present (nothing to revert)");
        return;
    }

    let content = readText(mainPath);
    let changed = false;

    // Strip the startMcpBridge() block.
    if (START_BRIDGE_BLOCK_RE.test(content)) {
        content = content.replace(START_BRIDGE_BLOCK_RE, "\n");
        ok("removed startMcpBridge() block");
        changed = true;
    } else {
        skip("startMcpBridge() block not found");
    }

    // Strip the import line (and any trailing blank line it introduced).
    const importRe = new RegExp(
        `[ \\t]*${MAIN_IMPORT_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n(\\r?\\n)?`
    );
    if (importRe.test(content)) {
        content = content.replace(importRe, "");
        ok("removed import line");
        changed = true;
    } else {
        skip("import line not found");
    }

    if (changed) {
        writeText(mainPath, content);
    }
}

function revert(studioDir) {
    log(`\nReverting MCP bridge from: ${studioDir}\n`);
    revertBridgeSources(studioDir);
    revertMainTsx(studioDir);
    log("\nNote: lz4 removal is intentional and is NOT restored by --revert.");
    log("      Re-add it manually only if you know your toolchain can build it.");
    log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        printHelp();
        return;
    }

    const studioDir = path.resolve(process.cwd(), args.studio);

    if (!fs.existsSync(studioDir) || !fs.statSync(studioDir).isDirectory()) {
        fail(
            `Studio path not found or not a directory: ${studioDir}\n` +
                `Pass --studio <path> pointing at your clone of eez-open/studio.`
        );
    }

    const packagesDir = path.join(studioDir, "packages");
    if (!fs.existsSync(packagesDir)) {
        fail(
            `${studioDir} does not look like an EEZ Studio tree (no packages/ dir).\n` +
                `Did you clone https://github.com/eez-open/studio there?`
        );
    }

    if (args.revert) {
        revert(studioDir);
    } else {
        apply(studioDir);
    }
}

main();
