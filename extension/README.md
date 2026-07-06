# EEZ Studio MCP Bridge — extension (no-patch install)

This packages the bridge as an **EEZ Studio project extension** (`pext`) — the way to add
the MCP bridge to an **official EEZ Studio release without patching it**. It installs like
any other extension, requires no modification to the app, and survives app updates.

It ships the prebuilt bridge (`bridge/dist`) and its full **203 tools**.

> **Tip:** to install the extension *and* register the MCP server *and* copy the agent/skill
> in one step, run the repo's [`install.cmd`](../install.cmd) / [`install.sh`](../install.sh)
> (see the root [README](../README.md#easy-install-one-step)). This doc covers the extension on its own.

## How it works

EEZ Studio auto-loads every folder in its user-data `extensions/` directory at startup:
it does `require(folder).default` and calls the extension's `init()`. And because EEZ
registers `build/` as a global Node module root (`app-module-path`, in
`packages/main/fix-path.ts`), code running in the renderer can
`require("project-editor/store")` / `require("home/tabs-store")` and reach the **same live
singletons** the editor uses. That is exactly what the bridge needs — so `init()` simply
starts the bridge, with **no modification to EEZ Studio**.

The extension also injects a floating **"MCP Bridge" panel** into the bottom-right corner of
the EEZ Studio window — a compact status pill that expands to start/stop/restart, port, auth
token, config-file link, and live status. (It renders itself into the renderer DOM because EEZ
Studio 0.28.0 ships the extension "home section" UI slot disabled.)

## Prerequisites

Build the bridge once so `bridge/dist/*.js` exists (see [`bridge/README.md`](../bridge/README.md)).
Requires an installed EEZ Studio **0.28.x**.

## Install (drop-in)

```bash
node extension/install.mjs           # copies into the user-data extensions/ folder
node extension/install.mjs --revert  # remove it
```

Then **restart EEZ Studio** (or open a `.eez-project`). The bridge starts automatically and
the floating **MCP Bridge** panel appears in the bottom-right corner. Register the MCP server as usual
(see [`docs/REGISTER.md`](../docs/REGISTER.md)).

The extensions folder is OS-specific:

| OS | Path |
|----|------|
| Windows | `%APPDATA%\eezstudio\extensions\` |
| macOS | `~/Library/Application Support/eezstudio/extensions/` |
| Linux | `~/.config/eezstudio/extensions/` |

## Install (via the Extensions Manager)

```bash
node extension/pack.mjs   # -> extension/dist/eez-studio-mcp-bridge-<version>.zip
```

Install that `.zip` from **EEZ Studio → Extensions Manager**.

## Controls

- **Floating MCP Bridge panel** (bottom-right corner) — start/stop/restart, set the port, copy the token. Click the pill to expand; click the **−** button or anywhere outside the panel to collapse it.
- **Console:** `window.eezMcpBridge.{start,stop,restart,status,setPort}()`.
- **Config file:** `%APPDATA%/eezstudio/eez-mcp-bridge-config.json` (port + enabled).
- **Env:** `EEZ_MCP_BRIDGE=0` disables autostart; `EEZ_MCP_BRIDGE_PORT` overrides the port.

The extension requires no modification to EEZ Studio and survives app updates.

Licensed **GPL-3.0-only** — the bridge loads EEZ Studio's GPL modules at runtime.
