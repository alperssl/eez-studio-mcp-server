# EEZ Studio MCP Server

Let an AI agent and a human co-design the **same** open `.eez-project` **live**,
inside [EEZ Studio](https://github.com/eez-open/studio). The agent inspects,
edits, renders, runs, and builds the project through EEZ Studio's own object
model, undo/command API, LVGL-WASM preview/simulator, and code generator — so
every edit is a real, undoable EEZ Studio operation and every render is
**pixel-exact by construction** (it *is* the preview the user sees, not a
re-implementation). The bridge covers the full EEZ Studio surface for **LVGL**
projects — **flow and no-flow alike** (LVGL 8.4.x through 9.5.x) — including
pages/widgets, styles, assets (fonts/bitmaps/colors), variables/enums/structures,
i18n texts, project-wide search, the visual flow graph, and the simulator. The
human keeps editing in the GUI the whole time; the agent's changes and the
human's changes share one model, one undo stack, and one source of truth.

This repo packages two pieces that talk over a small, documented protocol:

- an **MCP server** (MIT) that exposes the project to any MCP client over stdio;
- a **bridge** (GPL-3, because it derives from EEZ Studio) that runs inside the
  EEZ Studio renderer and hosts a token-protected localhost WebSocket.

---

## Architecture

```
  ┌─────────┐   stdio (MCP)   ┌────────────────┐   localhost WS + token   ┌──────────────────────────┐
  │  agent  │ ⇄────────────── │ eez-studio-mcp │ ⇄─────────────────────── │ EEZ Studio renderer      │
  │ (client)│                 │  (Node, MIT)   │                          │ bridge (GPL-3)           │
  └─────────┘                 └────────────────┘                          │   │                      │
                                                                          │   ├─ ProjectStore        │
                                                                          │   │   (live object model,│
                                                                          │   │    undo/command API) │
                                                                          │   └─ LVGL-WASM preview    │
                                                                          │       (pixel-exact PNG)  │
                                                                          └──────────────────────────┘
```

- The **agent** speaks MCP over stdio to `eez-studio-mcp`.
- `eez-studio-mcp` is a standalone Node process. It auto-discovers the bridge via
  a handshake file in the OS temp dir and connects to `ws://127.0.0.1:<port>?token=<token>`.
- The **bridge** lives inside the EEZ Studio renderer (which has `nodeIntegration`),
  mutates the live `ProjectStore` only through EEZ's `updateObject/addObject/deleteObject`
  (+ undo grouping), and captures the LVGL-WASM preview canvas as PNG.

The full wire protocol is in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## Repo layout

```
.
├── mcp-server/        # standalone MCP server (stdio) — MIT. Publishable as `eez-studio-mcp`.
├── bridge/            # the bridge — GPL-3 (derives from EEZ Studio)
│   ├── src/           #   bridge TypeScript modules (applied into an EEZ Studio source tree)
│   ├── dist/          #   prebuilt bridge JS injected into a patched release binary
│   └── README.md      #   how to build the from-source fork with the bridge
├── scripts/
│   ├── apply-bridge.mjs    # apply/revert the bridge in an EEZ Studio source clone (dev path)
│   └── patch-release.mjs   # inject the bridge into an official release install (exact-parity path)
├── docs/
│   ├── PROTOCOL.md         # authoritative bridge WebSocket protocol (v1)
│   ├── PATCH-RELEASE.md    # inject the bridge into the official release binary (recommended)
│   ├── REGISTER.md         # register the MCP server with an agent client
│   └── eez-studio-usage.md # how EEZ Studio works (agent-facing guide)
├── .claude/           # Claude Code assets shipped with the repo
│   ├── agents/eez-editor.md              # the eez-editor agent (MCP-first, raw-JSON fallback)
│   └── skills/eez-project-editor/        # exact .eez-project format + live-MCP workflow
├── .mcp.json.example  # sample MCP client registration (copy to .mcp.json)
└── studio/            # OPTIONAL local clone of EEZ Studio for dev/testing.
                       # Un-vendored and gitignored — you bring your own via `git clone`.
```

> `studio/` is **not** part of the published repo. It is a heavy local clone of
> EEZ Studio that you create yourself; the bridge is applied into it with
> `scripts/apply-bridge.mjs`. See [`bridge/README.md`](bridge/README.md).

---

## Quickstart

### 1. Get EEZ Studio with the bridge — pick one path

**Recommended — patch the official release (exact parity).** Injects the bridge
into an installed EEZ Studio **0.28.0**, so the app *is* the official binary plus
the bridge: zero dependency drift, and fonts/rendering match the vendor exactly.
See [`docs/PATCH-RELEASE.md`](docs/PATCH-RELEASE.md).

```bash
# in-place (reversible with --revert); on Windows the install dir is %LOCALAPPDATA%\Programs\eezstudio
node scripts/patch-release.mjs --app "<EEZ Studio install dir>"
```

After patching, launching EEZ Studio — or **double-clicking a `.eez-project`** —
starts the bridge automatically.

**Dev — build the from-source fork.** Rebuilds EEZ Studio from source with the
bridge; render-faithful but not byte-identical to the release. See
[`bridge/README.md`](bridge/README.md).

```bash
git clone https://github.com/eez-open/studio
node scripts/apply-bridge.mjs --studio ./studio
cd studio && npm install && npm run build
npm start -- "path/to/your.eez-project"
```

Either way, the bridge binds `127.0.0.1`, is token-authenticated, and starts when
a project is open. Disable with `EEZ_MCP_BRIDGE=0`; configure the port in
`<userData>/eez-mcp-bridge-config.json` (`%APPDATA%/eezstudio/…` on Windows).

### 2. Build & register the MCP server

Follow [`mcp-server/README.md`](mcp-server/README.md) / [`docs/REGISTER.md`](docs/REGISTER.md). In short:

```bash
cd mcp-server && npm install && npm run build
claude mcp add eez-studio -- node "$(pwd)/dist/index.js"
```

### 3. Verify

With EEZ Studio (bridge running) and a project open:

```bash
cd mcp-server && npm run smoke          # transport check: ping / get_project_info / list_pages
node mcp-server/scripts/mcp-e2e.mjs     # full MCP round-trip incl. render_page
```

If the handshake file is missing, the tools print clear guidance to launch EEZ
Studio (with the bridge) first.

---

## MCP tools

All 203 tools, grouped. See [`docs/PROTOCOL.md` §4](docs/PROTOCOL.md) for exact
params/results. Widgets are addressed by stable `objID`; pages by `name`. Values
use the object-model string form (colors `#rrggbb` or theme name, opacity `0–255`,
enums bare without `LV_`, fonts/bitmaps by name).

### Inspect (read-only)
| Tool | Purpose |
|------|---------|
| `ping` | Liveness + protocol/version handshake. |
| `get_project_info` | Name, file path, versions, display size, page list, modified flag. |
| `list_pages` | Pages with width/height/widget count. |
| `get_page_tree` | Nested widget tree for a page (with rects, styles-in-use). |
| `get_widget` | Full detail for one widget: props, local styles, event handlers. |
| `get_selection` | Current page + selected widgets. |

### Edit (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `create_widget` | Add a widget under a parent widget or a page root. |
| `update_widget` | Update classInfo props (`left, top, width, text, states, …`). |
| `set_style` | Set one or more local-style cells for a `part`/`state`. |
| `clear_style` | Clear a single local-style property. |
| `delete_widget` | Delete a widget. |
| `bind_event` | Attach an action handler to an event. |
| `unbind_event` | Remove an event handler. |
| `set_identifier` | Set a widget's name/identifier. |

### Render (pixel-exact, from the LVGL-WASM preview)
| Tool | Purpose |
|------|---------|
| `render_page` | Render a whole page to PNG. |
| `render_selection` | Render a single widget, cropped to its rect. |

### Navigate / lifecycle
| Tool | Purpose |
|------|---------|
| `select_widget` | Reveal + select a widget in the GUI. |
| `open_page` | Open a page's editor tab. |
| `undo` | Undo the last operation. |
| `redo` | Redo. |
| `save` | Save the project to disk. |

### Assets (read)
| Tool | Purpose |
|------|---------|
| `list_fonts` | Named fonts (with size/bpp when known). |
| `list_bitmaps` | Named bitmaps (with dimensions when known). |
| `list_actions` | Named actions and their implementation type. |
| `list_styles` | Named styles and the widget type they target. |

### Diagnostics
| Tool | Purpose |
|------|---------|
| `run_checks` | Run EEZ's project validation ("Check") → errors/warnings with the offending `objID`. |
| `get_problems` | Read current validation (CHECKS) and last-build (OUTPUT) diagnostics without re-running. |
| `get_console_log` | Renderer/preview console captured since start — catches **runtime** problems the static checks miss (e.g. a glyph outside a font's range). |
| `get_notifications` | EEZ's toast notifications captured since start — catches **toast-only** errors (e.g. `Font "roboto22" extraction failed`) invisible to the console and checks. |

### Pages (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `create_page` | Create a screen; auto-injects the root `LVGLScreenWidget` and returns its `objID`. |
| `delete_page` | Delete a page by name. |
| `rename_page` | Rename a page and rebind every reference to it. |
| `reorder_page` | Move a page to a new index in the screen list. |
| `set_page_settings` | Update page props (size, etc.). |

### Widget structure & introspection
| Tool | Purpose |
|------|---------|
| `duplicate_widget` | Deep-clone a widget subtree with fresh `objID`s. |
| `move_widget` | Reparent and/or reorder a widget (`objID` preserved). |
| `align_widgets` | Align/distribute widgets (`left/right/top/bottom/centerH/centerV/distributeH/distributeV`). |
| `copy_style` | Copy local-style cells from one widget to another. |
| `list_widget_classes` | *(read-only)* Enumerate creatable LVGL widget classes with editable props + events. |

### Assets (write — each call is one undo step)
| Tool | Purpose |
|------|---------|
| `add_bitmap` | Import an image as an LVGL bitmap. |
| `delete_bitmap` | Delete a bitmap by name. |
| `add_font` | Import a TTF/OTF as an LVGL font (runs the glyph extractor). |
| `edit_font` | Change a font's size/bpp/ranges and re-extract glyphs. |
| `delete_font` | Delete a font by name. |

### Styles / actions / colors / variables (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `create_style` · `update_style` · `delete_style` | Reusable LVGL styles. |
| `create_action` · `delete_action` | User actions. |
| `list_colors` · `add_color` · `update_color` · `delete_color` | Theme colors. |
| `list_variables` · `add_variable` · `update_variable` · `delete_variable` | Global variables. |

### Project / build
| Tool | Purpose |
|------|---------|
| `get_settings` | Full project settings (superset of `get_project_info`). |
| `update_settings` | Update general and/or build settings. |
| `build` | Run EEZ's code generation → `{ ok, errors, warnings, generatedFiles }`. |

### Widget sub-items (array children not reachable via `create_widget`)
| Tool | Purpose |
|------|---------|
| `add_matrix_button` · `update_matrix_button` | Add/edit a Button-Matrix button (or new-line separator). |
| `add_meter_indicator` | Add a Meter indicator (`NEEDLE_IMG/NEEDLE_LINE/SCALE_LINES/ARC`). |
| `add_meter_scale` | Add a scale to a Meter. |
| `add_scale_section` | Add a range-band section to a Scale *(LVGL 9.x only)*. |
| `add_span` | Add a text span to a Spangroup. |
| `delete_subitem` | Remove any sub-item (button/indicator/scale/section/span). |

### Widget flags / states / layout (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `set_flag` | Toggle a widget flag (`SCROLLABLE/CHECKABLE/FLOATING/…`; `HIDDEN/CLICKABLE` are reactive props). |
| `set_state` | Toggle a widget state token (`FOCUSED/FOCUS_KEY/PRESSED/HOVERED`). |
| `set_layout` | Set FLEX/GRID container layout (auto-handles GRID descriptors). |
| `set_scroll` | Set scrollbar mode / direction / snap. |
| `set_grid_cell` | Place a child in its parent grid (pos/span/align). |

### Enums / structures / user widgets (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `list_enums` · `add_enum` · `add_enum_member` · `update_enum_member` · `delete_enum` | Project enums (dropdown/roller/event option values). |
| `list_structures` · `add_structure` · `add_structure_field` · `delete_structure` | Typed structures. |
| `list_user_widgets` · `create_user_widget` · `delete_user_widget` | Reusable user-widget definitions. |

### Groups / themes (each call is one undo step)
| Tool | Purpose |
|------|---------|
| `list_groups` · `create_group` · `delete_group` · `rename_group` | LVGL focus groups. |
| `assign_widget_group` · `set_group_tab_order` · `set_group_defaults` | Group membership / tab order / simulator defaults. |
| `list_themes` · `create_theme` · `rename_theme` · `delete_theme` | Project themes. |
| `set_active_theme` | Switch the active theme (drives previews/renders). |
| `set_theme_color` | Set one theme's value for a named color. |

### Search & references (read-only, except `replace_in_project`)
| Tool | Purpose |
|------|---------|
| `search_project` | Full-project text/pattern search over every searchable property. |
| `find_references` · `is_referenced` | Where an object is referenced (graph / fast boolean — gates safe delete). |
| `replace_in_project` | Project-wide replace as one undo step. |
| `resolve_path` | Translate between EEZ string path and `objID`/class/label (both directions). |

### Clipboard
| Tool | Purpose |
|------|---------|
| `copy_objects` · `cut_objects` · `paste_objects` | Multi-object copy/cut/paste via EEZ's own serialization (cross-parent). |
| `get_clipboard_info` | Inspect the clipboard + can-paste-into-target before pasting. |

### Editors & navigation (transient UI state — no undo)
| Tool | Purpose |
|------|---------|
| `reveal_object` | Open the right editor for any object + select/scroll into view. |
| `open_editor` · `activate_editor` · `close_editor` | Open/focus/close an editor tab for any object. |
| `list_editors` · `get_active_editor` | Enumerate open tabs / read the active one. |
| `select_all` · `set_selection` | Multi-widget selection for batch ops. |
| `get_navigation_state` · `select_in_navigation` | Read/set the selected item per asset collection. |

### Scrapbook (global reusable-fragment library)
| Tool | Purpose |
|------|---------|
| `list_scrapbook_items` | Enumerate saved scrapbook fragments. |
| `insert_scrapbook_item` | Insert a scrapbook item + its dependencies into the active project. |
| `save_selection_to_scrapbook` | Save the current selection as a new scrapbook item. |

### Texts / i18n (requires the Texts feature — `enable_feature{key:"texts"}` first)
| Tool | Purpose |
|------|---------|
| `list_languages` · `add_language` · `rename_language` · `delete_language` | Localization languages (auto-fan translations). |
| `list_text_resources` · `add_text_resource` · `rename_text_resource` · `delete_text_resource` | Localized string keys. |
| `set_translation` | Set one (resource, language) cell. |
| `set_widget_text_resource` | Bind a widget to a resource (`_("id")`). |
| `import_texts` · `export_texts` | Bulk CSV/JSON/XLIFF import/export. |

### Font & bitmap options (on existing assets)
| Tool | Purpose |
|------|---------|
| `set_font_ranges` · `set_font_symbols` | Change built character ranges/symbols (re-extracts glyphs). |
| `add_font_additional_source` | Merge glyphs from another TTF. |
| `set_font_fallback` | Set a fallback font for missing glyphs. |
| `list_font_glyphs` | Enumerate a font's glyphs. |
| `set_bitmap_options` | Change bpp/format/dither/alwaysBuild/style. |
| `export_bitmap` | Write an embedded bitmap out to a file. |

### Settings & features
| Tool | Purpose |
|------|---------|
| `list_features` · `enable_feature` · `disable_feature` | Project feature registry (Texts, Readme, Shortcuts, …). |
| `add_project_import` · `remove_project_import` | Reference another project's assets. |
| `add_build_configuration` | Add a build configuration. |
| `set_readme` | Set the project readme file. |
| `set_zoom` | Set editor zoom / fit / center (UI state). |

### Simulator (LVGL-WASM run mode)
| Tool | Purpose |
|------|---------|
| `run_simulator` · `stop_simulator` | Start/stop the in-renderer LVGL-WASM simulator (F5). |
| `get_simulator_status` | Read live runtime state (running/paused/page/error). |
| `screenshot_simulator` | Capture the actual running-simulator frame as PNG. |
| `pause_simulator` · `resume_simulator` · `step_simulator` | Flow-debugger controls *(flow projects only)*. |

### Build operations
| Tool | Purpose |
|------|---------|
| `build_assets` | Build in-memory assets without writing files (fast validation). |
| `get_build_destination` | Resolve the build output folder (relative/absolute/exists). |
| `open_build_folder` | Reveal the build folder in the OS file manager. |
| `list_build_configurations` · `set_build_configuration` | Read/select the active build configuration. |

### Full simulator & export
| Tool | Purpose |
|------|---------|
| `start_full_simulator` · `stop_full_simulator` | Docker/Emscripten full simulator with HTTP preview *(needs Docker)*. |
| `export_dashboard` | Package a `.eez-dashboard` artifact *(Dashboard projects)*. |
| `build_extensions` | Build/install IEXT extension packages *(instrument projects)*. |

### Flow — components (needs `flowSupport`; each call is one undo step)
| Tool | Purpose |
|------|---------|
| `create_flow_component` | Place an action component (Start/SetVariable/EvalExpr/Constant/…) on a page or action flow. |
| `list_flow_components` · `get_flow_component` | Enumerate / detail flow components with their ports. |
| `list_flow_component_types` | Enumerate placeable component classes (palette). |
| `set_component_props` · `move_flow_component` · `delete_flow_component` | Edit / reposition / remove a component (delete cascades wires). |
| `set_catch_error` | Toggle a component's `@error` output. |
| `create_component_group` | Organize components into a named canvas group. |

### Flow — connections & ports
| Tool | Purpose |
|------|---------|
| `connect_components` · `disconnect_components` | Wire a source output to a target input (incl. `@seqout`→`@seqin`). |
| `list_flow_connections` · `update_flow_connection` | Enumerate / toggle-disable a connection. |
| `add_component_input` · `add_component_output` · `delete_component_port` | Manage a component's custom data ports. |
| `bind_flow_event` | Attach a flow-type event handler (widget event → connectable output). |

### Flow — variables & interface
| Tool | Purpose |
|------|---------|
| `list_flow_variables` · `add_flow_variable` · `update_flow_variable` · `delete_flow_variable` | Per-flow local variables. |
| `list_flow_interface` · `add_flow_input` · `add_flow_output` | A flow's public inputs/outputs (for wiring `CallAction`). |
| `list_action_flows` | Flow-implemented actions with their I/O. |

### Flow — reactive & misc
| Tool | Purpose |
|------|---------|
| `set_reactive_flag` · `set_reactive_state` | Expression-bind HIDDEN/CLICKABLE flags and CHECKED/DISABLED states. |
| `render_flow` | Return the flow wire-graph as data *(no rasterizer)*. |
| `find_component` | Locate a component by build-path index. |

### Instrument & dashboard features (needs the matching `enable_feature` key)
| Tool | Purpose |
|------|---------|
| `manage_scpi` | CRUD for SCPI subsystems/commands/enums (grouped op). |
| `manage_instrument_commands` | CRUD for instrument command definitions. |
| `manage_shortcuts` | CRUD for instrument shortcuts. |
| `set_micropython` | Read/replace the MicroPython script. |
| `list_extension_definitions` · `add_extension_definition` | IEXT/dashboard extension-definition entries. |

### Project lifecycle & view commands
| Tool | Purpose |
|------|---------|
| `save_as` | Save the project to a new path (headless with an explicit path). |
| `open_project` | Open a `.eez-project` in a new tab. |
| `new_project` · `reload_project` | Create a blank project / reload from disk *(disruptive)*. |
| `set_theme` | Switch the editor dark/light theme. |
| `open_view_tab` | Open a top-level app tab (home/history/settings/…). |

---

## Licensing

Two licenses, split at the protocol boundary:

- **`mcp-server/`, `scripts/`, `docs/` — MIT.** The MCP server only speaks the
  documented WebSocket protocol; it does not link EEZ Studio code, so it stays
  MIT and independently reusable.
- **`bridge/` (both `src/` and `dist/`) — GPL-3.** The bridge is compiled into EEZ
  Studio and calls its internals directly, making it a derivative work of EEZ Studio
  (GPL-3.0). `scripts/apply-bridge.mjs` and `scripts/patch-release.mjs` are MIT tooling,
  but any distribution of the resulting bridge-enabled fork **or patched release binary**
  must comply with GPL-3.

If you only run things locally, this split has no practical impact. It matters if
you **redistribute** a bridge-enabled EEZ Studio build.

---

## Status

**Proven**
- Live inspect/edit/render loop against a running EEZ Studio through the bridge.
- Edits go through EEZ Studio's `ProjectStore` + undo/command API — GUI, undo/redo,
  validation, and codegen stay consistent; each tool call is one undo step.
- Pixel-exact page/widget PNG capture from the LVGL-WASM preview.
- **Exact-parity install** via `scripts/patch-release.mjs` — the bridge injected into
  the official 0.28.0 release binary (verified: fonts + rendering match the vendor;
  double-clicking a `.eez-project` opens the bridged app).
- Reproducible from-source fork via `scripts/apply-bridge.mjs` (idempotent apply + revert).
- Diagnostics across all three surfaces: static checks, runtime preview console, and EEZ
  toast notifications (e.g. surfaces `Font "…" extraction failed`).
- Localhost-only, token-authenticated bridge with auto-discovery handshake file.
- Smoke + MCP-round-trip tests exercise the transport and the MCP layer end to end.

**Scope**
- Full **LVGL** coverage for **both flow and no-flow** projects (LVGL 8.4.x
  through 9.5.x; default 8.4.0). Project mode is read from
  `settings.general.flowSupport` (surfaced by `get_project_info`): no-flow
  projects wire logic natively (C `get_var_*` / `action_*`), while flow projects
  author the visual flow graph (`create_flow_component`, `connect_components`,
  `set_reactive_flag`/`set_reactive_state`, …) and expression-bind widget
  properties/flags/states. Some tools are project-type-gated (dashboard export,
  IEXT/instrument features) and return a clear `UNSUPPORTED` outside their
  project type. (Note: the `v3` in the project schema is the EEZ **projectVersion**
  string, unrelated to the LVGL version.)

**Pending / not yet covered**
- Published npm release of `eez-studio-mcp` (currently built from source).
- Upstream EEZ Studio versions other than the targeted **v0.28.0** (newer tags
  may need updates to the apply/patch scripts and `bridge/dist`).
- The in-app **"MCP Bridge" menu** (Start/Stop/port) exists only in the from-source
  fork; a patched release install is controlled via its config file + `window.eezMcpBridge`.
- Unsolicited change/selection **events** are defined in the protocol but treated
  as optional/ignorable by v1 clients.
```
