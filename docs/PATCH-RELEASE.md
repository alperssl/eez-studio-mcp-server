# Patching the official release binary (exact-parity install)

`scripts/patch-release.mjs` injects the MCP bridge into an **official EEZ Studio 0.28.0
release install**, so the result is the release binary *itself* plus the bridge — **zero
dependency/toolchain/font divergence** from what the vendor ships. This is the strongest
parity option; use it when the agent's preview must exactly equal your installed EEZ Studio.

Contrast with the from-source fork (`bridge/README.md`): that rebuilds EEZ from source and is
render-faithful, but not byte-identical to the release (unpinned deps drift — see
`docs/PROTOCOL.md` discussion and the `lv_font_conv` case). The patcher avoids all of that.

## How it works (directory mode)

Electron runs `resources/app.asar` if present, else `resources/app/`. The patcher:
1. Extracts `resources/app.asar` → `resources/app/` (via `npx @electron/asar`).
2. Overlays `app.asar.unpacked/*` (native modules: better-sqlite3, serialport, …) into `app/`.
3. Copies the prebuilt bridge (`bridge/dist/*.js`) into `app/build/mcp-bridge/`.
4. Appends `require("mcp-bridge").startMcpBridge()` to `app/build/home/main.js`.
5. Renames `app.asar` → `app.asar.mcp-orig` so Electron runs the patched `app/` directory.

The release's own code and dependencies are otherwise untouched (`app.asar` is only *extracted*,
not modified), so font extraction, rendering, loading, and codegen behave exactly like the release.

## Usage

```bash
# Patch a COPY (recommended — your real install stays untouched):
node scripts/patch-release.mjs --app "<EEZ Studio install dir>" --out "<somewhere>/eez-patched"
# then launch the patched app, e.g. Windows:
"<somewhere>/eez-patched/EEZ Studio.exe" "path/to/your.eez-project"

# Or patch an install in place (reversible):
node scripts/patch-release.mjs --app "<EEZ Studio install dir>"
node scripts/patch-release.mjs --app "<EEZ Studio install dir>" --revert
```

Typical install dirs: Windows `%LOCALAPPDATA%\Programs\eezstudio`; macOS `/Applications/EEZ Studio.app`.

Requires Node 18+ and `npx @electron/asar` (fetched/cached on first run).

## Bridge control in a patched install

The patched binary starts the bridge automatically when a project is open (bound to `127.0.0.1`,
handshake at `os.tmpdir()/eez-studio-mcp-bridge.json`). The in-app **"MCP Bridge" menu** is a
from-source-fork feature (it lives in the main-process menu, which the binary patch does not modify);
in a patched install, control the bridge via:
- the config file `%APPDATA%/eezstudio/eez-mcp-bridge-config.json` = `{ enabled, port }` (env
  `EEZ_MCP_BRIDGE`/`EEZ_MCP_BRIDGE_PORT` override), then restart the app; or
- the renderer console global `window.eezMcpBridge` (`.start()`, `.stop()`, `.restart()`,
  `.status()`, `.setPort(n)`), available in DevTools.

Register the MCP server with your agent per `docs/REGISTER.md` — that part is identical for both
the from-source fork and the patched release.

## Keeping `bridge/dist` current

`bridge/dist/*.js` are the compiled bridge modules the patcher injects. They are produced by the
from-source build (`studio/build/mcp-bridge/*.js` after `tsc`). Regenerate them whenever
`bridge/src/*.ts` changes.
