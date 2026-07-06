# EEZ Studio MCP Bridge

The **bridge** is a small WebSocket server that runs *inside* the EEZ Studio
renderer (Electron, `nodeIntegration: true`). It exposes the live `ProjectStore`
— the same in-memory model the GUI edits — to the standalone
[`eez-studio-mcp`](../mcp-server/README.md) server over a token-protected
`127.0.0.1` socket. Edits go through EEZ Studio's own undo/command API, and
page/widget renders come straight from EEZ's LVGL-WASM preview, so what an agent
sees is pixel-identical to what a human sees.

The bridge is delivered as the **EEZ Studio extension** in [`../extension/`](../extension/)
— a drop-in `.pext` that bundles the prebuilt bridge and autostarts it inside the
renderer, with no app patching and no rebuild of EEZ Studio itself. For installation
and runtime usage, see [`../extension/README.md`](../extension/README.md).

**This document** covers the bridge's internals — what each source file does, how
discovery & auth work, the environment variables — and how maintainers **rebuild the
bundled `bridge/dist` payload from `bridge/src`**.

The wire protocol the bridge speaks is documented in
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md).

---

## What lives here

```
bridge/
  src/              # the bridge TypeScript sources (GPL-3 source of truth):
    protocol.ts             # message framing, error codes, handshake-file schema
    project-access.ts       # objID -> object resolution, ProjectStore access helpers
    serialize.ts            # object-model -> JSON (WidgetNode / WidgetDetail shapes)
    render.ts               # LVGL-WASM preview capture -> PNG base64
    console-capture.ts      # ring-buffer of renderer console (runtime diagnostics)
    notification-capture.ts # ring-buffer of EEZ toast notifications (e.g. font-extraction errors)
    handlers.ts             # one function per protocol method (inspect/edit/render/diagnostics/...)
    bridge.ts               # the WS server + config, start/stop control, and captures
    index.ts                # startMcpBridge() entry point (invoked by the extension)
  dist/             # prebuilt JS of the above — bundled into the extension in ../extension/
  README.md         # this file
```

`bridge/src` is the GPL-3 source of truth; `bridge/dist` is the prebuilt payload the
extension ships. Both live in this repo. See
[Rebuild the bridge payload](#rebuild-the-bridge-payload-maintainers) below for how the
`dist` JS is regenerated from `src`.

---

## Rebuild the bridge payload (maintainers)

Users never do this — they just install the extension from [`../extension/`](../extension/).
This section is only for maintainers who changed `bridge/src` and need to regenerate the
prebuilt `bridge/dist` JS that the extension bundles.

The bridge is compiled *against an EEZ Studio checkout* so it resolves the same
internal modules it links to at runtime. This repo targets EEZ Studio **v0.28.0**.

### Prerequisites

- **Node.js 18+** (Node **20 / 24** are fine). Building the studio checkout needs a
  C/C++ toolchain for `node-gyp` — Python 3 plus the platform compiler (Visual Studio
  C++ Build Tools on Windows, Xcode Command Line Tools on macOS, `build-essential` on
  Linux). The native `lz4` addon fails to compile on modern Node/MSVC and is not
  required by the bridge; drop it from the studio checkout's `package.json` if the
  install fails on it (the lz4 compression EEZ Studio actually uses is a bundled WASM
  module). Keep the checkout's `package-lock.json` so transitive versions the code
  needs (notably `@types/plotly.js` 2.x) stay pinned.

### Steps

1. **Get an EEZ Studio v0.28.0 checkout** and install/build it once so its packages
   resolve:

   ```bash
   git clone https://github.com/eez-open/studio
   git -C studio checkout v0.28.0
   ```

2. **Copy the bridge sources** into the checkout as an internal package:

   ```bash
   cp bridge/src/*.ts <studio>/packages/mcp-bridge/
   ```

3. **Run the studio TypeScript build** so `mcp-bridge/*.ts` compiles against EEZ
   Studio's own modules.

4. **Copy the compiled JS back** from the studio build output into this repo's
   `bridge/dist`:

   ```bash
   cp <studio>/build/mcp-bridge/*.js bridge/dist/
   ```

5. Rebuild the extension so it picks up the fresh payload — see
   [`../extension/README.md`](../extension/README.md) (`node ../extension/pack.mjs`).

Replace `<studio>` with your EEZ Studio checkout directory.

---

## How discovery & auth work

On startup the bridge:

1. Reads its config (`<userData>/eez-mcp-bridge-config.json`, env overrides). If `enabled`
   is false (or `EEZ_MCP_BRIDGE=0`), it does not start. Otherwise it picks a **port**:
   `EEZ_MCP_BRIDGE_PORT`, else the config `port`, else the default `38017`.
2. Picks a **token**: `EEZ_MCP_BRIDGE_TOKEN` or a random 32-hex-char token.
3. Binds a WebSocket server to **`127.0.0.1:<port>` only** (never `0.0.0.0`).
4. Writes a **handshake file** so the MCP server can auto-discover it:

   - Path: `path.join(os.tmpdir(), "eez-studio-mcp-bridge.json")`
   - Contents:
     ```json
     {
       "port": 38017,
       "token": "…",
       "pid": 12345,
       "protocolVersion": 1,
       "startedAt": "2026-01-01T00:00:00.000Z",
       "eezStudioVersion": "0.28.0"
     }
     ```
   - The file is **deleted on clean shutdown / renderer teardown**.

The MCP server reads that file and connects to
`ws://127.0.0.1:<port>?token=<token>`. The bridge **rejects the upgrade with
HTTP 401** if the token is missing or wrong. If the handshake file is absent,
the MCP server reports that EEZ Studio (with the bridge) is not running.

> **Why the token matters.** The renderer has full Node access, so an open,
> unauthenticated port would be RCE-adjacent. The localhost-only bind plus a
> shared per-session token is mandatory, not optional.

### Environment variables

| Variable | Effect |
|----------|--------|
| `EEZ_MCP_BRIDGE_PORT`  | Bind the bridge to a fixed port instead of `38017`. |
| `EEZ_MCP_BRIDGE_TOKEN` | Use a fixed token instead of a random one. |
| `EEZ_MCP_BRIDGE=0`     | **Disable the bridge entirely** — EEZ Studio runs unmodified. |

Set the port/token only if you need a stable pair (e.g. a fixed MCP client
config). Otherwise leave them unset and rely on the handshake file.

### Runtime control (start / stop / port)

The extension injects a floating **"MCP Bridge" panel** into the bottom-right corner
of the EEZ Studio window — a status pill that expands to Start / Stop / Restart, port,
token, and live status. You can also control it via:

- the **config file** `<userData>/eez-mcp-bridge-config.json` = `{ "enabled": bool, "port": number }`
  (`%APPDATA%/eezstudio/…` on Windows) — edit and restart;
- the **console global** `window.eezMcpBridge` in DevTools: `.start()`, `.stop()`, `.restart()`,
  `.status()`, `.setPort(n)`.

The panel, config file, and console global all read and write the same state, so any one
of them is enough to manage the bridge.

---

## Dev iteration

The bridge is renderer-scoped: it tears down and re-listens across renderer
reloads and guards against `EADDRINUSE`. That makes the edit loop fast when you are
iterating inside a studio checkout (see [Rebuild the bridge
payload](#rebuild-the-bridge-payload-maintainers)):

1. In the `<studio>/packages/mcp-bridge/` sources, run the studio TypeScript compiler
   in watch mode so edits recompile automatically.
2. Edit the bridge sources. When they recompile, **reload the renderer** with
   **Ctrl+R** (Cmd+R on macOS) in the running EEZ Studio window. The old bridge
   socket is torn down and a fresh one comes up with a new handshake file.

Once you are happy with the changes, copy the recompiled JS back into this repo's
`bridge/dist` and rebuild the extension, as described in the rebuild section above.

---

## Licensing

⚠️ **The bridge is GPL-3.** It is compiled and linked into EEZ Studio and calls
EEZ Studio internals directly, so it is a **derivative work of EEZ Studio**,
which is **GPL-3.0**. Any distribution of the bridge (its `bridge/src` source and
the `bridge/dist` payload the extension bundles) must comply with GPL-3.

This is **separate** from the standalone [`mcp-server`](../mcp-server/README.md),
which talks to the bridge only over the documented WebSocket protocol and is
**MIT-licensed**. The protocol boundary is deliberate: it keeps the reusable MCP
server free of the GPL obligation that the in-renderer bridge carries.

See the repo-root [README](../README.md#licensing) for the full picture.
