---
name: eez-project-editor
description: Author, edit, render, and run EEZ Studio v3 LVGL ".eez-project" designs (flow or no-flow, LVGL 8.4/9.x) — LIVE via the eez-studio-mcp bridge driving a running EEZ Studio (207 tools, primary), or by exact source-verified raw-JSON editing when EEZ Studio is closed (fallback).
---

# EEZ Studio `.eez-project` LVGL Editor

Design and edit EEZ Studio **version 3, LVGL** projects — **flow or no-flow**, LVGL **8.4 or 9.x** —
**collaboratively with a running EEZ Studio**, driven through the **`eez-studio-mcp`** bridge (207
tools). The agent inspects the live project, makes edits that appear in the GUI instantly, and
self-checks each change against EEZ's own pixel-exact LVGL-WASM preview (and, for behavior, the live
simulator).

A `.eez-project` file is a single JSON document — the serialization of the internal `Project` object
tree — but with the MCP you rarely touch that JSON directly: you address widgets and set values
through tools, and the bridge mutates the model through EEZ's own `ProjectStore`. Raw-JSON editing is
the **offline fallback** for when EEZ Studio is closed (§8).

## When to Activate

- Designing or editing an `.eez-project` (LVGL, v3; flow or no-flow) **with EEZ Studio open** —
  laying out screens, positioning/styling widgets, managing assets (fonts/bitmaps/colors/styles),
  wiring events (to native actions or flow), authoring flow graphs, localization, groups/themes.
- Reviewing or fixing a screen's rendering by inspecting + re-rendering it live; running the LVGL
  simulator to verify behavior.
- (Fallback) Hand-editing the `.eez-project` JSON when EEZ Studio is closed and the bridge is
  unavailable.

## The two modes (decide first)

| Mode | Condition | How you work |
|---|---|---|
| **PRIMARY — live MCP** | The `eez-studio-mcp` tools are available (EEZ Studio with the MCP Bridge extension installed and a project open) | Drive the live project via the 207 tools: inspect → edit → **`render_page`** → diagnostics → adjust (§§3–7). |
| **FALLBACK — raw-JSON** | Tools absent / return "launch EEZ Studio first" | Hand-edit the `.eez-project` JSON in the exact source-verified format; validate + lint statically (§8). |

If a tool call returns a "launch EEZ Studio first" / bridge-not-running error, the bridge isn't up —
switch to the fallback (§8). Otherwise, **always prefer the live MCP**: edits are guaranteed
model-valid, appear in the GUI, are undoable (one undo step per call), and are visually verifiable
with the true render.

## Supporting files (your knowledge base)

- **[`eez-studio-usage.md`](eez-studio-usage.md)** — how EEZ Studio works and how a human drives it
  (Pages, structure tree, Part→State→Category styles, fonts, bitmaps, events→actions, build/export).
  Read it to understand the *concepts* the tools manipulate.
- **[`reference.md`](reference.md)** — the exhaustive, source-verified v3 / LVGL-8.4 serialization
  catalog (every style property + value format, every widget field, all parts/states/enums,
  name-mapping tables). The deep catalog for value formats and (in fallback) raw JSON.
- **[`rendering-rules.md`](rendering-rules.md)** — source-cited render-correctness rules (why a
  valid edit still renders wrong). Condensed in §6; read the file before authoring complex screens.
- **[`LEARNINGS.md`](LEARNINGS.md)** — durable, source-verified corrections captured over time. When
  you find this skill's guidance is wrong or missing a fact, fix it here and log it — see the
  `eez-editor` agent's **Self-learning** protocol. Apply it live with `node tools/learn.mjs` (syncs
  `~/.claude`); publish a general one to GitHub with `node tools/learn.mjs --public "<summary>"`.
- **`docs/PROTOCOL.md`** (in the `eez-studio-mcp` repo) — the full wire contract for all 207 tools
  (exact params + result shapes). The authoritative source when you need a tool's precise signature.

---

# PRIMARY — Live editing via the `eez-studio-mcp` MCP

The bridge lives inside the EEZ Studio renderer (installed via the MCP Bridge extension) and
reaches the live `ProjectStore` directly.
Every mutation goes through `ProjectStore.updateObject/addObject/deleteObject`, so the GUI,
undo/redo, validation, and code generation stay consistent — **the bridge never writes raw JSON into
the model.** `render_page` captures EEZ's own LVGL-WASM preview (the exact pixels the user sees), so
it is your **ground truth** for every geometry/zoom/clip/style question.

## 1. Identity & value formats

- **Widgets** are addressed by **`objID`** — the stable serialized GUID. Get it from
  `get_page_tree` / `get_selection` / `get_widget` (every inspect result includes it). You never
  invent or assign `objID`s; the bridge does.
- **Pages** are addressed by their unique **`name`** string (the `page` param).
- **`part` / `state`** are bare LVGL selectors: `"MAIN"`, `"INDICATOR"`, `"KNOB"`, …;
  `"DEFAULT"`, `"PRESSED"`, `"CHECKED"`, `"DISABLED"`, `"FOCUSED"`, plus `|`-combos like
  `"CHECKED|PRESSED"`.
- **Values use the object-model string form** (identical to what the raw JSON stores):

  | Value kind | Form |
  |---|---|
  | Color (`bg_color`, `text_color`, `border_color`, …) | `"#rrggbb"` **or** a theme-color name — never `0x…` / BGR ints |
  | Opacity (`*_opa`, `opa`) | integer **0–255** (not a percent) |
  | Number (sizes, pads, offsets, angles) | numeric literal |
  | Enum (`align`, `text_align`, `layout`, `flex_flow`, `blend_mode`, …) | **bare** id, no `LV_` prefix (`"CENTER"`, `"NORMAL"`) |
  | Boolean (`clip_corner`, `recolor`, `setPivot`, …) | `true` / `false` |
  | `text_font` | built-in `"MONTSERRAT_8"…"MONTSERRAT_48"` (even sizes) **or** a custom font's project **name** |
  | Image source (`image`, `bg_img_src`, `arc_img_src`) | the bitmap's project **name** |
  | OR-flag enums (`border_side`, `text_decor`, `widgetFlags`) | `|`-joined subset, e.g. `"TOP|LEFT"` |

  **Never pass `LV_*` constants or BGR ints.** The `LV_…` prefix and bit codes are added only at
  C-build time.

## 2. The 207 tools, grouped

Full params + result shapes for **every** tool are in **`docs/PROTOCOL.md`** — the authoritative
signature source; consult it before a first-time call. Below is the working map, grouped by intent.
Start every session with **`get_project_info`** / **`get_settings`** to learn `lvglVersion`
(8.4 vs 9.x — dictates enum spellings), `flowSupport` (flow vs no-flow), and the display size.

**Inspect (read-only):**
- `get_project_info` → `{ name, projectVersion, lvglVersion, flowSupport, displayWidth,
  displayHeight, isModified, pages[] }`. `get_settings` → the **entire Settings › General + Build panel**
  (`general` { displayWidth, displayHeight, circularDisplay, darkTheme, flowSupport, embedBitmaps, embedFonts,
  cacheFonts, description, image, author, authorLink, targetPlatform(+Link), minStudioVersion, … } + `build`),
  every field present (`null` when empty) — edit any of it with `update_settings`.
- `list_pages`; `get_page_tree({ page })` → nested `WidgetNode` tree (every `objID`, `type`,
  `identifier`, `rect`+units, `useStyle`, `hasLocalStyles`, `text`, `children`); `get_widget({ objID })`
  → full `WidgetDetail` (`props`, `localStyles` `{part:{state:{prop:value}}}`, `eventHandlers`);
  `get_selection`.
- `list_widget_classes` → the creatable LVGL classes with their editable props + events (use it to
  discover valid `type`s and prop names for the project's LVGL version).
- Asset lists: `list_fonts`/`list_bitmaps`/`list_actions`/`list_styles`/`list_colors`/`list_variables`,
  `list_enums`/`list_structures`/`list_user_widgets`, `list_font_glyphs`. Discover exact **names**
  before referencing a font/bitmap/action/style/color.

**Pages (each = one undo step):** `create_page` (auto-injects the root `LVGLScreenWidget`, returns
its `objID`), `delete_page`, `rename_page` (rebinds every reference), `reorder_page`,
`set_page_settings`.

**Widgets — core (each = one undo step):**
- `create_widget({ type, parent?, page?, index?, props? })` → `{ objID }`. `type` = a class name
  (`"LVGLLabelWidget"`); with `parent` it nests under that widget's `children`, else `page` adds to
  the screen root.
- `update_widget({ objID, props })`, `delete_widget({ objID })`, `set_identifier({ objID, name })`
  (→ `objects.<name>` in generated C), `duplicate_widget` (fresh objIDs), `move_widget`
  (reparent/reorder; objID preserved), `align_widgets`, `copy_style`.

**Widget sub-items** (array children `create_widget` can't reach): `add_matrix_button`/
`update_matrix_button` (Button-Matrix), `add_meter_indicator`/`add_meter_scale` (Meter — LVGL 8),
`add_scale_section` (Scale — LVGL 9), `add_span` (Spangroup), `delete_subitem`.

**Flags / states / layout:** `set_flag({ objID, flag, on })` (SCROLLABLE/CHECKABLE/FLOATING/… — but
HIDDEN/CLICKABLE are reactive props, see flow), `set_state` (FOCUSED/FOCUS_KEY/PRESSED/HOVERED),
`set_layout` (FLEX/GRID + auto grid descriptors), `set_scroll`, `set_grid_cell`.

**Styles (each = one undo step):** `set_style({ objID, part, state, values:{prop:value} })`,
`clear_style({ objID, part, state, prop })` (local cells); shared styles `create_style`/
`update_style`/`delete_style` (bound to one `forWidgetType`; a widget references it via `useStyle`).

**Assets — write:** bitmaps `add_bitmap`/`delete_bitmap`/`set_bitmap_options`/`export_bitmap`; fonts
`add_font`/`edit_font`/`delete_font` (real glyph extraction), `set_font_ranges`/`set_font_symbols`/
`set_font_fallback`/`add_font_additional_source`. (These import/convert assets — unlike the read
lists, they actually add to the project.)

**Entities (each = one undo step):** `create_action`/`delete_action`; colors + variables + enums
(`add_enum_member`, `update_enum_member`) + structures (`add_structure_field`) + user widgets — full
`list/add/update/delete` CRUD.

**Groups / themes:** LVGL focus groups `create_group`/`assign_widget_group`/`set_group_tab_order`/
`rename_group`/`delete_group`/`set_group_defaults`; project themes `create/rename/delete_theme`,
`set_active_theme` (drives render/preview), `set_theme_color` (one theme's value for a named color).

**i18n / texts** — *enable first* with `enable_feature({ key:"texts" })*: `list/add/rename/delete_language`,
`list/add/rename/delete_text_resource`, `set_translation({ resourceID, languageID, text })`,
`set_widget_text_resource({ objID, resourceID })` (binds the widget to `_("id")`), `import_texts`/
`export_texts` (CSV/JSON/XLIFF).

**Events:** `bind_event({ objID, event, action })` / `unbind_event` — a **native-action** handler
(no-flow: the action is a C function). `bind_flow_event({ objID, event })` — a **flow** handler that
turns the widget event into a connectable flow output.

**Flow (flowSupport projects; each = one undo step):**
- Components: `create_flow_component({ page?|action?, type, left?, top?, props? })` — `type` is the
  **registered class name** (`StartActionComponent`, `SetVariableActionComponent`,
  `EvalExprActionComponent`, `ConstantActionComponent`, `CallActionActionComponent`, …; discover with
  `list_flow_component_types`). `list_flow_components`, `get_flow_component`, `set_component_props`,
  `move_flow_component`, `delete_flow_component` (cascades its wires), `set_catch_error`,
  `create_component_group`.
- Wires + ports: `connect_components({ source, output, target, input })` — `source`/`target` are
  component objIDs, `output`/`input` are port names; execution/sequence wires use `@seqout`→`@seqin`,
  data wires use named ports. `disconnect_components`, `list_flow_connections`, `update_flow_connection`,
  `add_component_input`/`add_component_output`/`delete_component_port`.
- Vars + interface: `list/add/update/delete_flow_variable`, `list_flow_interface`, `add_flow_input`/
  `add_flow_output`, `list_action_flows`.
- Reactive + misc: `set_reactive_flag`/`set_reactive_state` (expression-bind HIDDEN/CLICKABLE and
  CHECKED/DISABLED with `type:"literal"|"expression"`), `render_flow` (the wire-graph as data — the
  flow canvas has no rasterizer), `find_component`.

**Render (pixel-exact — GROUND TRUTH):** `render_page({ page })` → `{ png/pngBase64, width, height }`
(the whole page from the LVGL-WASM preview), `render_selection({ objID? })` (cropped to the widget).

**Simulator (live LVGL runtime):** `run_simulator`/`stop_simulator`, `get_simulator_status`,
`screenshot_simulator` (captures the **running** frame as PNG — verifies actual behavior, not just
the editor preview). `pause/resume/step_simulator` are flow-debugger controls (flow projects only).

**Build:** `build` (EEZ codegen to disk → `{ ok, errors, warnings, generatedFiles }`), `build_assets`
(in-memory validation, no files), `get_build_destination`, `open_build_folder`, `list/set_build_configuration`.
Build-file codegen templates (the per-file templates the build expands into generated source — `ui.c`,
`screens.c`, …; the correct place to customize *generated* code, e.g. a global screen-load animation
`lv_scr_load_anim(..., LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false)`, since editing the generated file is
lost on the next rebuild): `list_build_files` (READ → `{ files:[{ index, fileName, objID, templateLength }] }`,
lists `settings.build.files`), `get_build_file` (READ; `{ fileName|index|objID }` → `{ index, fileName,
objID, template }`, the full template text of one file), `set_build_file_template` (WRITE, one undo step;
`{ fileName|index|objID, template }` — replaces a build-file template in full), `patch_build_file_template`
(WRITE, one undo step; `{ fileName|index|objID, find, replacement, matchCase?=true, expectedCount? }` —
literal (non-regex) find/replace inside one template; case-sensitive by default; `expectedCount` guards;
0 matches ⇒ no change).

**Search / nav / clipboard / editors:** `search_project`, `find_references`, `is_referenced`,
`replace_in_project` (→ `{ replacedCount, skipped?, note? }`; EEZ's replace covers identifiers/references,
not free text like build templates — hits it can't write are reported in `skipped` with a `note`
pointing to `set_build_file_template`/`patch_build_file_template` rather than silently returning
`replacedCount:0`), `resolve_path` (objID↔EEZ path), `copy/cut/paste_objects`, `get_clipboard_info`,
`reveal_object`/`select_widget`/`select_all`/`set_selection`, `open_page`/`open_editor`/`activate_editor`/
`close_editor`/`list_editors`/`get_active_editor`, `get_navigation_state`/`select_in_navigation`,
scrapbook (`list_scrapbook_items`/`insert_scrapbook_item`/`save_selection_to_scrapbook`).

**Project / lifecycle:** `update_settings`, `list/enable/disable_feature` (enable optional features
like `texts`/`scpi`/`shortcuts` before using their tools), imports (`add/remove_project_import`),
`add_build_configuration`, `set_readme`, `set_zoom`, `save`/`save_as`, `undo`/`redo`, `open/new/reload_project`,
`set_theme` (editor dark/light), `open_view_tab`. Instrument/dashboard: `manage_scpi`,
`manage_instrument_commands`, `manage_shortcuts`, `set_micropython`, `list/add_extension_definition`.

**Diagnostics (three surfaces — check ALL):**
- `run_checks` → `{ numErrors, numWarnings, problems[] }` — EEZ's **static** project validation
  ("Check"); each `Problem` carries the offending `objID`. `get_problems({ section? })` reads current
  CHECKS/OUTPUT **without** re-running.
- `get_console_log({ level?, limit? })` — **runtime** preview problems the static checks miss (e.g.
  `lv_draw_letter: glyph dsc. not found for U+131` = a glyph outside a font's range).
- `get_notifications({ level?, limit? })` — EEZ **toast** errors (e.g.
  `Font "myfont" extraction failed: ... Received NaN`) that appear only as notifications — often the
  root cause of the console glyph warnings.

> **Undo semantics:** every model mutation is exactly one undo step. Reads, render, simulator control,
> editor/navigation, clipboard, and `set_theme`/`set_zoom`/`set_active_theme` are transient UI/runtime
> state — they are **not** undo commands and `undo` won't reverse them.

## 3. The mandatory loop

**`open_page` (switch the GUI to the target page FIRST) → inspect → edit → `render_page` (visual
self-check) → diagnostics (`get_console_log` + `run_checks`, and `get_notifications` when
fonts/glyphs are involved) → inspect/adjust.**

- **ALWAYS `open_page({ page })` before you edit a page.** This is live co-design: the human is
  watching the EEZ GUI, and edits go through EEZ's live model, so switching the GUI to that page
  first lets them **see every change land in real time** (and catch a wrong turn immediately). Do it
  once when you start working on a page, before the first edit — not just at the end.

Never declare a change done without **both** rendering it and checking for problems:

- A model-valid edit can still **render wrong** — `align` misuse, an unscaled image, a clipped
  label (§6). Only `render_page` catches these.
- A render can **look right** while the preview logs a missing-glyph/font-extraction error that will
  bite on device. Only `get_console_log` / `get_notifications` catch these.
- `run_checks` catches invalid references (a `useStyle`/`text_font`/`action` that doesn't resolve),
  which a render won't show.

`render_page` is **authoritative** — it is EEZ's own preview, pixel-identical to what the user sees.
It supersedes any external approximate renderer. Use `select_widget` / `open_page` at the end to
point the user at what you changed.

---

## 4. EEZ Studio concepts the agent works with

These are the moving parts the tools manipulate. (Deeper teaching in
[`eez-studio-usage.md`](eez-studio-usage.md); exact fields in [`reference.md`](reference.md).)

**Pages / screens.** Each page is one LVGL **screen** with `Left/Top/Width/Height` = the display
resolution. Its widget tree hangs under a root `LVGLScreenWidget`; your widgets are that root's
children (nesting in the tree *is* the LVGL parent/child relation). Reusable composite widgets live
as **User Widgets** and are instanced with `LVGLUserWidgetWidget`. Screen transitions in no-flow are
a native action calling `loadScreen(SCREEN_ID_<NAME>)`.

**Widget tree + common types.** ~40 LVGL classes. The control-panel core and their key props:

| Widget (`type`) | Key props (via `update_widget` / `create_widget` `props`) |
|---|---|
| `LVGLPanelWidget` / `LVGLContainerWidget` | layout (Flex/Grid), `widgetFlags` (clip via `SCROLLABLE`/`OVERFLOW_VISIBLE`) |
| `LVGLButtonWidget` | usually a child `LVGLLabelWidget`; style `MAIN`/`PRESSED` |
| `LVGLLabelWidget` | `text`, `textType` (`literal`/`expression`), `longMode`, `recolor` |
| `LVGLImageWidget` | `image` (bitmap name), `zoom` (256 = 1×), `angle`, `setPivot`/`pivotX`/`pivotY` |
| `LVGLBarWidget` / `LVGLSliderWidget` | `min`, `max`, `value`, `mode`; parts `MAIN`/`INDICATOR`/`KNOB` |
| `LVGLArcWidget` | angles, `min`/`max`/`value`; parts `MAIN`/`INDICATOR`/`KNOB` |
| `LVGLRollerWidget` / `LVGLDropdownWidget` | `options`, selected index |
| `LVGLSwitchWidget` / `LVGLCheckboxWidget` | `CHECKED` state; checkbox `text` |

**Geometry & units.** `left/top/width/height` each with a unit: `px`, `%`, or `content`
(auto-size to child content — Width/Height only). The style prop **`align`** anchors the *whole
widget* to a parent point (`CENTER`, `TOP_MID`, `RIGHT_MID`, …) — it is **not** text alignment
(§6-A).

**Styles = Part → State → Category.** A widget's look is set per **Part** (`MAIN`, `INDICATOR`,
`KNOB`, `SELECTED`, `ITEMS`, `CURSOR`, …) and per **State** (`DEFAULT`, `PRESSED`, `CHECKED`,
`DISABLED`, `FOCUSED`, `CHECKED|PRESSED`, …), across ~11 categories (Position/size, Background,
Border, Shadow, Text, Padding, …). Two scopes:
- **Local styles** — modifications on that one widget → `set_style`/`clear_style`
  (`hasLocalStyles` in the tree, full map in `get_widget`).
- **Shared (Project) styles** — a reusable named style bound to **one widget type**
  (`forWidgetType`); a widget references it via the `useStyle` prop. A widget can carry **both**: the
  shared style applies first, local styles on top. Discover names with `list_styles`.

**Fonts.** Built-in Montserrat `MONTSERRAT_8…48` (even sizes) referenced as `"MONTSERRAT_32"`;
custom fonts referenced by their exact project **name** (from `list_fonts`). Every glyph you display
must be inside the font's Ranges/Symbols or it renders as `▯` (§6-D).

**Bitmaps.** Referenced by **name** (from `list_bitmaps`) in an Image widget's `image` prop or in
style `bg_img_src`/`arc_img_src`. An Image draws at the bitmap's **native** pixel size unless you set
`zoom` (§6-B).

**Actions + event handlers.** A widget's `eventHandlers` map an `eventName` (`CLICKED`,
`VALUE_CHANGED`, `PRESSED`, …) to a handler. In **no-flow** projects the handler is a **native
action** by name (`handlerType:"action"`, added with `bind_event`) — you implement `action_<name>()`
in C yourself outside `src/ui`, and screen changes are a native action calling
`loadScreen(SCREEN_ID_<NAME>)`. In **flow** projects, `bind_flow_event` turns the event into a
connectable flow output (wire it to a `ChangeScreen`/`SetVariable`/… component), or `bind_event`
calls a flow-implemented action. Discover action names with `list_actions`.

**Flow (flow projects).** Logic is authored visually as a graph on a page/action: **action
components** (`create_flow_component`, `type` = registered class name) wired by **execution**
(`@seqout`→`@seqin`) and **data** (named ports) connection lines. Widget properties, flags
(`set_reactive_flag`), and states (`set_reactive_state`) can be **expression-bound** to variables.
Flow requires the eez-framework C++ runtime at build time. `flowSupport` is a project setting (read
it from `get_project_info`) — it is not toggled per edit.

**Groups.** For keypad/encoder focus only — one focused object receives key/encoder events, ordered
by `groupIndex`. **For a pure touch UI, leave `group` empty.** Manage with `create_group`/
`assign_widget_group`.

**Localization (Texts).** Optional feature (`enable_feature{key:"texts"}`). Define **languages** and
**text resources** (message ids), set per-`(resource,language)` translations, and bind a widget's
text to a resource (`set_widget_text_resource` → the build emits `_("id")`).

**Simulator.** `run_simulator` boots the real LVGL-WASM runtime; `screenshot_simulator` captures the
**running** frame (behavior), complementing `render_page` (the static editor preview).

**Themes / colors.** Color props accept `#rrggbb` or a named theme color; named colors let you
re-theme centrally.

---

## 5. Common tasks via the MCP (recipes)

Each is a short tool sequence. Always finish with the mandatory loop (§3).

**Create a screen and a widget.**
```
list_pages                                   # see existing screens + display size
create_widget { type:"LVGLPanelWidget", page:"Main",
                props:{ left:0, top:0, width:200, height:120 } } -> { objID: P }
create_widget { type:"LVGLLabelWidget", parent:P,
                props:{ text:"Status", widthUnit:"content", heightUnit:"content" } } -> { objID: L }
render_page { page:"Main" }                  # visual check
get_console_log {} ; run_checks {}           # problem check
```

**Position with content-size + align (the clean centering recipe).** To center one label/icon in
its parent, do NOT hand-compute `left`/`top`:
```
update_widget { objID:L, props:{ widthUnit:"content", heightUnit:"content" } }
set_style { objID:L, part:"MAIN", state:"DEFAULT", values:{ align:"CENTER" } }
render_page { page:"Main" }                  # confirm it's centered, not floating
```
For edge placement use `align:"RIGHT_MID"` + a small `left` offset. (See §6-A for the misuse trap.)

**Style a widget (local).**
```
set_style { objID:B, part:"MAIN",    state:"DEFAULT",
            values:{ bg_color:"#1e88e5", radius:8, shadow_width:0 } }
set_style { objID:B, part:"MAIN",    state:"PRESSED", values:{ bg_color:"#1565c0" } }
set_style { objID:L, part:"MAIN",    state:"DEFAULT",
            values:{ text_color:"#ffffff", text_font:"MONTSERRAT_16", text_align:"CENTER" } }
render_page { page:"Main" } ; run_checks {}
```
Set only values that **differ** from the theme default (§6-F) — omit `border_width:0`, `bg_opa:255`,
`text_align:"LEFT"`, etc.

**Reference a font / bitmap.** Discover the exact name first, then set it:
```
list_fonts                                   # -> confirm e.g. "myfont" exists
set_style { objID:L, part:"MAIN", state:"DEFAULT", values:{ text_font:"myfont" } }
list_bitmaps                                 # -> confirm e.g. "logo64"
update_widget { objID:IMG, props:{ image:"logo64", zoom:256, width:64, height:64 } }
render_page { page:"Main" } ; get_notifications {}   # catch font-extraction/glyph errors
```
If `list_fonts`/`list_bitmaps` doesn't contain the name, add the asset with the write tools —
`add_bitmap` (imports/converts an image) or `add_font` (real glyph extraction; then
`set_font_ranges`/`set_font_symbols` to cover the glyphs you display) — then reference it by its new
project name.

**Wire an event → native action.**
```
list_actions                                 # -> confirm e.g. "inc_counter" exists
bind_event { objID:B, event:"CLICKED", action:"inc_counter" }
run_checks {}                                # confirm the action reference resolves
```

**Assign a shared style.**
```
list_styles                                  # -> find one whose forWidgetType matches B's type
update_widget { objID:B, props:{ useStyle:"PrimaryButton" } }
render_page { page:"Main" }                  # confirm the shared look applied
```

**Create a new screen.**
```
create_page { name:"Settings" } -> { page:"Settings", rootObjID:R }   # R = the LVGLScreenWidget
create_widget { type:"LVGLLabelWidget", page:"Settings",
                props:{ text:"Settings", widthUnit:"content", heightUnit:"content" } }
open_page { page:"Settings" } ; render_page { page:"Settings" }
```

**Verify behavior with the live simulator** (not just the static preview).
```
run_simulator {}                             # boots the LVGL-WASM runtime (poll get_simulator_status)
screenshot_simulator {}                      # PNG of the ACTUAL running frame
stop_simulator {}                            # back to editor mode
```

**Author a tiny flow** (flow projects only — check `flowSupport`; `enable_feature` is for optional
project features, not flow, which is a project-creation setting).
```
list_flow_component_types {}                                  # discover exact class names
create_flow_component { page:"Main", type:"StartActionComponent",       left:80,  top:80 }  -> { objID:S }
create_flow_component { page:"Main", type:"SetVariableActionComponent", left:80,  top:220 } -> { objID:V }
connect_components { source:S, output:"@seqout", target:V, input:"@seqin" }   # execution wire
set_component_props { objID:V, props:{ entries:[ { variableName:"count", value:"count + 1" } ] } }
bind_flow_event { objID:BTN, event:"CLICKED" }               # widget event -> connectable flow output
```

**Localize a label.** Texts is an optional feature — enable it first:
```
enable_feature { key:"texts" }
add_language { languageID:"en" } ; add_language { languageID:"de" }
add_text_resource { resourceID:"greeting" }
set_translation { resourceID:"greeting", languageID:"en", text:"Hello" }
set_translation { resourceID:"greeting", languageID:"de", text:"Hallo" }
set_widget_text_resource { objID:L, resourceID:"greeting" }  # widget text -> _("greeting")
```

**Add a widget sub-item** (Button-Matrix / Meter — unreachable via `create_widget`).
```
add_matrix_button { objID:BM, text:"OK" } ; add_matrix_button { objID:BM, newLine:true }
add_meter_scale { objID:MTR } ; add_meter_indicator { objID:MTR, type:"ARC" }   # Meter is LVGL 8
```

**Inspect before editing (always).** `get_page_tree`/`get_widget` to get the target `objID` and
current props/styles, so your edit is a delta, not a guess.

---

## 6. Rendering gotchas that still matter (via the MCP too)

Even through the MCP, a model-valid edit can render wrong. `render_page` + `get_console_log` catch
these — but knowing them saves round-trips. (Full source-cited rules in
[`rendering-rules.md`](rendering-rules.md).)

**A. `align` moves the WHOLE widget, not text.** `align` compiles to `lv_obj_set_align` and anchors
the widget to a parent point; `left`/`top` become offsets from that anchor.
- Center ONE child: `content` size + `align:"CENTER"` — no manual math. Edge: `RIGHT_MID`/`LEFT_MID`
  + small offset.
- Justify text in a FIXED-size label: `text_align` (not `align`).
- ⚠️ Never put `align:"CENTER"` on *several* siblings that need distinct positions — they all jump
  to the parent center and overlap. Position multi-sibling groups by explicit `left`/`top` +
  `content` size. **Symptom:** text floating mid-widget; labels stacked.

**B. Images do NOT scale to the widget box.** An `LVGLImageWidget` draws its bitmap at native pixel
size, clipped to the box. `zoom = 256` is 1×; `zoom = round(targetPx / nativePx × 256)`. Set the
widget `width`/`height` (units `px`) to the **scaled** size so the box contains it. **Symptom of
forgetting:** only the top-left corner shows ("cut-off logo"). Prefer **pre-scaled native-size
bitmaps at `zoom:256`** — non-256 zoom is empirically unreliable in the preview.

**C. Images rotate around their CENTER by default.** For any `angle` ≠ 0 (`angle` unit is 0.1°, so
`900` = 90°), **just set `angle` and leave `setPivot:false`** — that is the EEZ default (labelled
*"Change pivot point (default is center)"*), so LVGL rotates about the center. Enabling `setPivot` and
setting the pivot to the center is **redundant**; only set `setPivot:true` + `pivotX`/`pivotY` for a
**non-center** pivot. **Raw-JSON only:** if you OMIT `setPivot`, the loader forces it `true` with pivot
`0,0` → rotation about the top-left (a sliver in a corner), so write `setPivot:false` explicitly there.

**D. Glyphs outside the font range render as ▯.** A char not in the font's Ranges/Symbols is an
empty box. Traps: Unicode MINUS `−` (U+2212) — use ASCII hyphen `-`; arrows `←↑→↓`; accented letters
in a font whose range omits them. `get_console_log` reports `glyph dsc. not found for U+xxxx`; fix by
choosing a font that covers the glyph, extending the font's range in EEZ, or using an image.

**E. Labels clip if the box is shorter than the font line-height.** Set `heightUnit:"content"` so
the label auto-sizes and never clips vertically. `longMode` does NOT rescue a too-short box.

**F. Don't set a value that already equals its default** — it just bloats the model. Skip
`border_width:0`, `bg_opa:255` on an opaque widget, `text_align:"LEFT"`, `radius:0`, `px` units. The
theme *does* add shadow/padding, so for a flat, edge-tight card you DO need `shadow_width:0` and
`pad_*:0`. When unsure, omit it and check the render.

---

## 7. Diagnostics — the three surfaces

Check all three after every batch of edits and on first opening a project:

| Surface | Tool | Catches |
|---|---|---|
| **Static** validation | `run_checks` / `get_problems` | invalid/missing references (`useStyle`, `text_font`, `action`, bitmap), bad values — with the offending `objID` |
| **Runtime** preview | `get_console_log` | LVGL-WASM warnings the static check misses, e.g. missing glyphs, at render time |
| **Toast** errors | `get_notifications` | EEZ notifications like font-extraction failures — often the root cause of console glyph warnings |

`get_console_log`/`get_notifications` default to `level:"warn"`/`"warning"` and above and collapse
consecutive duplicates (`count`). When a label looks fine but you touched fonts/glyphs, check the
console **and** notifications — the toast is usually the real cause.

---

# 8. FALLBACK — raw-JSON editing (EEZ Studio closed)

When the bridge is unavailable, edit the `.eez-project` JSON by hand in the **exact source-verified
format** so it opens cleanly in EEZ Studio with no dropped/corrupted values. **[`reference.md`](reference.md)
is the exhaustive catalog** (top-level structure, every widget field + template, every style
property + value format, fonts, actions, code-gen name rules) — consult it before writing any field.
This section is the safe-edit summary; it does not duplicate the catalog.

## Golden rules

1. **The file is JSON.** After every edit it MUST parse:
   `python -c "import json;json.load(open('FILE'));print('OK')"`. Never leave a broken file.
2. **`objID` is a GUID on every serialized object** (widgets, event handlers, styles, fonts, actions,
   the `LVGLStylesDefinition` wrapper). When you copy/duplicate any object, assign a **fresh** UUID —
   never reuse one. `python -c "import uuid;print(uuid.uuid4())"`. Code and connection lines key off
   it. (Under the MCP the bridge assigns these; here you must.)
3. **Preserve the top-level `settings` block verbatim** unless the user asks otherwise — treat it as
   opaque.
4. **No flow `style` object on LVGL widgets.** Styling lives only in `useStyle` (shared) and/or
   `localStyles.definition[PART][STATE][prop]`.
5. **Correct value formats, always** (same as §1): colors `"#RRGGBB"`/theme name (never `0x…`);
   opacity int 0–255; enums bare (no `LV_`); booleans `true`/`false`; custom font by project `name`,
   built-in as `MONTSERRAT_XX`.
6. **Every widget carries its full required field set** — `type`, `objID`, geometry, the four
   `*Unit` fields, `children`, `widgetFlags`, the four `*Type` fields (`hiddenFlagType`,
   `clickableFlagType`, `checkedStateType`, `disabledStateType`), `states`, `localStyles`, `group`,
   `groupIndex`, and the four scroll fields. Prefer copying a **reference.md template** or a
   known-good sibling over authoring from scratch.
7. **Match the file's LVGL version** (8.4 vs 9.x); keep `widgetFlags` strings and enum spellings
   consistent with existing widgets.

## Where things live (insertion points)

- Screens → `userPages[].components[0].children` (the `LVGLScreenWidget`'s children).
- Reusable widgets → `userWidgets`. Shared styles → `lvglStyles.styles`. Actions → `actions`.
  Fonts → `fonts`. Bitmaps → `bitmaps`. Groups → `lvglGroups.groups`.
- **Flow projects** (`settings.general.flowSupport = true`): each `Page`/`Action` also carries a
  `components` array (the flow ActionComponents) wired by `connectionLines`, plus per-flow
  `localVariables`. Widget properties/flags/states can hold expression bindings instead of literals.
  Authoring flow graphs by hand-editing this JSON is error-prone (objID-keyed wires, port names) —
  strongly prefer the live MCP (§ Flow tools) for flow work; the fallback is best for no-flow layout
  edits. (Full flow serialization shapes are in **[`reference.md`](reference.md)**.)

(Full top-level structure, page/screen shape, widget templates, the style definition map, shared-style
`useStyle` mechanics, event-handler + action shapes, font entries, and code-gen name rules are
all in **[`reference.md`](reference.md)**.)

## Safe-edit checklist

1. **Read first** — confirm it's LVGL, note project + LVGL version; find the insertion point.
2. **Copy a reference.md template or a known-good sibling**, then adapt.
3. **Assign fresh `objID`s** to every new object (widget, `localStyles` wrapper, shared style + its
   inner definition wrapper, font, action).
4. **Fill ALL required widget fields** (rule 6) and use correct value formats (rule 5).
5. **Resolve every reference:** `useStyle` → an `lvglStyles.styles[].name` with matching
   `forWidgetType`; `text_font` → a `fonts[].name` or `MONTSERRAT_XX`; `image`/`bg_img_src` → a
   `bitmaps[].name`; event `action` → an `actions[].name`; `group` → an `lvglGroups.groups[].name`
   or `""`. Create the missing asset (fresh `objID`) or tell the user it's missing.
6. **Preserve `settings` verbatim.**
7. **Validate JSON** after every edit; after bulk edits, scan for duplicate `objID`s:
   `python -c "import json,collections,re;s=open('FILE').read();ids=re.findall(r'\"objID\"\\s*:\\s*\"([^\"]+)\"',s);d=[k for k,v in collections.Counter(ids).items() if v>1];print('DUPES:',d or 'none')"`.
8. **Run the static render linter (MANDATORY self-check):**
   `python ~/.claude/skills/eez-project-editor/eez_lint.py FILE`. JSON-valid is NOT enough — a valid
   file can render broken. Resolve every FAIL and every IMAGE_SCALE/LABEL_CLIP WARN before finishing;
   the linter statically flags the §6 patterns (image size ≠ native, label height < line-height,
   `align` misuse, glyphs outside range, child overflow, sibling overlap). See
   [`rendering-rules.md`](rendering-rules.md).
9. **Hand off** — report files changed, objects added/edited (with new `objID`s), references
   created/missing, and the JSON-validation result. Advise opening in EEZ Studio to confirm — or, if
   the bridge comes up, re-verify with `render_page` (the authoritative visual check that supersedes
   the static linter).

> **Offline, `eez_lint.py` is your only self-check.** The moment EEZ Studio + the bridge are
> available, switch back to the live MCP and verify with `render_page` (§3) — it is ground truth.
