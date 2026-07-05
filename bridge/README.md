# EEZ Studio MCP Bridge

The **bridge** is a small WebSocket server that runs *inside* the EEZ Studio
renderer (Electron, `nodeIntegration: true`). It exposes the live `ProjectStore`
— the same in-memory model the GUI edits — to the standalone
[`eez-studio-mcp`](../mcp-server/README.md) server over a token-protected
`127.0.0.1` socket. Edits go through EEZ Studio's own undo/command API, and
page/widget renders come straight from EEZ's LVGL-WASM preview, so what an agent
sees is pixel-identical to what a human sees.

Because EEZ Studio does not ship the bridge, you add it yourself. Two ways:

- **Recommended — patch the official release binary** for exact parity with the
  vendor (fonts/rendering match precisely, no dependency drift). See
  [`../docs/PATCH-RELEASE.md`](../docs/PATCH-RELEASE.md).
- **From source (this document)** — clone EEZ Studio, apply the bridge sources
  with a script from this repo, then build and run. Render-faithful and best for
  developing the bridge itself, but not byte-identical to the release.

The wire protocol the bridge speaks is documented in
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md).

---

## What lives here

```
bridge/
  src/              # the bridge TypeScript sources copied into the fork:
    protocol.ts             # message framing, error codes, handshake-file schema
    project-access.ts       # objID -> object resolution, ProjectStore access helpers
    serialize.ts            # object-model -> JSON (WidgetNode / WidgetDetail shapes)
    render.ts               # LVGL-WASM preview capture -> PNG base64
    console-capture.ts      # ring-buffer of renderer console (runtime diagnostics)
    notification-capture.ts # ring-buffer of EEZ toast notifications (e.g. font-extraction errors)
    handlers.ts             # one function per protocol method (inspect/edit/render/diagnostics/...)
    bridge.ts               # the WS server + config, start/stop control, and captures
    index.ts                # startMcpBridge() entry point wired into main.tsx
  dist/             # prebuilt JS of the above — injected by the release patcher (patch-release.mjs)
  README.md         # this file
```

The apply script lives one level up, at
[`../scripts/apply-bridge.mjs`](../scripts/apply-bridge.mjs).

---

## Prerequisites

- **Node.js 18+.** EEZ Studio's own CI pins Node 16, but Node **20 / 24** build
  fine *after* the `lz4` removal that the apply script performs (see below).
- **Git.**
- **A C/C++ toolchain for `node-gyp`** — EEZ Studio has native dependencies:
  - **Windows:** Python 3 and the **Visual Studio C++ Build Tools** (the
    "Desktop development with C++" workload). Install from the Visual Studio
    Installer or via `npm install -g windows-build-tools` on older setups.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential`, `python3`, and the usual `node-gyp`
    system packages.

> **Why the toolchain still matters after removing `lz4`:** `lz4` is not the only
> native module in EEZ Studio, but it is the one that reliably fails to compile on
> modern Node/MSVC. Removing it (done automatically) is usually the difference
> between a green and a red `npm install`.

---

## Build the forked EEZ Studio with the bridge

Run these from the **root of this repo** unless noted otherwise.

### 1. Clone EEZ Studio

```bash
git clone https://github.com/eez-open/studio
```

This repo targets EEZ Studio **v0.28.0**. A newer tag will usually still work,
but if the apply script cannot find its anchor lines in `packages/home/main.tsx`
it will stop with a clear error — in that case check out `v0.28.0`:

```bash
git -C studio checkout v0.28.0
```

### 2. Apply the bridge

```bash
node scripts/apply-bridge.mjs --studio ./studio
```

This is idempotent (safe to re-run) and:

1. Copies `bridge/src/*.ts` into `studio/packages/mcp-bridge/`.
2. Wires `startMcpBridge()` into `studio/packages/home/main.tsx`:
   - adds `import { startMcpBridge } from "mcp-bridge";`
   - starts the bridge (in a `try/catch`, non-fatal) right after the app mounts.
3. Removes the native **`lz4`** dependency from `studio/package.json`.
4. Pins **`lv_font_conv`** to `1.5.2` in `studio/package.json`.

> **Keep `package-lock.json`.** Do **not** delete it before `npm install` — the lockfile
> pins transitive versions (notably `@types/plotly.js` 2.x) the code needs; a fresh,
> lockfile-less resolve pulls newer versions that break the `tsc` build.

> **About the two dependency fixes.**
> - **`lz4`** — a native node-gyp addon that fails to build on modern Node/MSVC. It is
>   optional: the lz4 compression EEZ Studio actually uses is a bundled **WASM** module;
>   the native npm `lz4` is only referenced by LVGL-v9 image conversion behind a `try/catch`.
> - **`lv_font_conv`** — EEZ declares it as an *unpinned* GitHub branch, so a fresh install
>   pulls a newer commit whose LVGL font-source writer needs an `align` arg EEZ leaves
>   commented out → `Buffer.alloc(NaN)` → `Font "…" extraction failed` and boxed glyphs.
>   Pinning `1.5.2` matches the released binary and extracts fonts correctly. (For *byte-exact*
>   release parity, use the release patcher instead — [`../docs/PATCH-RELEASE.md`](../docs/PATCH-RELEASE.md).)

To undo the source changes (the `lz4` removal and `lv_font_conv` pin are intentional and kept):

```bash
node scripts/apply-bridge.mjs --studio ./studio --revert
```

### 3. Install, build, and run

```bash
cd studio
npm install
npm run build
npm start -- "path/to/your.eez-project"
```

`npm start` launches the Electron app. Pass the path to a `.eez-project` on the
command line (or open one from the UI). **The bridge starts automatically as
soon as a project is open** — there is nothing else to launch.

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

The from-source fork adds an **"MCP Bridge" menu** in the menu bar
(Start / Stop / Restart / Show Status / Edit Settings). Without the menu, control it via:

- the **config file** `<userData>/eez-mcp-bridge-config.json` = `{ "enabled": bool, "port": number }`
  (`%APPDATA%/eezstudio/…` on Windows) — edit and restart, or use the menu's "Edit Settings";
- the **console global** `window.eezMcpBridge` in DevTools: `.start()`, `.stop()`, `.restart()`,
  `.status()`, `.setPort(n)`.

A patched **release** install (see [`../docs/PATCH-RELEASE.md`](../docs/PATCH-RELEASE.md)) has the
same config file + console global, but **not** the menu (its main-process menu is not patched).

---

## Dev iteration

The bridge is renderer-scoped: it tears down and re-listens across renderer
reloads and guards against `EADDRINUSE`. That makes the edit loop fast:

1. In the `studio/` checkout, run the TypeScript compiler in watch mode:
   ```bash
   npx tsc -w
   ```
2. Edit the bridge sources. When they recompile, **reload the renderer** with
   **Ctrl+R** (Cmd+R on macOS) in the running EEZ Studio window. The old bridge
   socket is torn down and a fresh one comes up with a new handshake file.

If you are iterating on the *source of truth* in this repo's `bridge/src/`, re-run
`node scripts/apply-bridge.mjs --studio ./studio` to copy your changes into the
fork (it only rewrites files that actually changed), then reload.

---

## Licensing

⚠️ **The bridge is GPL-3.** It is compiled and linked into EEZ Studio and calls
EEZ Studio internals directly, so it is a **derivative work of EEZ Studio**,
which is **GPL-3.0**. Any distribution of the forked, bridge-enabled EEZ Studio
must comply with GPL-3.

This is **separate** from the standalone [`mcp-server`](../mcp-server/README.md),
which talks to the bridge only over the documented WebSocket protocol and is
**MIT-licensed**. The protocol boundary is deliberate: it keeps the reusable MCP
server free of the GPL obligation that the in-renderer bridge carries.

See the repo-root [README](../README.md#licensing) for the full picture.
