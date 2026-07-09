# eez-studio-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent inspect, author, render, and run the **currently-open `.eez-project`** in a running EEZ Studio, live — the full editor surface (pages, widgets, styles, assets, variables, i18n, the visual flow graph, and the LVGL-WASM simulator) across **flow and no-flow** LVGL projects.

It is a small standalone Node process that connects to a WebSocket **bridge** hosted inside EEZ Studio (Electron) by the **MCP Bridge extension**, and exposes the bridge protocol as MCP tools over **stdio**. Edits go through EEZ Studio's own `ProjectStore`, so the GUI, undo/redo, validation, and code generation stay consistent — each tool call is one undo step.

```
agent/client  ⇄ (stdio, MCP)  ⇄  eez-studio-mcp  ⇄ (localhost WebSocket)  ⇄  EEZ Studio bridge  ⇄  ProjectStore + LVGL-WASM preview
```

> **Requires EEZ Studio with the MCP Bridge extension** installed and a project open (see the repo [`../README.md`](../README.md) and [`../extension/README.md`](../extension/README.md)). This server discovers the bridge automatically; if it is not running, every tool returns a clear "launch it first" error.

## What you can do

The server exposes **208 tools** spanning the full EEZ Studio surface — for **both flow and no-flow LVGL projects** (LVGL **8.4.0 – 9.5.0**, EEZ project schema **v3**). Project mode is read from `settings.general.flowSupport` (`get_project_info` / `get_settings`). [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) is the authoritative, method-by-method contract; the groups below are a map, not the full list.

- **Inspect**: project info/settings, page list, nested widget trees, full widget detail, current selection, widget classes.
- **Edit** (undoable): create/update/delete widgets, duplicate/move/align, set/clear local styles, flags/states/layout/scroll/grid-cell, bind/unbind events, set identifiers, and widget sub-items (button-matrix buttons, meter indicators/scales, scale sections, spangroup spans).
- **Assets** (read **and** write, undoable): fonts (import/edit/ranges/symbols/fallback/glyphs), bitmaps (import/export/options), named styles, actions, and theme colors.
- **Model**: variables, enums, structures, user-widgets, LVGL focus groups, and project themes.
- **i18n / Texts**: languages, translation resources, per-cell translations, widget bindings, and CSV/JSON/XLIFF import/export (enable via the `texts` feature).
- **Project-wide**: search/replace, find-references, clipboard (copy/cut/paste through the OS clipboard), the scrapbook, editor-tab/navigation control, features/imports/build-configs, and project lifecycle (open/save/reload). `replace_in_project` returns `{ replacedCount, skipped?, note? }` — EEZ's replace covers identifiers/references, not free text such as build-file templates, so hits it cannot write are reported in `skipped` with a `note` pointing to `set_build_file_template` / `patch_build_file_template` (rather than a silent `replacedCount: 0`).
- **Flow authoring** (undoable): place/edit/remove flow components, wire them with connection lines, add custom ports, bind flow-type events, manage per-flow local variables and public IO, and set expression-bound reactive widget flags/states. On LVGL/firmware this is meaningful when `flowSupport` is on (flip it via `update_settings`; a Dashboard project is not required).
- **Render** (pixel-exact): render a page or a single widget to PNG straight from EEZ Studio's LVGL-WASM preview — what you get is what the user sees. (`render_flow` returns the flow graph as data, not a PNG — the flow editor is SVG, not a framebuffer.)
- **Simulator / Run mode**: start/stop the LVGL-WASM simulator (F5), screenshot the live frame, and query status; flow-debugger pause/resume/step on flow projects. Plus code generation / build (`build`, `build_assets`) and the Docker full simulator / dashboard-export / IEXT-extension builds.
- **Build files** (per-file codegen templates the build expands into generated source such as `ui.c`/`screens.c`): `list_build_files` (read — `{ files: [{ index, fileName, objID, templateLength }] }`), `get_build_file` (read one full template by `fileName`/`index`/`objID`), `set_build_file_template` (write, one undo step — replace a template in full), and `patch_build_file_template` (write, one undo step — literal, case-sensitive `find`/`replacement` inside one template, with optional `matchCase`/`expectedCount` guards; 0 matches makes no change). These are the correct place to customize **generated** code (e.g. the global screen-load animation `lv_scr_load_anim(..., LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false)`) — editing the generated file directly is lost on the next rebuild.
- **Instrument & dashboard**: SCPI, instrument commands, MicroPython, shortcuts, and extension definitions (feature-gated).
- **Navigate**: select a widget or open a page in the GUI; undo/redo; save.
- **Diagnostics**: run EEZ's project checks, read current problems (checks + last build), and read the renderer console and EEZ toast notifications — surfacing runtime issues the static checks miss (e.g. `Font "…" extraction failed`, glyphs outside a font's range).

### Identity & value formats (for agents)

- **Widgets** are addressed by their stable `objID` (every inspect result includes it).
- **Pages** are addressed by their unique `name`.
- **Values** use the object-model string form: colors `#rrggbb` (or a theme color name), opacity as an int `0–255`, enums **bare** (no `LV_` prefix), fonts/bitmaps by name. Never pass `LV_*` constants or BGR ints.
- `part` / `state` are bare LVGL selectors, e.g. `"MAIN"`, `"PRESSED"`, `"CHECKED|PRESSED"`.

## Install & build

Requires **Node.js >= 18**.

```bash
npm install
npm run build      # tsc -> dist/
```

Scripts:

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run dev`   | `tsc -w` — rebuild on change. |
| `npm start`     | Run the built server (`node dist/index.js`). |
| `npm run smoke` | Raw-WebSocket smoke test against a live bridge (no MCP client needed). |

## Register with an MCP client

The server runs over stdio and is exposed as the `eez-studio-mcp` bin.

### Claude Code / Claude Desktop CLI

After a global install (`npm install -g eez-studio-mcp`) or `npm link`:

```bash
claude mcp add eez-studio -- eez-studio-mcp
```

Or run it straight from the built output without a global install:

```bash
claude mcp add eez-studio -- node /absolute/path/to/mcp-server/dist/index.js
```

### Generic JSON config

Most MCP clients accept a server entry like this:

```jsonc
{
  "mcpServers": {
    "eez-studio": {
      "command": "eez-studio-mcp",
      "args": [],
      "env": {
        // optional — only if you run the bridge with custom settings
        // "EEZ_MCP_BRIDGE_PORT": "38017",
        // "EEZ_MCP_BRIDGE_TOKEN": "your-token"
      }
    }
  }
}
```

If you did not install the bin globally, use `"command": "node"` and
`"args": ["/absolute/path/to/mcp-server/dist/index.js"]`.

## Discovery & environment variables

On startup the bridge writes a handshake file to your OS temp dir
(`<tmpdir>/eez-studio-mcp-bridge.json`) containing the port and a per-session auth token. This server reads it automatically and connects to `ws://127.0.0.1:<port>?token=<token>` — no configuration needed in the common case. If the bridge restarts with new credentials, the server re-reads the file and reconnects on the next call.

| Variable | Effect |
|----------|--------|
| `EEZ_MCP_BRIDGE_PORT`  | Override the bridge port (skips the port from the handshake file). |
| `EEZ_MCP_BRIDGE_TOKEN` | Override the auth token (skips the token from the handshake file). |

Set both only if you launch the bridge with a fixed port/token; otherwise leave them unset and rely on auto-discovery.

## Smoke test (no MCP client required)

With EEZ Studio and its bridge running:

```bash
npm run smoke
# or, also render a page to smoke-render.png:
node scripts/smoke.mjs --render <pageName>
```

It reads the handshake file, connects, and calls `ping`, `get_project_info`, and `list_pages`, printing the results. If the handshake file is missing it prints clear guidance to launch EEZ Studio first.

## Security

The bridge binds to `127.0.0.1` only and requires a shared token, because the EEZ Studio renderer runs with full Node access. This server never logs to stdout (that channel is reserved for MCP stdio); all diagnostics go to stderr.

## License

MIT
