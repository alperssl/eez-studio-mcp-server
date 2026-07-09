# EEZ Studio MCP Bridge — Wire Protocol (v1)

The bridge is a WebSocket server hosted **inside the EEZ Studio renderer** (which runs with
`nodeIntegration:true`, so it can `require("ws")` and reach the live `ProjectStore` directly).
The standalone MCP server is a separate Node process that connects to the bridge and exposes
MCP tools to an agent.

```
agent/client ⇄ (stdio, MCP) ⇄ mcp-server (Node) ⇄ (localhost WebSocket, this protocol) ⇄ EEZ Studio renderer bridge ⇄ ProjectStore + LVGL-WASM preview
```

This document is the single source of truth for both sides. It is transport-agnostic about MCP;
it only defines the **bridge WebSocket protocol**.

**Scope.** The protocol below is the authoritative **208-method** contract covering the *full* EEZ
Studio project surface: pages/screens, widgets (+ sub-items, flags/states/layout/scroll/grid),
styles, assets (fonts/bitmaps/colors), variables/enums/structures/user-widgets, groups/themes,
i18n/texts, project-wide search/references/clipboard/navigation, the visual **flow graph** (flow
components, connection lines, ports, reactive widget bindings), the **LVGL-WASM simulator**, code
generation/build, and instrument/dashboard features. It supports **both flow and no-flow LVGL
projects** (LVGL **8.4.0**–**9.5.0**, default 8.4.0) — nothing here is no-flow-only. A project's mode
is read from `settings.general.flowSupport` (surfaced as `flowSupport` in `get_project_info` /
`get_settings`): no-flow projects wire logic in native C (`get_var_*`/`action_*`), while flow projects
author logic visually via flow components + connection lines with expression-bound widget
properties/flags/states (requires the eez-framework C++ runtime). Individual methods note any
version- or mode-specific gating (e.g. `NOT_LVGL`, `UNSUPPORTED`) inline. `projectVersion` is the EEZ
schema string (currently `"v3"`) and is distinct from `lvglVersion` (the LVGL library version).

## 1. Discovery & auth (handshake file)

On startup the bridge:
1. Chooses a port: `process.env.EEZ_MCP_BRIDGE_PORT` or default **`38017`**.
2. Chooses a token: `process.env.EEZ_MCP_BRIDGE_TOKEN` or a random 32-hex-char token.
3. Binds a WebSocket server to **`127.0.0.1:<port>`** only (never `0.0.0.0`).
4. Writes a handshake file so the local MCP server can auto-discover it:
   - Path: `path.join(os.tmpdir(), "eez-studio-mcp-bridge.json")`
   - Contents: `{ "port": number, "token": string, "pid": number, "protocolVersion": 1, "startedAt": ISO8601, "eezStudioVersion": string }`
   - The file is deleted on clean shutdown / renderer teardown.

The MCP server reads the handshake file, then connects to
`ws://127.0.0.1:<port>?token=<token>`. The bridge **rejects the upgrade** (HTTP 401) if the
token query param is missing or wrong. If the handshake file is absent, the MCP server reports
that EEZ Studio (with the bridge) is not running.

Rationale: renderer has full Node access, so an open unauthenticated port is RCE-adjacent —
localhost bind + shared token is mandatory.

## 2. Message framing

Each WebSocket message is one UTF-8 JSON object.

**Request** (mcp-server → bridge):
```json
{ "id": "<uuid>", "method": "<method>", "params": { } }
```

**Response** (bridge → mcp-server), correlated by `id`:
```json
{ "id": "<uuid>", "ok": true, "result": { } }
```
or
```json
{ "id": "<uuid>", "ok": false, "error": { "code": "<CODE>", "message": "<human text>" } }
```

**Event** (bridge → mcp-server, unsolicited, no `id`) — optional, ignorable by v1 clients:
```json
{ "event": "hello" | "project-changed" | "selection-changed", "data": { } }
```
On connect the bridge sends `{ "event": "hello", "data": <get_project_info result | null> }`.

Error codes: `NO_PROJECT` (no project open), `NOT_FOUND` (objID/page not found),
`BAD_PARAMS` (validation), `NOT_LVGL` (project isn't LVGL), `UNSUPPORTED`, `INTERNAL`.

## 3. Identity

- **Widgets** are addressed by their stable serialized GUID **`objID`**. The bridge resolves
  `objID → object` via `project._objectsMap` (`Map<objID, EezObject>`).
- **Pages** are addressed by their unique `name` string (the `page` param).
- Every widget returned by an inspect method includes its `objID` so the agent can address it next.

## 4. Methods

All params are objects. `part`/`state` are bare LVGL selector strings (e.g. `"MAIN"`,
`"DEFAULT"`, `"PRESSED"`, `"CHECKED|PRESSED"`). All values use the **object-model string form**
(colors `"#rrggbb"` or theme name, opacity int 0–255, enums bare without `LV_`, fonts/bitmaps by
name) — never `LV_*` constants or BGR ints.

### Inspect (read-only)
| Method | Params | Result |
|---|---|---|
| `ping` | — | `{ pong: true, protocolVersion, eezStudioVersion }` |
| `get_project_info` | — | `{ name, filePath, projectVersion, lvglVersion, flowSupport, displayWidth, displayHeight, isModified, pages: string[] }` |
| `list_pages` | — | `{ pages: [{ name, width, height, widgetCount }] }` |
| `get_page_tree` | `{ page, depth? }` | `{ page, root: WidgetNode }` — nested tree (see §5) |
| `get_widget` | `{ objID }` | `{ widget: WidgetDetail }` — full props incl. localStyles + eventHandlers |
| `get_selection` | — | `{ page: string\|null, objIDs: string[], widgets: WidgetNode[] }` |

### Edit (all undoable; each call is ONE undo step)
| Method | Params | Result |
|---|---|---|
| `create_widget` | `{ type, parent?: objID, page?, index?, props? }` | `{ objID }` |
| `update_widget` | `{ objID, props }` | `{ objID }` — forwards props to `ProjectStore.updateObject` |
| `set_style` | `{ objID, part, state, values: {prop:value} }` | `{ objID }` — sets one or more style cells on `localStyles` |
| `clear_style` | `{ objID, part, state, prop }` | `{ objID }` |
| `delete_widget` | `{ objID }` | `{ deleted: objID }` |
| `bind_event` | `{ objID, event, action, userData? }` | `{ objID }` — adds an `action` handler |
| `unbind_event` | `{ objID, event }` | `{ objID }` |
| `set_identifier` | `{ objID, name }` | `{ objID }` |

`create_widget`: if `parent` is given, the widget is added to that widget's `children`; else if
`page` is given, it's added to the page's screen-root children. `type` is a registered class name
(e.g. `"LVGLLabelWidget"`). `props` are classInfo property keys (`left, top, width, height,
leftUnit, ..., text, textType, widgetFlags, states, useStyle, zoom, angle, image, ...`).

### Render (pixel-exact, from EEZ's own LVGL-WASM preview)
| Method | Params | Result |
|---|---|---|
| `render_page` | `{ page }` | `{ pngBase64, width, height }` |
| `render_selection` | `{ objID? }` | `{ pngBase64, width, height, objID }` — crops to the widget's rect |

`pngBase64` is raw base64 (no `data:` prefix). MCP wraps it as an image content block
`{ type: "image", data: pngBase64, mimeType: "image/png" }`.

### Navigate / lifecycle
| Method | Params | Result |
|---|---|---|
| `select_widget` | `{ objID }` | `{ objID }` — reveals + selects in the GUI |
| `open_page` | `{ page }` | `{ page }` — opens the page editor tab |
| `undo` | — | `{ label }` |
| `redo` | — | `{ label }` |
| `save` | — | `{ saved: true, filePath }` |

### Assets (read)
| Method | Params | Result |
|---|---|---|
| `list_fonts` | — | `{ fonts: [{ name, size?, bpp? }] }` |
| `list_bitmaps` | — | `{ bitmaps: [{ name, width?, height? }] }` |
| `list_actions` | — | `{ actions: [{ name, implementationType }] }` |
| `list_styles` | — | `{ styles: [{ name, forWidgetType }] }` |

### Diagnostics
| Method | Params | Result |
|---|---|---|
| `run_checks` | — | `{ numErrors, numWarnings, problems: Problem[] }` — runs EEZ's project validation ("Check") |
| `get_problems` | `{ section? }` | `{ checks?: DiagnosticsSection, output?: DiagnosticsSection }` — reads current diagnostics without re-running |
| `get_console_log` | `{ level?, limit? }` | `{ entries: ConsoleEntry[] }` — renderer/preview console captured since bridge start |
| `get_notifications` | `{ level?, limit? }` | `{ entries: NotificationEntry[] }` — EEZ toast notifications captured since bridge start |

- `Problem` = `{ severity: "error"|"warning"|"info", text, group?, objID?, path?, label? }`. `objID` is the nearest addressable widget (select/fix it). `DiagnosticsSection` = `{ numErrors, numWarnings, problems }`.
- `ConsoleEntry` = `{ ts, level: "log"|"info"|"warn"|"error", text, count }`. `count` collapses consecutive duplicates. `level` filters to that severity **and above** (default `"warn"`). Messages the LVGL-WASM runtime tags `[Warn]`/`[Error]` are reclassified to that level even though it prints them via `console.log`.
- `NotificationEntry` = `{ ts, level: "success"|"info"|"warning"|"error", text, count }`. `level` filters to that severity and above (default `"warning"`). This captures EEZ's toast notifications (via `eez-studio-ui/notification`, incl. `notification.update`), e.g. `Font "roboto22" extraction failed: ... Received NaN` — errors that appear **only** as toasts, not in the console or checks.
- **Three surfaces, check all after edits/renders and on open:**
  - `run_checks`/`get_problems` — EEZ's *static* validation (invalid references, missing fonts/actions, bad values).
  - `get_console_log` — *runtime* preview problems, e.g. `lv_draw_letter: glyph dsc. not found for U+131` (glyph outside a font's range).
  - `get_notifications` — EEZ *toast* errors, e.g. font-extraction failures. These are often the root cause of the console glyph warnings.

### Pages / screens (undoable)
| Method | Params | Result |
|---|---|---|
| `create_page` | `{ name, width?=displayW, height?=displayH, index? }` | `{ page, rootObjID }` — new LVGL screen (Page) added to `userPages`; `rootObjID` is its `LVGLScreenWidget` |
| `delete_page` | `{ name }` | `{ deleted }` |
| `rename_page` | `{ name, newName }` | `{ page }` |
| `reorder_page` | `{ name, index }` | `{ page, index }` |
| `set_page_settings` | `{ name, props }` | `{ page }` — page-level props (`background`, `isStartScreen`, …) |

### Widgets — structure / clone / move / introspect (undoable; `list_widget_classes` is read-only)
| Method | Params | Result |
|---|---|---|
| `duplicate_widget` | `{ objID, targetPage?, parent?, index?, left?, top?, identifierSuffix? }` | `{ objID }` — deep-clone a widget subtree (children + localStyles + props + eventHandlers) with FRESH objIDs and no identifier collisions |
| `move_widget` | `{ objID, newParent?, targetPage?, index? }` | `{ objID }` — reparent and/or reorder (z-order) a subtree; objID preserved |
| `align_widgets` | `{ objIDs[], mode }` | `{ objIDs }` — `mode`: `left\|right\|top\|bottom\|centerH\|centerV\|distributeH\|distributeV` |
| `copy_style` | `{ fromObjID, toObjID, part?, state? }` | `{ objID }` — copy local-style cells |
| `list_widget_classes` | — | `{ classes: WidgetClass[] }` — creatable widget types + editable props/events (see §5) |

### Assets — write (undoable)
| Method | Params | Result |
|---|---|---|
| `add_bitmap` | `{ name, filePath? \| dataBase64?, colorFormat? }` | `{ name, width, height }` — import an image (GUI "Add Bitmap"); referenceable by name in `LVGLImageWidget.image` |
| `delete_bitmap` | `{ name }` | `{ deleted }` |
| `add_font` | `{ name, filePath, size, bpp, ranges }` | `{ name }` — import a TTF as an LVGL font with glyph ranges |
| `edit_font` | `{ name, size?, bpp?, ranges? }` | `{ name }` — change ranges/size/bpp and re-extract (fix `▯` glyphs) |
| `delete_font` | `{ name }` | `{ deleted }` |
| `create_action` | `{ name, implementationType?="native" }` | `{ name }` — so `bind_event` can bind it; codegen emits `action_<name>` |
| `delete_action` | `{ name }` | `{ deleted }` |
| `create_style` | `{ name, forWidgetType, values }` | `{ name }` — reusable named style (referenced via `useStyle`) |
| `update_style` | `{ name, part?, state?, values }` | `{ name }` — set/clear shared-style cells |
| `delete_style` | `{ name }` | `{ deleted }` |
| `list_colors` | — | `{ colors: [{ name, value }] }` — theme palette |
| `add_color` | `{ name, value }` | `{ name }` |
| `update_color` | `{ name, value }` | `{ name }` |
| `delete_color` | `{ name }` | `{ deleted }` |

### Variables (flow projects + no-flow globals)
| Method | Params | Result |
|---|---|---|
| `list_variables` | — | `{ variables: [{ name, type, defaultValue? }] }` |
| `add_variable` | `{ name, type, defaultValue? }` | `{ name }` |
| `update_variable` | `{ name, props }` | `{ name }` |
| `delete_variable` | `{ name }` | `{ deleted }` |

### Project / build
| Method | Params | Result |
|---|---|---|
| `get_settings` | — | superset of `get_project_info` + the full **Settings › General/Build panel** as nested `general` / `build` objects (see below) |
| `update_settings` | `{ general?, build? }` | `{ updated, ignored?, note? }` — via `updateObject(settings.general\|settings.build, …)`, ONE undo step |
| `build` | — | `{ ok, errors: Problem[], warnings: Problem[], generatedFiles: string[] }` — runs EEZ's Check + Generate (non-Docker LVGL codegen) to the configured destination |

- **`get_settings` / `update_settings` cover the whole Settings › General + Build panel.** `get_settings`
  returns nested `general` `{ projectType, lvglVersion, flowSupport, displayWidth, displayHeight,
  circularDisplay, displayBorderRadius, darkTheme, embedBitmaps, embedFonts, cacheFonts, title, description,
  image, icon, keywords, author, authorLink, targetPlatform, targetPlatformLink, minStudioVersion,
  masterProject, css }` and `build` `{ destinationFolder, lvglInclude, … }` — every declared field is always
  present (**`null` when empty**, since JSON drops `undefined`). `update_settings` takes a flat `general`
  and/or `build` key→value map and writes via `updateObject` (one undo step; combined when both given); a key
  that is not a real `settings.general`/`settings.build` property is returned in **`ignored`** (with a `note`)
  rather than silently dropped. The panel's array sections (`imports`, `extensions`, `resourceFiles`, build
  `configurations`, build `files`) have their own dedicated tools.
- Assets/pages/styles/actions/colors/variables are addressed by **unique name** (like pages). Every
  mutation goes through the ProjectStore command/undo API — one undo step per call — exactly like the
  §4 Edit tools. `add_bitmap`/`add_font`/`edit_font`/`build` may run an async convert/extract/generate step.
- These apply to LVGL v3 projects in **either mode** (flow and no-flow). `list_variables`/variables
  apply to flow projects (global + flow-local) and to no-flow global variables alike.
  `create_action { implementationType: "native" }` is the **no-flow-specific** form (codegen emits an
  `action_<name>` C stub); on a **flow** project actions are instead implemented as flow graphs
  (`implementationType: "flow"`) authored via the *Flow components* / *Flow connections* tools below.

### Widget sub-items (array children that are NOT widgets; undoable)
Button-matrix buttons, meter indicators/scales, scale sections, and spangroup spans are plain array
elements on their parent widget — they have no independent `objID`-in-`create_widget` path, so they
get dedicated tools. Each sub-item still receives a fresh `objID` and is resolvable via `_objectsMap`
once added. The parent widget is addressed by its `objID`; sub-items are addressed by array `index`
under the parent (or, for `delete_subitem`, by the sub-item's own `objID`).

| Method | Params | Result |
|---|---|---|
| `add_matrix_button` | `{ objID, text?, width?, newLine?, ctrl?, index? }` | `{ objID, buttonIndex }` — appends/inserts an `LVGLMatrixButton` into `LVGLButtonMatrixWidget.buttons`; `objID` echoes the parent widget |
| `update_matrix_button` | `{ objID, index, props }` | `{ objID, index }` — `updateObject` on `buttons[index]` |
| `add_meter_indicator` | `{ objID, type, scaleIndex?, props?, index? }` | `{ objID, indicatorIndex }` — adds to `scales[scaleIndex ?? 0].indicators` of an `LVGLMeterWidget` (**LVGL 8.x only**) |
| `add_meter_scale` | `{ objID, props?, index? }` | `{ objID, scaleIndex }` — adds an `LVGLMeterScale` to `LVGLMeterWidget.scales` (**LVGL 8.x only**) |
| `add_scale_section` | `{ objID, props?, index? }` | `{ objID, sectionIndex }` — adds an `LVGLScaleSection` to `LVGLScaleWidget.sections` (**LVGL 9.x only** — `NOT_FOUND` on an 8.x project, where no Scale widget can exist) |
| `add_span` | `{ objID, text?, props?, index? }` | `{ objID, spanIndex }` — adds an `LVGLSpan` to `LVGLSpanWidget.spans` (all LVGL versions) |
| `delete_subitem` | `{ objID }` \| `{ objID, kind, index }` | `{ deleted: true, objID, index? }` — removes one sub-item; pass the sub-item's own `objID`, or the parent `objID` + `kind`/`index` |

- `add_matrix_button`: `newLine:true` makes a line-break separator (its `text`/`width`/ctrl fields are
  ignored). `width` is 1–7 (clamped). `ctrl` is `{ ctrlHidden?, ctrlNoRepeat?, ctrlDisabled?,
  ctrlCheckable?, ctrlChecked?, ctrlClickTrig?, ctrlPopover?, ctrlRecolor?, ctrlCustom1?, ctrlCustom2? }`
  (all boolean; `ctrlRecolor` is LVGL-8-only). The returned `buttonIndex` is the **array index** (it
  counts `newLine` separators — this is the addressable index for `update_matrix_button`/`delete_subitem`,
  not the GUI's display "#N" which skips separators).
- `add_meter_indicator`: `type` is `"NEEDLE_IMG"|"NEEDLE_LINE"|"SCALE_LINES"|"ARC"` (`type` is required —
  it drives class dispatch). `props` overrides the per-type defaults (e.g. NeedleLine
  `{ width:3, color:"#0000FF", radiusModifier:-28, value:30, valueType:"literal" }`). `scaleIndex`
  defaults to `0` (a Meter always has ≥1 scale).
- `add_meter_scale`: the class default seeds ONE `NEEDLE_LINE` indicator; pass `props:{ indicators: [] }`
  for an empty scale. Other props: `{ minorTickCount, minorTickLineWidth, minorTickLength, minorTickColor,
  nthMajor, majorTickWidth, majorTickLength, majorTickColor, labelGap, scaleMin, scaleMax,
  scaleAngleRange, scaleRotation }`.
- `add_span`: `text` is a shorthand for `{ text, textType:"literal" }` (default `"Span"`). `textType`
  may be `"literal"|"translated-literal"|"expression"`. Optional style `props`: `textColor, textFont,
  textDecor("NONE"|"UNDERLINE"|"STRIKETHROUGH"), textLetterSpace, textLineSpace, textOpa`.
- `delete_subitem`: the `objID`-only form (the sub-item's own `objID`) is preferred and works for every
  kind. The `kind`+`index` fallback needs the **parent** `objID`; `kind` ∈
  `button|indicator|scale|section|span` (for `indicator`, an optional `scaleIndex` selects the scale,
  default 0). Sub-items are not name-referenced, so deletes leave no dangling references.
- **Version gating:** Meter (indicators/scales) is LVGL-8-only; Scale (sections) is LVGL-9-only;
  ButtonMatrix and Spangroup work on all versions. Add-tools on the wrong version return a clear error
  rather than emitting a widget that codegens to a bare `lv_obj_create`.

### Widget flags / states / layout / scroll / grid-cell (undoable; each is ONE undo step)
All five edit an **existing** widget resolved by `objID`. `set_flag`/`set_state`/`set_scroll` write plain
**widget props**; `set_layout`/`set_grid_cell` write **local-style cells** on `MAIN`/`DEFAULT` (same
mechanism as `set_style`). Every call issues exactly one `updateObject`.

| Method | Params | Result |
|---|---|---|
| `set_flag` | `{ objID, flag, on }` | `{ objID, widgetFlags }` — toggles one token in the widget's pipe-delimited `widgetFlags` string |
| `set_state` | `{ objID, state, on }` | `{ objID, states }` — toggles one token in the widget's pipe-delimited `states` string |
| `set_layout` | `{ objID, layout, flexFlow?, flexMainPlace?, flexCrossPlace?, flexTrackPlace?, gridColumns?, gridRows? }` | `{ objID }` — writes `layout`+flex/grid descriptors as local-style cells on MAIN/DEFAULT |
| `set_scroll` | `{ objID, scrollbarMode?, scrollDirection?, scrollSnapX?, scrollSnapY? }` | `{ objID }` — writes the four scroll **widget** enum props |
| `set_grid_cell` | `{ objID, colPos?, colSpan?, xAlign?, rowPos?, rowSpan?, yAlign? }` | `{ objID }` — writes the six `grid_cell_*` local-style cells on the CHILD widget |

- `set_flag`: `flag` must be one of the widget's version-dependent flag codes (`getLvglFlagCodes(widget)`),
  e.g. `SCROLLABLE, CHECKABLE, SCROLL_ELASTIC, SCROLL_MOMENTUM, SCROLL_CHAIN_HOR/VER, EVENT_BUBBLE,
  GESTURE_BUBBLE, FLOATING, IGNORE_LAYOUT, OVERFLOW_VISIBLE, …`. **`HIDDEN` and `CLICKABLE` are rejected**
  (`BAD_PARAMS`) — they are the reactive props `hiddenFlag`/`clickableFlag`, set via `update_widget`.
  (Note `FOCUSABLE` is not a token; the flag is `CLICK_FOCUSABLE`.) `on:true` adds, `on:false` removes.
- `set_state`: `state` must be one of `FOCUSED, FOCUS_KEY, PRESSED, HOVERED` (**only** these four).
  `CHECKED`/`DISABLED` are **not** `states` tokens — set them via `update_widget`
  `{ checkedState, checkedStateType }` / `{ disabledState, disabledStateType }`. `EDITED`/`SCROLLED` are
  valid only as **style-cell** states (in `set_style`/`set_layout` `state`), not here.
- `set_layout`: `layout` ∈ `NONE|FLEX|GRID`. `flexFlow` ∈ `ROW, COLUMN, ROW_WRAP, ROW_REVERSE,
  ROW_WRAP_REVERSE, COLUMN_WRAP, COLUMN_REVERSE, COLUMN_WRAP_REVERSE`. `flexMainPlace`/`flexTrackPlace` ∈
  `START, END, CENTER, SPACE_EVENLY, SPACE_AROUND, SPACE_BETWEEN`; `flexCrossPlace` ∈ `START, END, CENTER`.
  `gridColumns`/`gridRows` are descriptor strings (space/comma list of px / `FR(x)` / `CONTENT`, e.g.
  `"FR(1) FR(1)"` or `"50 CONTENT"`). Setting `layout:"GRID"` without descriptors auto-adds empty
  `grid_row_dsc_array`/`grid_column_dsc_array` (as EEZ does). Enum values are written as the token string.
- `set_scroll`: these are **widget props**, not style cells, and their ids are **lowercase**.
  `scrollbarMode` ∈ `off, on, active, auto` (`flagScrollbarMode`); `scrollDirection` ∈
  `none, top, left, bottom, right, hor, ver, all` (`flagScrollDirection`);
  `scrollSnapX`/`scrollSnapY` ∈ `none, start, end, center`. A widget must have the `SCROLLABLE` flag
  (`set_flag`) for scrolling to take effect; elastic/momentum/chain are flags too.
- `set_grid_cell`: applies to the **child** being placed inside a GRID parent. `colPos`/`rowPos`/
  `colSpan`/`rowSpan` are numbers (spans ≥ 1); `xAlign`/`yAlign` ∈ `START, CENTER, END, STRETCH,
  SPACE_EVENLY, SPACE_AROUND, SPACE_BETWEEN`. Effective only when the parent has `layout:"GRID"` with
  descriptors (not enforced by the store).

### Enums / structures / user-widgets (undoable; addressed by unique name)
Enums and structures live on `project.variables.{enums,structures}`; user widgets live on
`project.userWidgets`. Members/fields are addressed by name within their parent. `list_*` are read-only.

| Method | Params | Result |
|---|---|---|
| `list_enums` | — | `{ enums: [{ name, members: [{ name, value, automaticValue }] }] }` |
| `add_enum` | `{ name, members? }` | `{ objID, name }` — `members` may seed inline members |
| `add_enum_member` | `{ enumName, name, specificValue?, automaticValue?, index? }` | `{ objID }` |
| `update_enum_member` | `{ enumName, memberName, props }` | `{ objID }` |
| `delete_enum` | `{ enumName, memberName? }` | `{ deleted }` — deletes one member if `memberName` given, else the whole enum |
| `list_structures` | — | `{ structures: [{ name, fields: [{ name, type }] }] }` |
| `add_structure` | `{ name, fields? }` | `{ objID, name }` |
| `add_structure_field` | `{ structureName, name, type, index? }` | `{ objID }` |
| `delete_structure` | `{ structureName, fieldName? }` | `{ deleted }` — deletes one field if `fieldName` given, else the whole structure |
| `list_user_widgets` | — | `{ userWidgets: [{ name, width, height, widgetCount }] }` |
| `create_user_widget` | `{ name, width?, height? }` | `{ objID, name }` — NO `rootObjID` (user widgets have no `LVGLScreenWidget` root; children go into `components`) |
| `delete_user_widget` | `{ name }` | `{ deleted }` |

- **Enum member value model:** `value` is computed and never written directly. `automaticValue:true`
  ⇒ `value` is `prev.value + 1` (index 0 ⇒ 0); `automaticValue:false` ⇒ `value === specificValue`.
  Passing a `specificValue` (or `automaticValue:false`) makes the member specific; otherwise it is
  automatic. On `update_enum_member`, flipping `automaticValue` back-fills/clears `specificValue`
  automatically (one coalesced undo step), so `{ automaticValue:false }` alone preserves the current
  number.
- `add_structure_field` `type` uses EEZ ValueType syntax: `integer, float, double, boolean, string`,
  `array:<T>`, `struct:<StructName>`, `enum:<EnumName>`; validated up front (`BAD_PARAMS` on invalid).
- `create_user_widget`: **no LVGLScreenWidget is injected** (unlike `create_page`), so there is no
  `rootObjID` — new child widgets land directly in the user widget's `components`. Name must be unique
  across all pages+user-widgets. Width/height default to the display size (or 800×450 for dashboard).
- **Renames & deletes:** enum/struct/field/member/user-widget names are referenced by string
  (`enum:Name`, `struct:Name`, `EnumName.Member` expressions, `LVGLUserWidgetWidget.userWidgetPageName`).
  A rename via `update_enum_member` `{ props:{ name } }` rebinds references (`replaceObjectReference`) in
  one undo step; deletes leave inbound references dangling (surface as CHECK errors) — matching EEZ.

### LVGL groups / project themes (undoable except `set_active_theme`)
Focus groups live on `project.lvglGroups` (LVGL-only); themes live on `project.themes` (all project
types). Widgets reference their group **by name string** (`widget.group`), so rename/delete must handle
stale strings. `list_*` are read-only.

| Method | Params | Result |
|---|---|---|
| `list_groups` | — | `{ groups: [{ name, isEncoderDefault, isKeyboardDefault }], defaultGroupForEncoderInSimulator, defaultGroupForKeyboardInSimulator }` |
| `create_group` | `{ name }` | `{ name }` — only field is `name` (unique C identifier) |
| `assign_widget_group` | `{ objID, group, groupIndex? }` | `{ objID, group, groupIndex }` — `group` is a group **name** (`""` clears) |
| `set_group_tab_order` | `{ objID, groupIndex }` | `{ objID, groupIndex }` |
| `rename_group` | `{ name, newName }` | `{ name }` — rebinds widget `.group` refs + simulator-default strings |
| `delete_group` | `{ name }` | `{ deleted }` — also clears matching simulator defaults |
| `set_group_defaults` | `{ encoderGroup?, keyboardGroup? }` | `{ encoderGroup, keyboardGroup }` — `""` clears either |
| `list_themes` | — | `{ themes: [{ name, active }] }` |
| `create_theme` | `{ name }` | `{ name }` — seeds color slots for the new theme |
| `set_active_theme` | `{ name }` | `{ active }` — **UI state, NOT an undo step** |
| `set_theme_color` | `{ theme, color, value }` | `{ theme, color, value }` — sets ONE theme's value for a named color slot |
| `rename_theme` | `{ name, newName }` | `{ name }` |
| `delete_theme` | `{ name }` | `{ deleted }` |

- `assign_widget_group`/`set_group_defaults`: a non-empty group name must already exist (`NOT_FOUND`
  otherwise). `groupIndex` is only meaningful once `group` is set. `LVGLScreenWidget` ignores `group`.
- `set_theme_color` sets a per-theme value of a named color slot (distinct from `update_color`, which
  changes the slot across all themes); the value is written through the undo-safe `Theme.colors` path.
- `set_active_theme` writes UI navigation state (`selectedThemeObject`) and re-renders themed colors; it
  is **not** placed on the undo stack (do not undo it).
- **Renames & deletes:** group names are name strings on widgets — `rename_group` uses
  `replaceObjectReference` (+ manual fix of the two simulator-default strings); `delete_group` leaves
  widget `.group` refs dangling (CHECK warning) and clears matching defaults. `rename_theme` rebinds
  theme references; `delete_theme` orphans that theme's stored color values harmlessly and falls the
  active theme back to `themes[0]`.

### Search & references (`replace_in_project` is undoable — ONE step; the rest are read-only, NO undo)
Full-project search + reference graph over the whole `store.project` tree (all project types, not
LVGL-gated). Read tools return **rows keyed by the owning object** (an `EezValueObject` match's stable
identity is its parent, not the transient value wrapper): each row is `{ objID?, path, label,
propertyName?, match? }`. `objID` is best-effort (undefined for array/computed hosts) — `path` is always
present and round-trips through `resolve_path`.

| Method | Params | Result |
|---|---|---|
| `search_project` | `{ pattern, matchCase?, matchWholeWord?, limit?=500 }` | `{ results: Row[], count, truncated }` — substring (or `\bword\b`) match over searchable props |
| `find_references` | `{ objID? \| path? }` | `{ references: Row[], count }` — every place the target is referenced (collection refs + expression usages) |
| `replace_in_project` | `{ pattern, replacement, matchCase?, matchWholeWord?, target? }` | `{ replacedCount, undoLabel, skipped?, skippedCount?, note? }` — project-wide find/replace, **ONE undo step** |
| `is_referenced` | `{ objID? \| path? }` | `{ referenced: boolean }` — fast; short-circuits on first inbound reference |
| `resolve_path` | `{ objID? \| path? }` | `{ objID, path, class, label }` — translate objID↔EEZ string path + report class/label |

- **Row shape:** `{ objID?, path, label, propertyName?, match? }`. `label` is EEZ's own `"Name: value"`
  tree label (identical to what the Search/References panels show); `propertyName` is the matched
  property; `match` (search only) is the matched text. Always prefer `path` as the primary key — `objID`
  can be `undefined` when the match lives on an array wrapper or a computed/value host.
- `search_project`: empty `pattern` → `BAD_PARAMS` (never walks the tree for nothing). `matchCase=false`
  is case-insensitive; `matchWholeWord` uses word boundaries. Numbers and strings both match
  (`value.toString()`). Honors `skipSearch`/`disabled` props exactly like the GUI. `limit` truncates
  bridge-side (`truncated:true` when hit); the engine itself is unbounded.
- `find_references`/`is_referenced`: references are **name-based** (collection path + name, plus
  expression identifiers) — this is how styles/colors/groups/variables are referenced across the model.
  An **unnamed or parentless** target yields `count:0` / `referenced:false` (correct — it can't be
  name-referenced). Pass either `objID` or `path`; the engine re-roots at the project root itself.
- `replace_in_project`: **string props only** in this form; collect-then-mutate (never mutates
  mid-iteration), wraps all `updateObject` writes in one `setCombineCommands(true)…finally(false)` → a
  single Ctrl+Z. With `replacement` set, the engine filters out read-only/hidden props automatically
  (matching the UI's replace scope). Optional `target` narrows scope (property-name filter or a subtree
  root); omitted → whole project. This is NOT `replaceObjectReference` (that is for single-object
  renames) — it is free-text pattern replacement. **Scope signal:** a match that `search_project` finds
  but that `canReplace()` cannot write (e.g. a build-file `template` body) is reported in `skipped`
  (`[{ objID?, path, propertyName, label }]`, capped at 200) with a human-readable `note` — for build-file
  templates the note points to `set_build_file_template` / `patch_build_file_template` (see below).
- `resolve_path`: both directions. objID→object via `_objectsMap`; path→object via
  `getObjectFromStringPath`. `class` is the registered constructor name (e.g. `"Page"`,
  `"LVGLLabelWidget"`, `"Style"`, `"Color"`); `label` is the classInfo label / name. `objID` may be
  `undefined` for arrays (e.g. path `"/pages"`). If both `objID` and `path` are given, `objID` wins
  (O(1) map lookup).

### Clipboard (`copy_objects`/`get_clipboard_info` read-only; `cut_objects`/`paste_objects` are ONE undo step)
Copy/cut/paste of one or more EezObjects through EEZ's own serialization + the **Electron OS clipboard**
(MIME `application/eez-studio-project-editor-data`). The clipboard is **not** an in-process buffer — a
`copy_objects` in one bridge call is pasteable by `paste_objects` in a later call, survives renderer
reloads, and is shared with the EEZ GUI (Ctrl+V works both ways). Paste always mints **fresh objIDs** and
de-collides identifiers (same guarantee as `duplicate_widget`).

| Method | Params | Result |
|---|---|---|
| `copy_objects` | `{ objIDs: string[] }` | `{ copied, objectClassName }` — serialize + write the OS clipboard; **no undo** (zero project mutations) |
| `cut_objects` | `{ objIDs: string[] }` | `{ cut, undoLabel }` — serialize, then `deleteObjects` in **ONE undo step**, then write clipboard |
| `paste_objects` | `{ into: { objID? \| page? }, index? }` | `{ objIDs, undoLabel }` — clone-with-new-objIDs + insert; **ONE undo step** |
| `get_clipboard_info` | `{ into? }` | `{ hasData, objectClassName, count, canPaste }` — pure read; no mutation |

- `copy_objects`: single vs. multi is split exactly like the GUI (single writes `object`/`objectParentPath`,
  multi writes `objects[]`/`objectsParentPath[]`); `objectClassName` is the **first** object's class on a
  multi-copy. Works on an unsaved project (`originProjectFilePath` serializes as null — harmless for
  same-project paste). Cross-parent multi-object copy is supported (each source's parent path is recorded).
- `cut_objects`: **transient nuance** — the serialize happens BEFORE the delete (deletion detaches the
  objects from the tree), and the clipboard write happens AFTER the delete succeeds, **outside** the undo
  transaction (matching the GUI). The delete is a single `store.deleteObjects` command = one undo entry;
  the bridge calls `deleteObjects` directly (NOT `deleteItems`, which pops a confirm dialog on referenced
  objects and would hang a headless call). `undoLabel` is `"Deleted"`.
- `paste_objects`: pastes **relative to a reference object** (`into.objID`, or `into.page`'s screen
  widget), walking up to the nearest ancestor that can contain the pasted class — EEZ's own paste-place
  resolution. A multi-object paste is one `addObjects`; a single is one `addObject`/`insertObject` — each
  already a single undo step (no explicit combine needed). **`index` is only honored** when the reference's
  parent equals the paste array (inserts after the reference); for exact index placement in an arbitrary
  container, paste then reorder. The underlying `pasteItem` **swallows errors and returns undefined** on
  failure, so the bridge pre-flights with `checkClipboard` and treats an empty result as an error.
- `get_clipboard_info`: reads the OS clipboard (`hasData`, `objectClassName`, `count`) and, when `into` is
  given, whether it can be pasted there (`canPaste` — same check that enables the GUI's Paste menu). Parsing
  the clipboard mints objIDs internally but never attaches them to the tree, so nothing is mutated.

### Editors & navigation (ALL transient UI/renderer state — NONE are undo commands)
Editor tabs, active-editor, navigation-store selection boxes, and page/flow selection are **transient
mobx/FlexLayout state**. NONE go through `updateObject`/`addObject`/`deleteObject`; NONE are on the undo
stack; `undo`/`redo` will not (and must not) reverse them. Every tool takes `objID` **or** an EEZ `path`
(resolved via `_objectsMap` / `getObjectFromStringPath`) and works in all project types (not LVGL-gated).

| Method | Params | Result |
|---|---|---|
| `reveal_object` | `{ objID? \| path?, openEditor?=true, showInNavigation?=true, select?=true }` | `{ objID, path, editorOpened }` — generalized `select_widget` for ANY object |
| `open_editor` | `{ objID? \| path?, permanent?=false }` | `{ tabId, title }` — open/focus an editor tab for the object |
| `activate_editor` | `{ objID? \| path? }` | `{ tabId, isActive }` — bring an already-open tab to front (`NOT_FOUND` if none) |
| `list_editors` | — | `{ editors: [{ objID?, path, tabId, title, active, permanent }] }` — enumerate open tabs |
| `close_editor` | `{ objID? \| path? }` | `{ closed }` — close the tab editing that object (does NOT delete the object) |
| `get_active_editor` | — | `{ tabId, objID, path, title }` \| `null` |
| `select_all` | — | `{ objIDs }` — select all siblings of the current selection in the active editor |
| `set_selection` | `{ objIDs: string[], ensureVisible?=true }` | `{ objIDs }` — set a MULTI-object selection |
| `get_navigation_state` | — | `{ selected: { <collection>: { objID, path, name? } \| null } }` |
| `select_in_navigation` | `{ collection, objID? \| path? }` | `{ collection, objID }` — set a collection's selected item + reveal its left-panel tab |

- `reveal_object` drives EEZ's single `showObjects(objects, openEditor, showInNavigation, select)` entry
  point (the same call `select_widget` uses with all-true flags), generalized to any object. `openEditor`
  resolves the nearest **ancestor with an editor component** and scrolls the target into view; if the
  object has no such ancestor (e.g. a raw variable value) `editorOpened` is `false` (correct, no-op).
- `open_editor`: `tabId` is the stable **FlexLayout tab node id** (never the array index — indices shift as
  tabs open/close). Only objects with an editor component (Page, Action-with-flow, Font, settings, …) render
  meaningfully; opening a leaf widget makes a blank tab — prefer `reveal_object` for "show this widget".
  With `permanent:true` the tab isn't recycled by the single-preview-tab logic (the underlying
  `openPermanentEditor` returns void, so the bridge re-fetches the editor to report `tabId`/`title`).
- `activate_editor`: prefers activating an **existing** editor (errors if none open) rather than creating a
  tab. `activeEditor` is reconciled asynchronously (`setTimeout` refresh), so a synchronous
  `selectEditorTabForObject` path is used to make `isActive` reliable.
- `select_all`: **no ready-made panel `selectAll()`** exists for the flow/page editor, so it selects the
  current selection's **sibling `children` array** (anchored on the first selected widget). Requires an
  existing selection (`NO_SELECTION` otherwise); a screen-root variant can anchor on the page instead.
- `set_selection`: `showObjects` is inherently multi-object. `ensureVisible` maps onto the `openEditor`
  arg (scroll-into-view is its side effect). All objIDs should live in the SAME open editor/flow — the
  flow editor silently skips objects with no adapter in the current flow.
- `get_navigation_state` / `select_in_navigation`: the `NavigationStore` holds one `observable.box` per
  asset collection. `collection` ∈ `userPage, userWidget, action, globalVariable, structure, enum, style,
  theme, themeColor, font, glyph, bitmap, extensionDefinition, scpiSubsystem, scpiCommand, scpiEnum,
  instrumentCommands, textResource, language, lvglGroup, localVariable`. (Note: the real box names are
  `selectedLvglGroupObject` and `selectedThemeColorObject` — there is no `selectedGroupObject`/
  `selectedColorObject`.) `select_in_navigation` sets the box (in a mobx `runInAction`) and calls
  `navigateTo` to reveal the correct left-panel tab — the same mechanism as `set_active_theme`.

### Scrapbook (GLOBAL app-level singleton on SQLite — NOT per-project, NOT on the project undo stack)
The scrapbook is a reusable component-fragment library: a module-level singleton (`model` from
`project-editor/store/scrapbook`) backed by **SQLite files** under the Electron userData dir, independent
of any project. Its own `ScrapbookUndoManager` (not the project undo stack) tracks scrapbook edits.
`model.destinationProjectStore` is the same store as the bridge's `requireProjectStore()`, so the active
project receives inserts.

| Method | Params | Result |
|---|---|---|
| `list_scrapbook_items` | `{ file? }` | `{ file, items: [{ id, name, description }] }` — read-only |
| `insert_scrapbook_item` | `{ itemId }` | `{ insertedObjIDs: string[] }` — paste a fragment into the active project |
| `save_selection_to_scrapbook` | `{ name?, description? }` | `{ itemId }` — save current selection as a new scrapbook item |

- `list_scrapbook_items`: pure headless read of `model.store.project.items`. Passing `file` (absolute path
  to a `.eez-scrapbook`) **switches the globally-loaded scrapbook file** for the whole app (persisted to
  localStorage) — that switch is the only side effect. `description` is nullable → defaults to `""`.
- `insert_scrapbook_item`: **PARTIAL / async fire-and-forget.** `insertItemIntoProject` returns void and the
  paste lands later inside a mobx reaction, so the bridge captures `insertedObjIDs` by diffing
  `project._objectsMap` before/after (new objIDs are freshly minted, disjoint from `before`). The paste is
  **already ONE combined undo step** on the active project (`doPaste` wraps `setCombineCommands`) — do NOT
  add another combine. **Conflict caveat:** if the fragment's asset names clash with the destination, EEZ
  pops a blocking resolve-conflicts modal with no headless auto-resolver — a conflicting insert can surface
  a dialog (pre-check via `PasteWithDependenciesModel.posteObjectsWithConflicts`, or document the limit).
  If objIDs can't be captured within the timeout, return `{ insertedObjIDs: [], note: "…" }` rather than
  failing.
- `save_selection_to_scrapbook`: **PARTIAL / async.** There is no direct "serialize selection → item" API;
  it goes through the OS clipboard: put the selection on the clipboard
  (`store.objectsToClipboardData` + `copyProjectEditorDataToClipboard`), `when(...)` `pasteModel`
  rebuilds `sourceProjectStore`, then `model.pasteIntoNewItem(...)` runs the dependency scan into a fresh
  empty store and adds the item. **This clobbers the user's EEZ clipboard** (snapshot/restore if that
  matters). Name/description are NOT create-path params — the UI always makes `"Item N"` with an empty
  description, so the bridge applies `params.name`/`params.description` **after** creation via
  `setItemName`/`setItemDescription`. The insert uses the `ScrapbookUndoManager`, NOT the project undo
  stack — it does not pollute project undo history. Because the destination is an empty project store, the
  conflict modal does not appear (a 250 ms progress dialog may briefly flash for large selections).

### Texts / i18n (undoable; addressed by `resourceID`/`languageID` strings)
The Texts feature is a **translation table**: `resources × languages`. Each `TextResource` (row, keyed by
`resourceID`) holds one translation `text` cell per `Language` (column, keyed by `languageID`). Widgets bind
to a resource by putting the `resourceID` in `text` with `textType:"translated-literal"` (the C build emits
`_(resourceID)`). All mutations go through the ProjectStore command/undo API. `list_*`/`export_texts` are
read-only.

**Prerequisite:** `project.texts` is an **optional feature that may be OFF** — every method below returns
`UNSUPPORTED` until you enable it with **`enable_feature { key: "texts" }`** (see *Settings & features*). Do
NOT expect a dedicated enable call; it is the generic feature toggle.

| Method | Params | Result |
|---|---|---|
| `list_languages` | — | `{ languages: [{ languageID, translated, total }] }` — `translated`=non-empty cells for that column, `total`=`resources.length` |
| `add_language` | `{ languageID }` | `{ languageID }` — `languageID` is unique |
| `list_text_resources` | `{ languageID? }` | `{ resources: [{ resourceID, translations: [{ languageID, text }], translated, total }] }` — `total`=`languages.length`; `languageID` projects to one cell |
| `add_text_resource` | `{ resourceID }` | `{ resourceID }` — `resourceID` is unique |
| `set_translation` | `{ resourceID, languageID, text }` | `{ resourceID, languageID, text }` — set one `(resource,language)` cell |
| `set_widget_text_resource` | `{ objID, resourceID }` | `{ objID, text, textType }` — sets `{ textType:"translated-literal", text:resourceID }` on the widget |
| `delete_language` | `{ languageID }` | `{ ok: true }` |
| `rename_language` | `{ languageID, newLanguageID }` | `{ languageID }` |
| `rename_text_resource` | `{ resourceID, newResourceID }` | `{ resourceID }` — see PARTIAL note |
| `delete_text_resource` | `{ resourceID }` | `{ ok: true }` |
| `import_texts` | `{ format, data, mode? }` | `{ languagesAdded, resourcesAdded, translationsSet }` |
| `export_texts` | `{ format }` | `{ data }` — serialized table (string) |

- **Asymmetric fan-out.** `add_language` auto-creates an **empty cell in every existing resource** (via the
  `Texts.languages` `interceptAddObject` hook) — one undo step. `add_text_resource` has **no** such hook, so
  the bridge itself seeds one `{ languageID, text:"" }` cell per current language (mirroring EEZ's `newItem`).
  Consequence: always add languages *before* resources in bulk flows so new resources inherit all columns.
- **Language delete/rename are fully hooked** (no dangling cells): `delete_language` cascades — a
  `deleteObjectRefHook` removes the whole column; `rename_language` — an `updateObjectValueHook` rewrites
  `languageID` in every cell. Each collapses to one undo step. `languageID` is never referenced by widgets,
  so no reverse-scan is needed.
- **`rename_text_resource` / `delete_text_resource` do NOT auto-fix widget bindings** (why `rename_text_resource`
  is **PARTIAL**). Widgets store the `resourceID` as a **plain string msgid** in `text`, and EEZ keeps no
  reverse index. `rename_text_resource` renames the row and scans `_objectsMap` to rewrite
  `translated-literal` widgets whose `text === oldID` (one combined undo step), but the scan is broad and
  string-based — verify against bound labels. `delete_text_resource` cascades its own cells but leaves bound
  widgets pointing at a now-missing msgid (surfaces as a CHECK error) — matching EEZ's own delete.
- `set_widget_text_resource`: only widgets that carry a text expression-property (Label, Textarea, Dropdown,
  Roller, Tab, Span, Checkbox) can bind; others return `UNSUPPORTED`. Leave `previewValue` alone (it is
  disabled in `translated-literal` mode). The resource must already exist (`NOT_FOUND` otherwise).
- `set_translation`: `NOT_FOUND` if the language has no cell in that resource (added out of order / hand-edited
  JSON) — the normal `add_language` fan-out prevents this.
- `import_texts`: `format` ∈ `csv|json|xliff` (XLIFF via `require("xliff")`); `mode` ∈ `merge` (default; only
  set provided cells) | `replace`. The whole import is **ONE undo step** (`setCombineCommands`), ordered
  languages→resources→cells. `export_texts`: `format` ∈ `csv|json|xliff`; pure read, no mutation.
- `translated`/`total` are **computed** coverage getters, not stored fields.

### Font & bitmap options (undoable; addressed by asset `name` — `list_font_glyphs` read-only, `export_bitmap` is an fs write)
Fine-grained edits to existing LVGL fonts and bitmaps, complementing `add_font`/`edit_font`/`add_bitmap`.
**Key rule:** changing what characters a font *contains* (ranges, symbols, additional sources) requires a
full **re-extract** (rerun `extractFont` + replace `Font.glyphs`) — a plain `updateObject` does NOT rebuild
glyphs/`embeddedFontFile`. `set_font_fallback` and `set_bitmap_options` are pure `updateObject` (they only
affect **build output**, never the editor glyph/pixel arrays), so they need no worker.

| Method | Params | Result |
|---|---|---|
| `set_font_ranges` | `{ fontName, ranges }` | `{ fontName, ranges }` — re-extract with new glyph ranges |
| `set_font_symbols` | `{ fontName, symbols }` | `{ fontName, symbols }` — re-extract with new symbol list |
| `list_font_glyphs` | `{ fontName }` | `{ glyphs: [{ encoding, width, height, dx }] }` — read-only |
| `add_font_additional_source` | `{ fontName, filePath, ranges?, symbols? }` | `{ fontName, sourceIndex }` — merge a second TTF/OTF's glyphs; re-extracts |
| `set_bitmap_options` | `{ bitmapName, bpp?, lvglBinaryOutputFormat?, lvglDither?, alwaysBuild?, style? }` | `{ bitmapName }` — plain `updateObject` |
| `set_font_fallback` | `{ fontName, fallbackFontName }` | `{ fontName, fallbackFontName }` — plain `updateObject`; `""` clears |
| `export_bitmap` | `{ bitmapName, filePath }` | `{ filePath }` — see PARTIAL note |

- **Re-extract tools** (`set_font_ranges`, `set_font_symbols`, `add_font_additional_source`) rerun the async
  `lv_font_conv` worker and splice the fresh glyph array in **one undo step** (same dance as `edit_font`).
  Ranges are validated up front (`BAD_PARAMS` on a malformed range string). Extraction failures surface as
  `UNSUPPORTED`.
- **LVGL-only + FreeType guard:** ranges/symbols/additional-sources/fallback are LVGL concepts (`NOT_LVGL` on
  a non-LVGL project). **FreeType** LVGL fonts have no editable glyphs — these tools return `UNSUPPORTED` for
  them.
- `add_font_additional_source`: requires **`ranges` OR `symbols`** for the added source (`BAD_PARAMS`
  otherwise) and requires the **primary** font to already have ranges/symbols (else the extractor can't build
  merged params). `filePath` is stored relative to the project. `sourceIndex` is the 0-based index into the
  font's additional-sources array. Additional sources share the primary font's size.
- `set_bitmap_options`: all props are plain persisted values (bitmap→binary conversion happens at build time),
  so this is a single `updateObject` — no re-convert. `bpp` accepts a numeric color-format id or a label (for
  LVGL, validated against the project's formats; non-LVGL: 16/32). `style` is meaningful only for non-LVGL,
  non-32bpp bitmaps (harmlessly stored otherwise). `lvglBinaryOutputFormat`/`lvglDither` are LVGL-only.
- `set_font_fallback`: `fallbackFontName` is a **free-form string** naming a generated LVGL font symbol (e.g.
  `lv_font_montserrat_24`), NOT an object reference — it is applied at build time (`--lv-fallback`) and cannot
  be validated from the store; any string (including `""` to clear) is accepted. Does NOT change the font's
  own glyph set, so no re-extract.
- `export_bitmap` is **PARTIAL**: a side-effecting `fs.writeFile` (NOT a store mutation, NOT undoable). For
  embedded `data:image/…` bitmaps it base64-decodes the stored bytes and writes them (format preserved — no
  re-encode; the `filePath` extension does not force conversion). For non-embedded (relative-path) bitmaps it
  copies the referenced source file. The caller supplies `filePath` (no save dialog).

### Settings & features (undoable except `set_zoom`; addressed by feature `key` / `importAs` / config `name`)
Project-level toggles: enable/disable optional **features**, manage cross-project **imports** and **build
configurations**, set the **readme** file, and control editor **zoom**. Features are Project *object
properties* (presence ⇔ enabled) — enable/disable go through `updateObject(project, {[key]: obj|undefined})`,
NOT array splicing. `list_features` is read-only; `set_zoom` is transient UI state (NOT on the undo stack).

| Method | Params | Result |
|---|---|---|
| `list_features` | — | `{ features: [{ key, displayName, enabled, mandatory }] }` |
| `enable_feature` | `{ key }` | `{ key, enabled: true }` — idempotent; uses the feature's own default seed |
| `disable_feature` | `{ key }` | `{ key, enabled: false }` — idempotent; `UNSUPPORTED` if mandatory |
| `add_project_import` | `{ projectFilePath, importAs? }` | `{ objID }` — adds an `ImportDirective` to `settings.general.imports` |
| `remove_project_import` | `{ importAs? \| projectFilePath? }` | `{ deleted: true }` |
| `add_build_configuration` | `{ name }` | `{ objID, name }` — adds a `BuildConfiguration` to `settings.build.configurations` |
| `set_zoom` | `{ mode?, level?, page? }` | `{ zoom }` — see PARTIAL note |
| `set_readme` | `{ readmeFile }` | `{ ok: true }` — see feature-object note |

- **Feature `key`s:** `userPages, userWidgets, actions, variables, styles, lvglStyles, fonts, bitmaps, texts,
  extensionDefinitions, scpi, instrumentCommands, shortcuts, micropython, changes, readme, lvglGroups`.
  `enable_feature` seeds the sub-object via the feature's own `create()` (do not hand-roll seeds) and is one
  undo step. This is the gate for the *Texts / i18n* tools above (`enable_feature { key:"texts" }`).
- **Effective `mandatory` is project-type dependent** (not just the base flag): on **LVGL**,
  `fonts/bitmaps/lvglStyles/lvglGroups` are mandatory; on **IEXT**, `extensionDefinitions` is mandatory and
  `scpi`/`instrumentCommands` are mandatory per `commandsProtocol` (`SCPI`/`PROPRIETARY`). `disable_feature`
  enforces this (`UNSUPPORTED` when mandatory).
- **`disable_feature` cascade:** disabling `extensionDefinitions` also nulls `scpi`, `instrumentCommands`, and
  `shortcuts` in the **same** `updateObject` (one undo step) — matching the GUI; skipping this would orphan
  those objects.
- `add_project_import`: `importAs` is unique (`BAD_PARAMS` on collision); `projectFilePath` is stored relative
  to the project. **Rejected (`UNSUPPORTED`)** for master-project / applet / IEXT projects. `remove_project_import`
  resolves by `importAs` (preferred) or `projectFilePath`. Removing an import leaves cross-project references
  dangling (CHECK errors) — matching EEZ.
- `add_build_configuration`: `name` is unique. The array exists for all non-dashboard projects (it is merely
  *hidden* in the LVGL tree, not absent), so this is allowed on LVGL too.
- **`set_readme` targets a FEATURE object, not `settings.general.readme`** (which does not exist). Readme is
  the `readme` feature (`project.readme.readmeFile`). `set_readme` auto-enables the `readme` feature if absent
  then sets `readmeFile` (relative path) — all in one combined undo step.
- **`set_zoom` is PARTIAL and NOT an undo step** — it writes editor **UI state** (`uiStateStore.flowZoom` +
  the active page editor's transform), never `updateObject`. `mode` ∈ `level` (numeric `level`, `1.0`=100%) |
  `center` | `reset`/`fit-reset` | `fit`. `level`/`center`/`reset` are robust; **`fit`** needs a mounted
  editor viewport (`transform.clientRect`) and returns `UNSUPPORTED` when none is measured yet (headless /
  just-opened). Pass `page` to focus a page editor first; `NO_PROJECT` if there is no active page editor.

### Simulator / Run mode (LVGL-WASM, F5 — transient RUNTIME state, NONE are undo commands)
Run mode creates/destroys a `RuntimeBase` on `store.runtime` and flips mobx observables. **None of these go
through `updateObject`/`addObject`/`deleteObject`; none are on the undo stack**; `undo`/`redo` will not (and
must not) reverse Run mode. "Is the simulator running?" ≡ `store.runtime != undefined` (there is no
`isRuntimeMode` getter). For LVGL this runtime is a live `WasmRuntime` — a **different** WASM module from the
static editor preview that `render_page` reads (do not conflate `store.runtime` with `page._lvglRuntime`).
Start/stop are **async and 300 ms-debounced** (the first call in a 300 ms window runs immediately, a second is
coalesced); after calling them, poll `store.runtime`/`runtime.state` rather than assuming synchronous
completion. None require a mounted editor DOM — the worker runs and frames accrue in `runtime.lastScreen`
headlessly.

| Method | Params | Result |
|---|---|---|
| `run_simulator` | `{ debugger?=false }` | `{ running, mode: "runtime"\|"debugger", selectedPage: string\|null }` — enter Run mode (F5); `store.setRuntimeMode(...)` |
| `stop_simulator` | — | `{ running: false, mode: "editor" }` — return to editor (Shift+F5); `store.onSetEditorMode()`; idempotent |
| `get_simulator_status` | — | `{ running, isDebugger, isPaused, selectedPage, error, state? }` — pure read of `store.runtime` observables |
| `screenshot_simulator` | — | `{ png, width, height, source: "simulator" }` — capture the LIVE running frame |
| `pause_simulator` | — | `{ isPaused: true }` — flow-debugger only (see gating) |
| `resume_simulator` | — | `{ isPaused: false }` — flow-debugger only (see gating) |
| `step_simulator` | `{ kind: "step-into"\|"step-over"\|"step-out" }` | `{ selectedPage, isPaused }` — flow-debugger only (see gating) |

- `run_simulator`: returns before frames arrive (worker boot is async) — poll `store.runtime && !runtime.error`.
  `selectedPage` defaults to `project.pages[0]`. **`debugger` is meaningless for no-flow LVGL** (no flow queue to
  step): the bridge ignores it and starts `setRuntimeMode(false)`, surfacing a note. `UNSUPPORTED` if the project
  type has no runtime (`runtimeType === NONE`). If the build has errors, `doStartRuntime` aborts back to editor —
  `store.runtime` is nulled and `error` set; surface it.
- `stop_simulator`: idempotent (`{ running:false, mode:"editor" }` when already stopped). Mirrors the Shift+F5
  handler exactly; poll `store.runtime === undefined` (the worker `terminate()` is async). Same 300 ms debounce —
  a `stop` within 300 ms of `run` is coalesced but eventually applies.
- `get_simulator_status`: synchronous. Fields: `running` = `!!store.runtime`; `isDebugger` =
  `runtime.isDebuggerActive`; `isPaused` = `runtime.isPaused` (`state === PAUSED`); `selectedPage` =
  `runtime.selectedPage.name`; `error` = `runtime.error`; optional `state` ∈
  `STARTING\|RUNNING\|PAUSED\|STOPPED\|…`.
- `screenshot_simulator`: reads the **Run-mode** framebuffer, not the editor preview. Prefers the live painted
  canvas (`runtime.ctx.canvas`, identical read to `render_page`) when a `WasmCanvas` is mounted; otherwise encodes
  `runtime.lastScreen` (already `ImageData`-ready RGBA — no BGRA fix) headlessly onto an offscreen canvas at
  `runtime.displayWidth × displayHeight`. Errors (`BAD_STATE`) if the simulator is not running, or `INTERNAL` if no
  frame has arrived yet (ensure ≥1 frame; poll `runtime.lastScreen != null`). Captures the whole **display**
  (page blitted centered), not just the page rect. `png` is raw base64 (no `data:` prefix), wrapped by MCP as an
  image content block. Last-resort fallback (WITHOUT live runtime state): `render_page(runtime.selectedPage.name)`.
- **`pause_simulator`/`resume_simulator`/`step_simulator` are flow-debugger controls — PARTIAL, effectively N/A
  for no-flow LVGL.** They gate the flow **queue**; a no-flow LVGL project has none (`hasFlowSupport` is false),
  so they return **`UNSUPPORTED`** with a clear "flow-debugger feature; nothing to pause / no flow queue to step"
  message (they do **not** silently no-op). On flow projects they call `runtime.pause()` /
  `runtime.resume()`/`toggleDebugger()` / `runtime.runSingleStep(kind)`; the effect is a fire-and-forget worker
  message, so `isPaused`/`selectedPage` settle after the worker acknowledges — poll for the settled value.
  `step_simulator` additionally requires the debugger to be **paused** (`BAD_STATE` otherwise) and validates `kind`
  (`BAD_PARAMS` on anything but `step-into`/`step-over`/`step-out`).

### Build operations (non-simulator; NONE are undo commands)
Drive EEZ's real Generate/Build pipeline (`ProjectEditor.build.buildProject(store, option)`). Errors are recorded
into `Section.OUTPUT` (they are **not thrown**) — inspect `store.outputSectionsStore.getSection(Section.OUTPUT).numErrors`.
None of these are undo/project mutations: `build_assets` is in-memory compute (touches only `Section.OUTPUT`);
`set_build_configuration` writes **UI state** (persisted ui-state, not undo, does not mark the project modified);
`open_build_folder` is an **OS-shell side effect**; the rest are pure reads.

| Method | Params | Result |
|---|---|---|
| `build_assets` | — | `{ ok, durationMs, parts, errors: Problem[], warnings: Problem[] }` — in-memory LVGL asset build (writes NO files) |
| `get_build_destination` | — | `{ relative, absolute, exists }` — resolve the build output folder |
| `open_build_folder` | — | `{ opened, path }` — reveal the build folder in the OS file manager (PARTIAL, not headless) |
| `list_build_configurations` | — | `{ configurations: [{ name, description, screenOrientation }], selected, selectedName }` |
| `set_build_configuration` | `{ name }` | `{ selected }` — select which configuration subsequent builds use |

- `build_assets`: `await store.buildAssets()` = `buildProject(store, "buildAssets")` — assembles `parts` in memory
  and **returns before the file-writing branch**, so nothing is written to disk (distinct from `build`, which uses
  `"buildFiles"` and writes C sources). For a no-flow LVGL build `parts` carries `GUI_ASSETS_DATA` (a Node
  `Buffer`), `GUI_ASSETS_DATA_MAP` (JSON string), `GUI_ASSETS_DATA_MAP_JS` (JS object); C-source/enum/flow sections
  are gated off in this mode and absent. **The raw `Buffer` is never returned over JSON** — the result summarizes
  it (key list, `GUI_ASSETS_DATA` byte length, and the `_MAP_JS` object). Treat a falsy return as failure and read
  `numErrors` from `Section.OUTPUT`. Async.
- `get_build_destination`: synchronous pure read. `relative` = `settings.build.destinationFolder || "."`;
  `absolute` = `store.getAbsoluteFilePath(relative)`; `exists` = `fs.existsSync(absolute)`.
- `open_build_folder`: **PARTIAL — an OS-shell side effect that opens a Finder/Explorer window; not headless.**
  `require("electron").shell.openPath(absolute)` (`""` resolves on success, a non-empty error string ⇒
  `opened:false`; a missing folder resolves with an error string). If you only need the path, use
  `get_build_destination` (opens no window). Async.
- `list_build_configurations`: pure read. `configurations` from `settings.build.configurations`; `selected` is the
  **resolved** selection via `store.selectedBuildConfiguration` (honors the `configurations[0]` fallback);
  `selectedName` is the raw persisted ui-state value (may name a config that no longer exists).
- `set_build_configuration`: `store.uiStateStore.setSelectedBuildConfiguration(name)` — **UI state, NOT an undo
  step, does not mark the project modified**. The raw setter accepts any string, so the bridge validates `name`
  against `configurations[].name` and throws **`NOT_FOUND`** for an unknown name (rather than silently falling back
  to `configurations[0]`). A subsequent `build_assets`/`build` consumes this selection. Synchronous.

### Build-file code-generation templates (the two write tools ARE undo commands — ONE step each)
The per-file codegen templates at `settings.build.files[N]` are the **source** the LVGL/codegen pipeline expands
into the generated files (e.g. `ui.c`, `screens.c`). Editing the *generated* file is lost on the next rebuild —
the template is the correct edit target. Each `BuildFile` is an `EezObject` with `{ fileName, template, objID }`;
the write tools go through `store.updateObject(file, { template })`. Address a build file by `fileName` (unique),
`index`, or `objID` (as returned by `list_build_files` / `search_project`).

| Method | Params | Result |
|---|---|---|
| `list_build_files` | — | `{ files: [{ index, fileName, objID, templateLength }] }` — READ |
| `get_build_file` | `{ fileName \| index \| objID }` | `{ index, fileName, objID, template }` — READ, full template text |
| `set_build_file_template` | `{ fileName \| index \| objID, template }` | `{ index, fileName, objID, templateLength }` — replace the whole template (**ONE undo step**) |
| `patch_build_file_template` | `{ fileName \| index \| objID, find, replacement, matchCase?, expectedCount? }` | `{ index, fileName, objID, replacedCount, changed }` — literal find/replace inside one template (**ONE undo step**) |
| `set_ext_click_area` | `{ identifier \| objID, size, fileName? }` | `{ fileName, objID, identifier, size, active: [{ identifier, size }] }` — set a widget's LVGL extended click/touch area (**ONE undo step**) |

- `list_build_files` / `get_build_file`: pure reads over `store.project.settings.build.files`. `templateLength` is a
  size hint so you can skip fetching a large template you don't need.
- `set_build_file_template`: `store.updateObject(file, { template })` — the whole template is replaced. One undo step.
- `patch_build_file_template`: **literal** (non-regex) find/replace, **case-sensitive by default** (code is
  case-sensitive; pass `matchCase:false` to fold case). `expectedCount`, if given, throws **`BAD_PARAMS`** unless
  exactly that many occurrences are found (guards a blind edit); `0` matches ⇒ no write, `changed:false`. One undo step.
- **Use these instead of `replace_in_project`** for generated-code customization (e.g. changing the global
  screen-load animation `lv_scr_load_anim(screen, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false)` → `…_NONE, 0`, adding an
  include, tweaking the `loadScreen`/`ui_tick` boilerplate). EEZ's `canReplace()` excludes template bodies, so
  `replace_in_project` cannot write them (it reports them in `skipped`).
- `set_ext_click_area`: sets a widget's LVGL **extended click / touch area** (`size` px added on all sides).
  EEZ has **no model property** for this (only the runtime call `lv_obj_set_ext_click_area`), so it is injected
  as a self-managed block in the `ui.c` template — a `static` helper that runs
  `lv_obj_set_ext_click_area(objects.<identifier>, size)` once the object exists, called from `ui_tick()` (works
  for flow + no-flow, any creation timing; survives rebuilds). Address the widget by `identifier` (its C name) or
  `objID` (resolved to its identifier — the widget **must** have one); **`size:0` removes** it. Re-running for the
  same identifier updates it (no duplicate). `store.updateObject(uiFile, { template })` — **one undo step**.

### Full simulator (Docker) & export (NONE are undo commands; project-type / Docker gated)
The F7 full simulator runs an Emscripten build inside **Docker Desktop** and serves it over a local loopback HTTP
`PreviewServer` into an iframe (it is **not** noVNC). `export_dashboard` and `build_extensions` reuse the same
build function as `build`/`build_assets`. None touch the undo stack; all are async; errors land in `Section.OUTPUT`
(not thrown). The full-sim mode flag (`isDockerSimulatorMode`) and preview URL are observable mobx/runtime state.

| Method | Params | Result |
|---|---|---|
| `start_full_simulator` | `{ forceRebuild?=false }` | `{ mode, previewUrl, building, state, error }` — start F7 Docker sim (PARTIAL, needs Docker) |
| `stop_full_simulator` | — | `{ mode: "editor" }` — tear down the Docker sim + containers; safe/idempotent |
| `export_dashboard` | — | `{ filePath, ok }` — write `<base>.eez-dashboard` (Dashboard projects only) |
| `build_extensions` | `{ install?=false }` | `{ built, extensionFilePaths, installed? }` — build IEXT `.zip` files (IEXT/INSTRUMENT only) |

- **`start_full_simulator` is PARTIAL — not headless.** It needs (1) Docker Desktop running, (2) the
  `resources/docker-build` files, (3) a **saved** project, and (4) an Emscripten build (minutes). Gate: **`NOT_LVGL`**
  if not LVGL; **`UNSUPPORTED`** if `settings.build.useDockerDesktop` is off (tell the caller to enable "Use Docker
  Desktop", or set it via `update_settings`) or if the project is unsaved. When gates pass it drives
  `dockerBuildManager.startFullSimulator(store, forceRebuild)` (the F7 button itself does **not** pass
  `forceRebuild`) and reads the per-project observable state (`dockerBuildState.getProjectState(store.filePath)`):
  `previewUrl` (a real `http://127.0.0.1:<port>` URL, set only when `state === "running"`), `building` =
  `state === "building"`, plus `state`/`error`. It **swallows Docker failures into project state** (does not throw)
  — surface `error`/`state`. **Headless screenshot path for the running UI is `render_page`**, not this preview
  (the preview canvas lives in a cross-context iframe the bridge cannot `toDataURL`); report `previewUrl` for
  external tooling (Playwright etc.).
- `stop_full_simulator`: **safe idempotent teardown** — works even when Docker never started (no-op). Uses
  `dockerBuildManager.stopFullSimulator(store.filePath)` (the **hard-stop** path: cancels an in-progress build +
  stops running containers + stops the preview server, vs. `leaveFullSimulatorUI` which leaves the Docker build
  running), then flips `isDockerSimulatorMode = false`. Returns `{ mode: "editor" }` unconditionally.
- **`export_dashboard` is fully headless but Dashboard-gated.** `await buildProject(store, "buildFiles")` takes the
  `isDashboard` branch and writes `<destinationAbs>/<base>.eez-dashboard` (a level-9 ZIP containing the
  `.eez-project` JSON) — no Docker, no dialog. **`UNSUPPORTED` on a non-Dashboard project** (an LVGL project hits
  this guard — its `"buildFiles"` branch writes C sources, never a dashboard); **`NOT_SAVED`** if unsaved. `base`
  = `path.basename(store.filePath, ".eez-project")`; `dest` = `getAbsoluteFilePath(destinationFolder || ".")`;
  `ok` from `Section.OUTPUT.numErrors === 0`.
- **`build_extensions` build is fully headless; `install` mutates the global extension registry (opt-in).**
  `await ProjectEditor.build.buildExtensions(store)` writes IDF `.zip` files and returns their absolute paths;
  with **no buildable `extensionDefinitions`** it returns `[]` with a `"Nothing to build!"` OUTPUT message (not an
  error). Buildable extensions live on **IEXT/INSTRUMENT** projects; an LVGL project yields `{ built:false,
  extensionFilePaths:[] }` (`reason:"nothing_to_build"`). `install:true` additionally runs `installExtension` on
  each built zip (auto-approving replace prompts — no blocking dialog, mirroring `buildAndInstallExtensions`),
  registering them in the shared extensions store; `installed` lists the installed paths (omitted when
  `install` is false).

### Flow components (place / edit / remove action components; ALL undoable — each is ONE undo step)
A **flow** lives on a `Page` OR an `Action` (both `extends Flow`), and its executable nodes are
`flow.components` (`Component[]`), wired by `flow.connectionLines`. These tools are the flow analogue of the
§4 Edit widget tools: every mutation goes through `ProjectStore.addObject/updateObject/deleteObject`, so each
is a real undo command (unlike the editor/nav/simulator ops above). A flow is addressed by **`page`** name OR
**`action`** name (exactly one); components are addressed by `objID`. **`type` is the registered class name**
(e.g. `"SetVariableActionComponent"`, `"StartActionComponent"`) — NOT a friendly palette label.

| Method | Params | Result |
|---|---|---|
| `create_flow_component` | `{ page? \| action?, type, left?, top?, props? }` | `{ objID }` — seed = `getDefaultValue` + `componentDefaultValue` + `{type, left, top, width:0, height:0, ...props}`, then `addObject(flow.components)` |
| `list_flow_components` | `{ page? \| action? }` | `{ components: [{ objID, type, label, left, top, isWidget }] }` — `flow.components` holds BOTH widgets and action components |
| `list_flow_component_types` | `{ group?, search? }` | `{ types: [{ name, group, label, inputs, outputs }] }` — placeable ActionComponent classes (palette-filtered) |
| `get_flow_component` | `{ objID }` | `{ component: { objID, type, props, inputs, outputs, left, top, connections } }` — `connections` = `{ incoming, outgoing }` |
| `set_component_props` | `{ objID, props }` | `{ objID }` — `updateObject(component, props)` (e.g. `expression`, `entries`, `value`) |
| `move_flow_component` | `{ objID, left?, top? }` | `{ objID }` — `updateObject({left, top})`; width/height are auto-sized and ignored |
| `delete_flow_component` | `{ objID }` | `{ deleted }` — auto-removes attached connection lines + group membership |
| `set_catch_error` | `{ objID, on }` | `{ objID, catchError }` — toggles the `@error` output |
| `create_component_group` | `{ page? \| action?, name, componentIDs? }` | `{ objID }` — `componentIDs` are component **objID strings** |

- **`create_flow_component` seed recipe (mirrors the palette exactly):** `getDefaultValue(store, cls.classInfo)`
  + `cls.classInfo.componentDefaultValue(store)` (if present), then set `type` = the registered class name,
  `left`/`top` (default 0), force `width:0`/`height:0` if unset, then overlay `props`. **The seed MUST include
  the class defaults** or some components load wrong (e.g. `SetVariableActionComponent` needs `entries:[{}]`).
  `type` resolves via `findClass(type)` → `NOT_FOUND` on an unknown class. Per-type required `props`:
  `InputActionComponent` `{name, inputType}`; `OutputActionComponent` `{name, outputType}`;
  `EvalExprActionComponent` `{expression}`; `SetVariableActionComponent` `{entries:[{variable, value}]}`;
  `ConstantActionComponent` `{value}`. `CallActionActionComponent` is **excluded from the generic palette** and
  created explicitly with `type:"CallActionActionComponent"`, `props:{action:"<actionName>"}`.
- **ActionComponents auto-size** (`autoSize:"both"`) — only `left`/`top` position them; width/height are
  recomputed from the rendered body. On an LVGL page the ActionComponent goes **directly into `flow.components`**
  (alongside the screen widget), NOT under the LVGL screen widget's `children` (that path is for widgets).
- **Ports are instance-computed** via `getInputs()`/`getOutputs()` getters — `list_flow_component_types` builds a
  throwaway proto to enumerate them, and `get_flow_component` reads the live getters. Most action components
  expose the sequence exec ports `@seqin` (input) / `@seqout` (output); data ports are named per component.
  `StartActionComponent` has only `@seqout`; `EndActionComponent` only `@seqin`.
- `list_flow_component_types`: enumerates `getAllComponentClasses(store, ActionComponentClass)` with the palette's
  `enabledInComponentPalette` gate + grouping. On LVGL/firmware it lists stock flow actions only when the project
  **has flow support** (see the flowSupport note below); `group`/`search` narrow the list.
- **`delete_flow_component` is a clean cascade:** `Component.deleteObjectRefHook` auto-runs
  `flow.deleteConnectionLines(component)` (drops every wire touching it) and `flow.removeComponentFromGroups`
  (pulls its objID from any `ComponentGroup`, deleting the group if it becomes empty) — all coalesced into **one
  undo step**. No manual wire scrub needed.
- **`set_catch_error`:** `catchError` is an observable boolean on `Component`; `on:true` adds an `@error` output
  (a `string` port). `on:false` fires `updateObjectValueHook` → `flow.deleteConnectionLinesFromOutput(component,
  "@error")`, auto-removing wires off the `@error` port. One undo step.
- **`create_component_group`:** `ComponentGroup.components` is an array of component **objID strings** (not object
  refs), and `description` is the group's display name. Membership resolves against `flow.components` and silently
  drops unknown ids — the bridge pre-validates every id is in THIS flow (`BAD_PARAMS` otherwise). Membership
  survives moves within the flow but NOT reparenting to another flow.
- **flowSupport gate:** `Page`/`Action` always expose `components`/`connectionLines` arrays regardless of
  `flowSupport`, but placing ActionComponents is only *meaningful* (palette + validation + codegen treat them as
  executable) when `settings.general.flowSupport = true`. On LVGL/firmware, `hasFlowSupport` === that boolean;
  Dashboard forces it true. Flip `flowSupport=true` (via `update_settings`) to make LVGL pages/actions usable flows
  — a Dashboard project is NOT required.

### Flow connections & ports (wires + custom ports + flow-type events; ALL undoable — each is ONE undo step)
Wire components together and add per-component custom ports. **ConnectionLine stores component `objID` strings,
NOT object refs**: `source`/`target` are the endpoint components' `objID`s, and `output`/`input` are the **port
name strings**. An **exec (sequence) wire** uses `output:"@seqout"`, `input:"@seqin"`; a **data wire** uses real
port names. Port validation is against the **merged `component.inputs`/`component.outputs` getters** (which
include built-in `@seqin`/`@seqout`/`@error` + custom ports), never the raw `customInputs`/`customOutputs` arrays.

| Method | Params | Result |
|---|---|---|
| `connect_components` | `{ source, output, target, input }` | `{ objID }` — `source`/`target` are component objIDs; `output`/`input` are port names |
| `disconnect_components` | `{ objID }` \| `{ source, output, target, input }` | `{ deleted }` — by line objID or by matching tuple |
| `list_flow_connections` | `{ page? \| action? }` | `{ connections: [{ objID, source, output, target, input, disabled, label, sourceLabel, targetLabel, outputLabel, inputLabel }] }` |
| `update_flow_connection` | `{ objID, disabled?, description? }` | `{ objID }` — only `disabled`/`description` are editable |
| `add_component_input` | `{ objID, name, type }` | `{ objID, input }` — appends a `CustomInput` to `component.customInputs` |
| `add_component_output` | `{ objID, name, type }` | `{ objID, output }` — appends a `CustomOutput` to `component.customOutputs` |
| `delete_component_port` | `{ objID, port, direction }` | `{ objID, deleted }` — `direction` ∈ `input\|output`; auto-removes attached wires |
| `bind_flow_event` | `{ objID, event, userData? }` | `{ objID, output }` — adds a **flow-type** EventHandler, exposing `event` as a connectable output |

- `connect_components`: mirrors EEZ's own `flow-document.connect()` — validates both components live in the SAME
  flow, both ports exist (against the merged getters), and rejects an exact duplicate wire (`BAD_PARAMS`).
  Type-incompatibility is only a WARNING (surfaces via `run_checks`), not a hard error. Both exec and data wires
  use the same path. One `addObject` = one undo step.
- `disconnect_components`: by line `objID` (direct), or by `{source,output,target,input}` tuple (resolved + matched
  in the flow; `NOT_FOUND` if no match). A line owns nothing, so no cascade — one undo step.
- `list_flow_connections`: pure read. `source`/`target` are component objIDs; `output:"@seqout"`/`input:"@seqin"`
  mark exec wires. Human labels reuse EEZ's own label logic; `sourceLabel`/`targetLabel` may be `null` if a
  referenced objID is missing (dangling wire).
- `add_component_input`/`add_component_output`: seed `{name, type}` where `type` is a valid `ValueType` string
  (`integer`, `float`, `double`, `boolean`, `string`, `any`, `array:<T>`, `struct:<Name>`, `enum:<Name>`).
  Uniqueness is checked against the **merged** `component.inputs`/`outputs` list (`BAD_PARAMS` on a dupe). This
  makes the port connectable; it does NOT auto-wire anything. One undo step.
- **`delete_component_port` auto-removes attached wires:** deleting a `CustomInput` fires `deleteObjectRefHook` →
  `flow.deleteConnectionLinesToInput`; deleting a `CustomOutput` → `deleteConnectionLinesFromOutput`. Because the
  hook issues extra `deleteObject` calls, the whole op is wrapped in `setCombineCommands(true)…finally(false)` →
  **one undo step**. Only **custom** ports are deletable — built-in ports (`@seqin`/`@seqout`/`@error`/`@widget`
  or definition ports) aren't in the custom arrays, so they yield `NOT_FOUND` (correct).
- **`bind_flow_event`** is the FLOW-type sibling of §4 `bind_event` (which creates an *action*-type handler): it
  adds an `EventHandler` with `handlerType:"flow"` and **no `action` field** to `widget.eventHandlers`. A Widget's
  `getOutputs()` appends one output per flow-type handler, so after binding, `event` becomes usable as a
  `connect_components` **source output** on that widget. Idempotent per `(event, flow)`. `userData` defaults to 0.
  Valid `event` values come from the widget's `widgetEvents` catalog (e.g. LVGL `CLICKED`, `VALUE_CHANGED`); an
  unknown event may be flagged by `run_checks`. To UNBIND, delete the handler — its output wires are auto-removed
  via `deleteObjectRefHook`.

### Flow variables & interface (local variables + public IO; ALL undoable — each is ONE undo step)
Per-flow **local variables** (`flow.localVariables`, reusing the same `Variable` class as globals) plus the
flow's **public interface**. **Page-vs-action asymmetry (load-bearing):** a PAGE's public IO is `UserProperty[]`
in `flow.userProperties` (only meaningful for user widgets / actions; `assignable:false` ⇒ input-like,
`assignable:true` ⇒ output-like / writable-back — there is no explicit direction field). An ACTION's public IO is
`InputActionComponent`/`OutputActionComponent` **instances living in `action.components`**, surfaced via the
`inputComponents`/`outputComponents` getters (sorted by `top`). Never put an `InputActionComponent` on a page or a
`UserProperty` on an action.

| Method | Params | Result |
|---|---|---|
| `list_flow_variables` | `{ page? \| action? }` | `{ variables: [{ name, type }] }` — `flow.localVariables` |
| `add_flow_variable` | `{ page? \| action?, name, type, defaultValue? }` | `{ name }` (`+objID`) — `defaultValue` is a **string expression** (e.g. `"0"`, `"true"`) |
| `update_flow_variable` | `{ page? \| action?, name, props }` | `{ name }` (`+objID`) — rename is NOT ref-safe (see note) |
| `delete_flow_variable` | `{ page? \| action?, name }` | `{ deleted }` — no ref-hook; inbound refs dangle (CHECK errors) |
| `list_flow_interface` | `{ page? \| action? }` | `{ inputs: [{ name, type, … }], outputs: [{ name, type, … }] }` |
| `add_flow_input` | `{ page? \| action?, name, type, assignable? }` | `{ name }` — page: `+id,+objID`; action: `+objID` |
| `add_flow_output` | `{ page? \| action?, name, type }` | `{ name }` — page: `+id,+objID`; action: `+objID` |
| `list_action_flows` | — | `{ actions: [{ name, implementationType, inputs: [{ name, type }], outputs: [{ name, type }] }] }` |

- **Name uniqueness is flow-wide across user-properties + local-variables** (`uniqueForVariableAndUserProperty`) —
  adding a local variable OR a user property checks BOTH `flow.userProperties` and `flow.localVariables`
  (`BAD_PARAMS` on collision). `type` is validated with `isValidType` (EEZ ValueType syntax). `add_flow_variable`
  runs `migrateType` on load; `defaultValue` must be the **source-expression string**, not a raw JS value.
- **`update_flow_variable` rename is NOT reference-safe** — a local variable is referenced by bare `name` in flow
  expressions, which `updateObject({name})` does not rewrite. The bridge wraps `replaceObjectReference` +
  `updateObject` in one combined undo step (or rejects rename with `UNSUPPORTED`, matching `update_variable`).
  Non-rename prop edits (`type`, `defaultValue`, `description`, `persistent`) are a plain one-step `updateObject`.
- **`delete_flow_variable` has no `deleteObjectRefHook`** — inbound expression references are left dangling and
  surface as CHECK errors (identical to the §4 `delete_variable` behavior).
- `list_flow_interface` / `add_flow_input` / `add_flow_output` dispatch on flow kind. **PAGE:** a `UserProperty`
  (seed an explicit `guid()` `id` — `userPropertyValues` keys off it); `add_flow_input` seeds `assignable:false`,
  `add_flow_output` seeds `assignable:true`. **ACTION:** an `Input`/`OutputActionComponent` added to
  `action.components` with the geometry/discriminator seed (`type` = the registered class name,
  `left`/`top`/`width`/`height`, staggering `top` so `inputComponents`/`outputComponents` order is deterministic).
  The exec pins `@seqout` (on an input) / `@seqin` (on an output) are **computed**, not seeded — wiring them is a
  `connect_components` op.
- `list_action_flows`: reads `project.actions`; flow-implemented actions expose IO via
  `inputComponents`/`outputComponents`, native actions report empty IO (their only pins are `@seqin`/`@seqout`).
  For `CallAction` wiring, the wire pin key is the target IO component's **objID**, not its display name.

### Flow reactive & misc (reactive widget flags/states + flow render + build-index lookup)
Reactive LVGL widget props (expression-bindable flag/state counterparts) plus a flow graph dump and a build-index
component lookup. `set_reactive_flag`/`set_reactive_state` are plain `updateObject` (ONE undo step, LVGL-only);
`render_flow` and `find_component` are **reads / no undo**.

| Method | Params | Result |
|---|---|---|
| `set_reactive_flag` | `{ objID, flag, value, type? }` | `{ objID }` — `flag` ∈ `HIDDEN\|CLICKABLE`; writes `<flag>Flag` + `<flag>FlagType` |
| `set_reactive_state` | `{ objID, state, value, type? }` | `{ objID }` — `state` ∈ `CHECKED\|DISABLED`; writes `<state>State` + `<state>StateType` |
| `render_flow` | `{ page? \| action? }` | `{ unsupported, flow, components: [{ objID, type, left, top, width, height, label }], connectionLines: [{ source, output, target, input }] }` — **data graph, NOT a PNG** |
| `find_component` | `{ componentPath }` | `{ found, objID, path?, flow?, type? }` — `componentPath` is `"flowIndex.componentIndex"` (build-dependent) |

- **`set_reactive_flag`/`set_reactive_state`** are the expression-bindable siblings of §4 `set_flag`/`set_state`
  (which toggle the static `widgetFlags`/`states` token strings). They target the `LVGLWidget` reactive props
  and write **both** the value prop and its `*Type` sibling in one `updateObject`. The `*Type` name is exact
  string concatenation: `hiddenFlag`→`hiddenFlagType`, `clickableFlag`→`clickableFlagType`,
  `checkedState`→`checkedStateType`, `disabledState`→`disabledStateType`. Only two legal `type` values:
  **`"literal"`** (`value` is a boolean) or **`"expression"`** (`value` is an EEZ expression string) — `type`
  defaults to `"literal"`; anything else (incl. `"translated-literal"`) is `BAD_PARAMS`.
  - Only **HIDDEN/CLICKABLE** (flags) and **CHECKED/DISABLED** (states) have reactive counterparts — any other
    token is `set_flag`/`set_state` only and rejected here (`BAD_PARAMS`).
  - `checkedState` is **assignable**: an `"expression"` binding must be a writable lvalue (variable/struct field),
    since EEZ emits a write-back on the widget's `VALUE_CHANGED`. The bridge cannot validate lvalue-ness — pass
    through and rely on checks. `disabledState` (and both flags) are input-only.
  - The static token (`set_flag HIDDEN`) and the reactive prop (`hiddenFlag`) are **different backing fields** and
    can coexist on the same widget; the bridge does not reconcile them (mirrors EEZ). An `"expression"` binding
    only ticks at runtime with flow support, but a `"literal"` value builds fine in any LVGL project — not gated.
- **`render_flow` returns DATA, not a PNG.** The flow editor is an **SVG DOM**, not an LVGL-WASM 2D canvas, so
  there is no framebuffer to capture (unlike `render_page`). The result is the honest wire-graph — `components`
  (with geometry + label) and `connectionLines` (endpoint objIDs + port names) — plus an `unsupported` note
  explaining there is no rasterizer. Do not expect an image content block.
- **`find_component` is build-dependent.** `flowIndex`/`componentIndex` are **build-time indices**, not persisted
  on the live store, so the bridge runs `store.buildAssets()` (in-memory, writes no files) to get the assets map,
  indexes `map.flows[flowIndex].components[componentIndex].path` (an EEZ string path), then
  `getObjectFromStringPath` → the object's `objID`. `componentPath` is the index pair `"flowIndex.componentIndex"`
  (NOT a slash path — do not feed it to `getObjectFromStringPath` directly). Indices reflect build component
  order and may be stale after edits, so the build is run fresh each call. On hit it optionally selects the object
  via `showObjects` (navigation side-effect, no undo); returns `{ found:false, objID:null }` on miss. If the build
  produces no map, `found:false` with a `reason` pointing at the build output.

### Instrument & dashboard features (SCPI · instrument commands · MicroPython · shortcuts · extension definitions; undoable, feature-gated)
These five are optional Project *features* — each is a Project object-property that is `undefined` until
enabled with **`enable_feature { key }`** (see *Settings & features*): `manage_scpi`→`scpi`;
`manage_instrument_commands`→`instrumentCommands`; `set_micropython`→`micropython`;
`manage_shortcuts`→`shortcuts`; `list_extension_definitions`/`add_extension_definition`→`extensionDefinitions`.
Read/list ops on a disabled feature return `UNSUPPORTED` (enable it first); **write ops auto-enable** the
feature via its own `create()` seed and the mutation in ONE combined undo step (same shape as `set_readme`).
Every mutation goes through the ProjectStore command/undo API (`createObject` + `addObject`/`updateObject`/
`deleteObject`) — one undo step each.

| Method | Params | Result |
|---|---|---|
| `manage_scpi` | `{ op, subsystem?, command?, enumName?, member?, fields? }` | `{ ok: true, items }` — CRUD over the SCPI tree; see op list |
| `manage_instrument_commands` | `{ op, command?, description?, helpLink? }` | `{ ok: true, commands }` — CRUD over `instrumentCommands.commands` |
| `set_micropython` | `{ code }` | `{ code }` — sets `micropython.code` (the whole script string) |
| `manage_shortcuts` | `{ op, id?, name?, action?, keybinding?, showInToolbar?, toolbarButtonColor?, requiresConfirmation? }` | `{ ok: true, shortcuts }` (`+id` on add) |
| `list_extension_definitions` | — | `{ extensionDefinitions: [{ objID, name, description, doNotBuild, extensionName, buildConfiguration, idfGuid, idfRevisionNumber }] }` — read-only |
| `add_extension_definition` | `{ name, props? }` | `{ objID, name }` — adds an `ExtensionDefinition`; `name` unique |

- **`manage_scpi`:** the SCPI tree is `Scpi.subsystems[] → ScpiSubsystem.commands[] → ScpiCommand`, with enums
  in a parallel `Scpi.enums[] → ScpiEnum.members[]`. `op` ∈ `list | add_subsystem | add_command | add_enum |
  add_enum_member | update_subsystem | update_command | update_enum | delete_subsystem | delete_command |
  delete_enum | delete_enum_member`. Subsystems/commands/enums are addressed by **`name`** (`subsystem`,
  `command`, `enumName` params); a command is nested under its `subsystem`; an enum member is `{name, value}` in
  `member`. `add_command`/`update_*` take optional `fields` (`{description, helpLink, sendsBackDataBlock}`).
  Subsystem/command/enum `name` are `unique:true`; enum-member name uniqueness is a validator, so it is
  pre-checked (`BAD_PARAMS` on a dup). A command name ending in `?` is a query (drives `response`). `usedIn` is a
  build-config reference, left unset unless supplied. `items` echoes the affected slice; for `op:"list"` it is the
  full `{ subsystems, enums }` map. **Renaming a SCPI enum is rejected** — `ScpiParameterType.enumeration`/
  `ScpiResponseType.enumeration` reference enum names by string (collection path `scpi/enums`), so a rename would
  dangle those references (mirrors the `update_variable` rename guard); renaming subsystems/commands is safe.
- **`manage_instrument_commands`:** `op` ∈ `list | add | update | delete`. Commands live at
  `instrumentCommands.commands` and are keyed by the **`command`** string (NOT `name` — the class has no `name`
  prop), with optional `description`/`helpLink`. Uniqueness is pre-checked manually (`BAD_PARAMS` on a dup — the
  class has no `unique:true` flag). Renaming `command` is safe (nothing references it by name). Result `commands`
  is the full list after the op.
- **`set_micropython`:** the prop is **`code`** (a plain multiline string), NOT `script`; `set_micropython { code }`
  ⇒ `updateObject(project.micropython, { code })`. `code` (string) is required (`BAD_PARAMS` otherwise). This does
  NOT run the script — `MicroPython.runScript()` (instrument upload) is a separate side effect and out of scope.
- **`manage_shortcuts`:** `op` ∈ `list | add | update | delete`. Shortcuts live at `shortcuts.shortcuts` and are
  keyed by a minted **`id`** (a `guid()` set on add) — **update/delete look up by `id`, not `name`** (both `id`
  and `name` are `unique:true`). `action` is a nested `{ type, data }` object (`type` ∈ `commands | scpi-commands
  | micropython | javascript`, `data` = the action body); passing `action` as a bare string is shorthand for
  `{ type:"commands", data:<string> }`. Optional `keybinding`, `showInToolbar`, `toolbarButtonColor`,
  `requiresConfirmation`. `name` is pre-checked for uniqueness on add. `add` returns the minted `id`; `shortcuts`
  echoes the full list. (Shortcuts filter into the IEXT package at build time via `usedIn`/build-config — not a
  mutation concern here.)
- **`add_extension_definition`:** `extensionDefinitions` is an **array** feature (its `create()` returns `[]`),
  so the write auto-enables by seeding an empty array then `addObject`s into it. `name` is `unique:true`
  (`BAD_PARAMS` on a dup). A bare `{ name }` add is legal but the `check` validator flags missing IEXT fields
  (`extensionName`, `idfGuid`, `idfRevisionNumber`, plus `idfName`/`idfShortName`/`idn` for SCPI instruments) as
  CHECK warnings until set — pass `props` to seed them up front. `list_extension_definitions` is a pure read
  (`UNSUPPORTED` when the feature is off).

### Project lifecycle & view commands (NONE are undo commands — lifecycle or transient UI)
Whole-project lifecycle (`save_as`/`new_project`/`open_project`/`reload_project`) and app-shell view navigation
(`set_theme`/`open_view_tab`). **None go through `updateObject`/`addObject`/`deleteObject`; none are on the undo
stack** — `undo`/`redo` will not reverse them. `tabs` (home renderer) and `settingsController` are the same
in-process singletons the whole app uses (no IPC). `save_as`/`new_project`/`reload_project` are **DISRUPTIVE /
side-effecting** and should be implemented-but-not-auto-invoked in tests; `set_theme`/`open_view_tab`/`open_project`
are safe to call freely.

| Method | Params | Result |
|---|---|---|
| `save_as` | `{ filePath? }` | `{ saved, filePath }` — see PARTIAL note (headless only WITH `filePath`) |
| `new_project` | `{ type? }` | `{ ok: true }` — **DISRUPTIVE**: replaces the active project with a blank one |
| `open_project` | `{ filePath }` | `{ opened, filePath, pages }` — opens an existing `.eez-project` in a NEW tab |
| `reload_project` | — | `{ reloaded: true }` — **DISRUPTIVE**: re-reads the active project from disk |
| `set_theme` | `{ theme }` | `{ theme }` — switch the **editor** dark/light theme (transient UI) |
| `open_view_tab` | `{ tab }` | `{ tab }` — open a top-level home/app tab (transient UI) |

- **`save_as` is PARTIAL — headless ONLY when `filePath` is given.** With `filePath`, the bridge sets
  `store.filePath` (appending `.eez-project` if missing) and calls `store.doSave()` (raw `fs.writeFile` of the
  project JSON + clears the modified flag) — no dialog. **With `filePath` omitted, `store.saveAs()` pops the
  native OS save dialog** (`dialog.showSaveDialog`) and is NOT headless. It is an OS filesystem write, NOT an undo
  command; skipped for `_isDashboardBuild`. Implement-but-do-not-auto-invoke (writes to disk).
- **`new_project` is DISRUPTIVE.** `store.newProject()` wipes the live store to a blank untitled project in-place
  (via `setProject`) with **no save-confirm → silent loss** of the current in-memory project. The **`type` param
  is IGNORED** — `getNewProject()` produces a fixed blank project (mandatory features only); real typed creation
  is the Wizard modal (not headless). Technically dialog-free but destructive → implement-but-DO-NOT-invoke.
- **`open_project` is headless-safe** and non-destructive: it dedupes/opens a `ProjectEditorTab` for `filePath`
  and `makeActive()`s it — the previously active project tab is untouched. Load is **async** (runs on tab
  activation), so the bridge awaits load completion (polls the new tab's `projectStore`/`_fullyLoaded`) before
  reading `pages` (= `project.userPages.length`). `filePath` is required (`BAD_PARAMS`).
- **`reload_project` is PARTIAL / DISRUPTIVE.** `store.reloadProject()` → `homeTabs.reloadProject(store)` →
  `tab.reloadProject()`, which `closeWindow()`s (unmount) then re-`loadProject()`s from disk, discarding
  in-memory changes. **On a modified project `closeWindow()` pops a save-confirm dialog** (blocks headless); on a
  clean project it proceeds silently (`notification.info("Project reloaded")`). Implement-but-DO-NOT-invoke.
- **`set_theme` switches the EEZ EDITOR theme** (affects previews/screenshots) — DISTINCT from project themes
  (`set_active_theme`). `theme` ∈ `dark | light` (`BAD_PARAMS` otherwise); maps to
  `settingsController.switchTheme(isDark)` — a live CSS `<link href>` swap + `data-bs-theme` toggle, persisted via
  IPC, **no restart**. Transient UI state, NOT undo. Reads back the actual state (a 2nd call within the ~50ms
  debounce no-ops). Headless-safe.
- **`open_view_tab`** opens a top-level app tab via `tabs.openTabById(tab, true)`. `tab` ∈ `home | history |
  settings | extensions | shortcutsAndGroups` (`settings`/`extensions` are sub-views inside the Home tab;
  `workbench` aliases `home`). **`scrapbook` is special** — it is a toggleable side-panel, not a tab, driven by
  `showScrapbookManager()` (note the toggle semantics: calling it twice hides it). Unknown ids → `BAD_PARAMS`.
  Transient UI navigation, NOT undo. Headless-safe.

## 5. WidgetNode / WidgetDetail shapes

`WidgetNode` (from `get_page_tree` / `get_selection`):
```jsonc
{
  "objID": "…", "type": "LVGLLabelWidget", "identifier": "statusLabel|null",
  "rect": { "left": 0, "top": 0, "width": 80, "height": 32,
            "leftUnit": "px", "topUnit": "px", "widthUnit": "content", "heightUnit": "content" },
  "absoluteRect": { "x": 12, "y": 40, "width": 80, "height": 32 },   // page-space, best-effort
  "useStyle": "PrimaryButton|null",
  "hasLocalStyles": true,
  "text": "…",           // present for widgets that have a text/label prop
  "children": [ WidgetNode, … ]
}
```

`WidgetDetail` extends `WidgetNode` with: `props` (all serialized classInfo property values),
`localStyles` (`{ [part]: { [state]: { [prop]: value } } }`), and
`eventHandlers` (`[{ eventName, handlerType, action, userData }]`).

`WidgetClass` (from `list_widget_classes`):
```jsonc
{
  "className": "LVGLSliderWidget",
  "props": [ { "name": "min", "type": "number" },
             { "name": "mode", "type": "enum", "enumValues": ["NORMAL", "SYMMETRICAL", "RANGE"] } ],
  "events": ["VALUE_CHANGED", "RELEASED"]   // supported LVGL events, when derivable
}
```
`props` lists editable classInfo properties (name + coarse `type`: `string|number|boolean|enum|color|…`);
enum props include their `enumValues`. Use it so `create_widget`/`update_widget` can drive any widget
type (slider, dropdown, roller, tabview, keyboard, switch, bar, arc, …) without guessing prop names.

## 6. Notes

- The bridge only ever mutates through `ProjectStore.updateObject/addObject/deleteObject`
  (+ `undoManager.setCombineCommands` to group multi-step edits into one undo entry). It never
  writes raw JSON into the model, so the GUI, undo/redo, validation, and codegen stay consistent.
- `render_page` opens the page editor (mounting its LVGL-WASM preview) if needed, waits for a
  painted frame, then captures the editor canvas via `toDataURL("image/png")` — pixel-identical
  to what the user sees.
- The bridge is renderer-scoped: it tears down and re-listens across renderer reloads and guards
  against `EADDRINUSE`.
