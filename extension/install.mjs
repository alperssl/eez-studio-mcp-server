#!/usr/bin/env node
// install.mjs — install the EEZ Studio MCP Bridge extension by dropping it into EEZ
// Studio's user-data `extensions/` folder. EEZ Studio loads it on next startup
// (require(folder).default + init()) — no app patching required.
//
//   node extension/install.mjs            # install into the default extensions dir
//   node extension/install.mjs --revert   # remove it
//   node extension/install.mjs --dir <extensionsFolder>   # custom extensions dir
//
// After installing, RESTART EEZ Studio (or open a project) — the bridge starts and an
// "MCP Bridge" panel appears on the Home tab.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { assembleInto, extensionsFolderPath, EXTENSION_ID } from "./_assemble.mjs";

function parseArgs(argv) {
    const a = { revert: false, dir: undefined };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--revert") a.revert = true;
        else if (argv[i] === "--dir") a.dir = argv[++i];
        else if (argv[i] === "--help" || argv[i] === "-h") a.help = true;
    }
    return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log(
        "install.mjs — drop-in install the MCP Bridge extension\n" +
            "  node extension/install.mjs [--revert] [--dir <extensionsFolder>]"
    );
    process.exit(0);
}

const extDir = args.dir || extensionsFolderPath();
const target = path.join(extDir, EXTENSION_ID);

if (args.revert) {
    if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`✓ removed ${target}`);
        console.log("  Restart EEZ Studio to unload the extension.");
    } else {
        console.log(`– nothing to remove at ${target}`);
    }
    process.exit(0);
}

fs.mkdirSync(extDir, { recursive: true });
const res = assembleInto(target);

console.log(`✓ installed EEZ Studio MCP Bridge extension`);
console.log(`  location : ${res.targetDir}`);
console.log(`  bridge   : ${res.bridgeModules} modules`);
console.log("");
console.log("Next: restart EEZ Studio (or open a .eez-project). The bridge starts");
console.log("automatically, and an 'MCP Bridge' panel appears on the Home tab.");
console.log("Disable at startup with EEZ_MCP_BRIDGE=0; revert with --revert.");
