#!/usr/bin/env node
// pack.mjs — assemble the extension and zip it for distribution / the EEZ Studio
// Extensions Manager. Produces extension/dist/<id>/ and extension/dist/<id>-<version>.zip.
//
//   node extension/pack.mjs
//
// Install the resulting folder either by copying it into the user-data extensions dir
// (see install.mjs) or via EEZ Studio → Extensions Manager (install from the .zip).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assembleInto, EXT_DIR, EXTENSION_ID } from "./_assemble.mjs";

const distDir = path.join(EXT_DIR, "dist");
const staged = path.join(distDir, EXTENSION_ID);

const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "package.json"), "utf8"));
const zipName = `${EXTENSION_ID}-${pkg.version}.zip`;
const zipPath = path.join(distDir, zipName);

fs.mkdirSync(distDir, { recursive: true });
const res = assembleInto(staged);
console.log(`✓ staged ${res.bridgeModules} bridge modules -> ${staged}`);

fs.rmSync(zipPath, { force: true });
try {
    if (process.platform === "win32") {
        // PowerShell Compress-Archive (built in). Zip the staged folder's contents.
        execFileSync(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                `Compress-Archive -Path '${staged}\\*' -DestinationPath '${zipPath}' -Force`
            ],
            { stdio: "inherit" }
        );
    } else {
        // `zip -r <zip> .` from inside the staged folder (contents at the zip root).
        execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: staged, stdio: "inherit" });
    }
    console.log(`✓ packed -> ${zipPath}`);
} catch (e) {
    console.log(`– could not create the .zip automatically (${e.message}).`);
    console.log(`  The staged folder is ready at: ${staged}`);
    console.log(`  Zip it yourself, or use install.mjs for a drop-in install.`);
}
