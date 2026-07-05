# How EEZ Studio Works — and How to Drive It

> Teaching guide for operating **EEZ Studio** the way an experienced human user does, focused on
> **LVGL, EEZ project version 3** projects — **flow OR no-flow** (default LVGL 8.4.0; supports 8.4.0
> through 9.5.0, with 9.x differences noted). This teaches the *tool*; the live editing wire contract
> (the full **203-method** bridge) is in [`PROTOCOL.md`](PROTOCOL.md).
>
> Non-obvious claims are cited with a URL or an EEZ Studio source-file reference.

---

## 1. What EEZ Studio is

**EEZ Studio** is a free, open-source, cross-platform (Electron) desktop app. For our purposes it is a
**visual, drag-and-drop LVGL UI designer** that generates C/C++ source you compile into embedded
firmware. You lay out pages and widgets on a canvas; EEZ exports LVGL C into `src/ui`.
(Overview: <https://www.envox.eu/studio/studio-introduction/>.)

- **You do NOT need LVGL installed to design.** EEZ ships a built-in LVGL simulator compiled to
  **WebAssembly** that renders pages live in the editor — this is the ground-truth preview. You only
  need an LVGL/embedded toolchain to build firmware from the generated C.
- **License:** the app is GPL-3.0, but the *code it generates* is MIT / BSD-2.0 / Public Domain, so
  your generated UI ships freely. Platforms: Linux, macOS, Windows.
  (<https://www.envox.eu/studio/studio-introduction/>.)
- **It is not** a replacement for your build system — it produces `src/ui` C files you compile and
  link against LVGL yourself. (FAQ: <https://github.com/eez-open/studio/wiki/FAQ>.)

Install: download a release from <https://github.com/eez-open/studio/releases>; docs index (chapters
P1–P13) at <https://www.envox.eu/eez-studio-docs/>.

---

## 2. Project types, flow vs no-flow, and "version 3"

### 2.1 Four project types
When creating a project (`File → New Project`) you pick a type. Only **LVGL** matters for us; the
others are **EEZ-GUI** (EEZ's own renderer), **Dashboard** (PC-side), and **IEXT** (instrument
extensions). (<https://www.envox.eu/studio/studio-introduction/>;
templates: <https://github.com/eez-open/eez-project-templates>.)

### 2.2 Flow vs no-flow (the crucial choice)
An LVGL project is built **with EEZ Flow** or **without it** (native / "no-flow"). **The bridge fully
supports both** — it can author flow graphs as well as no-flow native hooks. The active mode is read
from `settings.general.flowSupport` (surfaced as `flowSupport` in `get_project_info`).

- **With Flow:** application logic is wired *visually* via EEZ's flowchart engine — you place flow
  components and draw **connection lines** between them (via `create_flow_component` /
  `connect_components`), and widget properties/flags/states are **expression-bound** and can be driven
  reactively (`set_reactive_flag` / `set_reactive_state`). Requires linking the **`eez-framework`**
  C++ runtime into firmware. (FAQ.)
- **No-flow:** you still design visually and can define **variables** and **user actions**, but you
  **implement them yourself in C/C++**. No Flow runtime, no `eez-framework` dependency — generated
  code is plain LVGL plus small hooks you write.
  (<https://github.com/eez-open/native-interface-lvgl-no-flow>.)

> **"Native" = "implemented in C/C++"** (not managed by the Flow engine). *No-flow-specific:* native
> variables use C getter/setter functions and native actions are C functions you write. In flow
> projects the equivalent logic is built visually inside the flow graph instead. (FAQ.)

*No-flow-specific mechanics:* runtime-changing widget content is driven by **native variables** → you
implement `get_var_<name>()` / `set_var_<name>(value)`; widget events wire to **user actions** → you
implement `void action_<name>(lv_event_t *e)`.
(<https://github.com/eez-open/native-interface-lvgl-no-flow>.) *In flow projects*, that same content
is bound to expressions/variables evaluated by the flow runtime, and events trigger flow logic instead
of native C functions.

### 2.3 "Version 3"
`.eez-project` files carry a project version in `settings` — the schema string **`"v3"`**
(`settings.general.projectVersion`), which is the EEZ serialization version and is **unrelated to the
LVGL version** (§2.3 is not "LVGL 3"). **Version 3** is the current serialization. Practical
consequences: screens and reusable widgets are two separate top-level
arrays — **`userPages`** (screens) and **`userWidgets`** (reusable groups); `themesVersion` is `3`;
`lvglStyles`/`lvglGroups` are dedicated top-level containers. Legacy single-`gui`/`pages` files
auto-migrate on load, but new v3 files write these directly. (Source-verified against EEZ Studio under
`packages/project-editor/…`.)

**LVGL version** (chosen at creation, visible in `settings`; `lvglVersion` in `get_project_info`) is
one of **`8.4.0` … `9.5.0`** with **`8.4.0` the default** — distinct from the EEZ `projectVersion`
schema string `"v3"` (§2.3), which is *not* an LVGL version. 8.x uses `LV_IMG_CF_*`, 9.0 uses
`LV_COLOR_FORMAT_*` and renames some style props (e.g. `bg_img_src` → `bg_image_src`). A few widget
default-flag strings and enum/state bit layouts differ (`OVERFLOW_VISIBLE` flag bit, v9.5.0 state
bits). **Keep any authored widget's flags consistent with the LVGL version already in the file.**
(DeepWiki: <https://deepwiki.com/eez-open/studio/5.2-lvgl-integration-and-widget-system>.)

---

## 3. The editor model (what each surface does)

Docs "Projects" chapters P1–P13: <https://www.envox.eu/eez-studio-docs/>.

### 3.1 Pages (screens)
Each **Page** is one LVGL **screen**, with geometry **Left/Top/Width/Height**. Set the main screen's
Width/Height to your **display resolution** (e.g. 480×272, 240×320) — **and also set it in Settings**;
forgetting one gives a canvas/display mismatch. Multiple pages = multiple screens; screen transitions
in **no-flow** use a native action calling `loadScreen(SCREEN_ID_<NAME>)`, while in **flow** projects
a *Change Screen* flow component performs the transition. Reusable composite widgets
live under **User Widgets** (`userWidgets`) and are instanced with `LVGLUserWidgetWidget`.
(<https://renesas-rz.github.io/rzg_hmi_sdk/v2.3.0.0/wiki/lvgl_develop-gui-using-eez-studio/>.)

### 3.2 Widgets Structure tree
The **structure/outline tree** shows the current page's widget hierarchy: the screen root
(`LVGLScreenWidget`) and nested children. You select, reparent (drag), reorder, hide/lock, and delete
here. **Tree nesting *is* the LVGL parent/child relationship** — a Label dropped inside a Button
becomes that button's child object (`children` array; source `lvgl/widgets/Base.tsx`).

### 3.3 Widgets palette
Lists all ~40 LVGL widget classes to drag onto the canvas. Common control-panel widgets: **Button,
Label, Image, Panel, Container, Bar, Slider, Arc, Roller, Switch, Checkbox, Dropdown, Textarea,
Keyboard, Table, Tabview, Spinbox, Scale, Meter, QR Code, Chart, LED, Line, Calendar, Colorwheel,
Spinner**. (Type list source-verified from `lvgl/widgets/index.ts`; per-widget docs under
<https://www.envox.eu/eez-studio-docs/>.)

### 3.4 Properties panel (sections)
When a widget is selected:
- **General** — `Name` (identifier → `objects.<name>` in generated C), `Group`, `Group index`.
- **Position and size** — `Left/Top/Width/Height`, each with a **unit** selector, plus read-only
  `Absolute pos.`. Units: **px**, **%**, **content** (content = size to fit child content; only
  Width/Height support `content`). (Source: `leftUnit/topUnit` ∈ {px,%}; `widthUnit/heightUnit` ∈
  {px,%,content}.)
- **Layout** — Flex/Grid container options.
- **Style** — `Use style` (assign a shared/Project style) + the local-style editor (§3.6).
- **Flags** — LVGL object flags: `Hidden`, `Clickable`, `Scrollable`, `Scroll elastic`, …
- **States** — object state toggles: `Checked`, `Disabled`, `Focused`, `Pressed`, `Hovered`.
- **Events** — the Event handlers array (§3.9).
- **Widget-specific** — e.g. Slider `Min/Max/Value/Mode`; Arc angles; Label `Text/Long mode/Recolor`;
  Image `Image/Zoom/Angle/Pivot`.

Most reactive fields have a **literal vs expression** toggle — literal is a fixed design-time value;
**expression** binds the field to a variable/expression. *No-flow-specific:* the expression drives
runtime content via `get_var_*`. *In flow projects*, the expression is evaluated by the flow runtime.
Applies to `Text`, `Value`, `Checked`, etc.

### 3.5 Position/size & alignment mechanics (important)
- **Left/Top/Width/Height** + unit control geometry.
- The **`align` style property** (POSITION AND SIZE category) anchors the *whole widget* to a point of
  its parent (`CENTER`, `TOP_MID`, `RIGHT_MID`, …); `Left`/`Top` then act as offsets from that anchor.
  **This is NOT text alignment.** (Source: `style-catalog.tsx`.)
- **Center one child (label/icon) in its parent:** set the child's Width/Height unit to **content**
  and style **`align: CENTER`** — that is the whole idiom, no manual math.
- **Justify text inside a fixed-size label:** use **`text_align`** (`LEFT/CENTER/RIGHT/AUTO`) — `align`
  moves the box, `text_align` justifies glyphs within it.
- ⚠️ `align: CENTER` on *several* siblings piles them all onto the parent center and overlaps them.
  Position multi-sibling groups by explicit `Left`/`Top` with `content` size.

### 3.6 Styles editor — Part → State → Category
EEZ's LVGL styling mirrors LVGL's own model. (Docs **P9**:
<https://www.envox.eu/eez-studio-docs/p9-styles-and-color-themes/>.)

- Style definitions are grouped **by Part → State → Category**. Each widget type exposes different
  **Parts** (e.g. a Slider has `MAIN`, `INDICATOR`, `KNOB`); each Part is styled per **State**
  (`Default`, `Checked`, `Pressed`, `Checked|Pressed`, `Disabled`, `Focused`, …). Under each Part+State
  are ~72 attributes across ~11 categories (Position & size, Layout, Padding, Background, Border,
  Outline, Shadow, Image, Line, Arc, Text, Misc). (Source `style-catalog.tsx`.)
- **Local style** = modifications stored on *that one widget*; a per-attribute indicator and per-header
  count show what changed.
- **Project (shared) style** = a reusable named style assigned via **`Use style`**. In LVGL a Project
  style is bound to **one widget type** (`forWidgetType`), so `Use style` only lists styles valid for
  the selected widget's type.
- **Create a Project style from a local style:** use **`Create New Style`** in the widget's local-style
  popup; it makes a reusable Project style and applies it back to the widget.
- A widget can have **both** a shared style *and* local overrides — the shared style applies first,
  then local styles on top.
- **CSS preview** (read-only) summarizes all generated CSS incl. inherited parent styles.

### 3.7 Themes / Colors
Color-valued attributes accept **`#RRGGBB` or a named color** from the project's **Color theme**;
named colors let you re-theme centrally. Themes/colors live in the top-level `colors`/`themes` arrays
(`themesVersion: 3`). (Docs P9; source `style-definition.tsx`.)

### 3.8 Fonts (docs **P11**: <https://www.envox.eu/eez-studio-docs/p11-fonts/>)
**Add a font** with `Add item`. Dialog fields: **Name** (what a style's `text_font` references),
**Font file** (TTF/OTF), **bpp** (1/2/4/8; 4 is a good default — higher = smoother but more flash),
**Font size (px)**, **Ranges** (code ranges, e.g. `0x20-0x7F`), **Symbols** (extra characters). EEZ
uses **[lv_font_conv](https://github.com/lvgl/lv_font_conv)** to convert to an LVGL bitmap font. After
creation, `Add or Remove Characters` adjusts ranges.
- **Built-in fonts** are Montserrat `MONTSERRAT_8 … MONTSERRAT_48` (even sizes); a style stores e.g.
  `"text_font": "MONTSERRAT_32"`. A custom font is referenced by its **project name** verbatim, e.g.
  `"text_font": "calibriBS"`. (Source `style-catalog.tsx`.)

### 3.9 Events / event handlers
The **Events** section holds an array of **Event handlers**, each with an **event type**
(`CLICKED`, `VALUE_CHANGED`, `PRESSED`, …), a **Handler type** (`Flow`|`Action`), and (for `Action`)
the **user action** name. *No-flow-specific:* you use **Handler type = Action**, pointing at a user
action you defined (§4.7). *In flow projects* you use **Handler type = Flow**, which exposes an output
on the widget's flow component that you wire (`connect_components`) to downstream flow logic.
(Per-widget "Events" docs.)

### 3.10 Actions (native vs flow)
**User actions** live in a **User Actions / Actions** tab. *No-flow-specific:* actions are **native** —
add one, name it, attach it to an event handler, and implement the C function. *In flow projects*,
the docs' "LVGL action" page describes a *Flow* component doing built-in LVGL ops — Change Screen,
Slider Set Value, … — wired into the flow graph; the bridge can place and connect these
(`create_flow_component` / `connect_components`). In no-flow you write the equivalent LVGL calls in
your own C action instead. (<https://github.com/eez-open/native-interface-lvgl-no-flow>.)

### 3.11 Groups (keypad/encoder focus)
Objects driven by a **keypad or encoder** must be added to a **Group** (one object is focused and
receives key/encoder events). EEZ exposes `Group` + `Group index` per widget and a top-level
`lvglGroups`. **For a pure touch-panel UI, leave `Group` empty.**
(LVGL groups: <https://docs.lvgl.io/latest/en/html/overview/indev.html>.)

### 3.12 Variables
Variables tab → Global → add (name + type). Bind to a widget field via its **expression** mode.
*No-flow-specific:* implement `get_var_<name>()` / `set_var_<name>(value)` in C; EEZ calls the getter
during `ui_tick()`. *In flow projects* the flow runtime owns variable storage and evaluation, so no C
getters/setters are needed. (<https://github.com/eez-open/native-interface-lvgl-no-flow>.) EEZ also
supports **enums** and **structures** as variable types, plus **local** variables (all editable via the
bridge).

### 3.13 Bitmaps / images (docs **P10**: <https://www.envox.eu/eez-studio-docs/p10-bitmaps/>)
**Add a bitmap:** dialog fields **Name**, **Image** (file), **Color format** (maps to LVGL constants,
e.g. `TRUE COLOR ALPHA` = `LV_IMG_CF_TRUE_COLOR_ALPHA` for RGBA PNGs; also `ALPHA 8 BIT`,
`INDEXED 8 BIT`, `RGB565A8`, …). Bitmaps are used by the **Image widget** and referenced from styles
(`bg_img_src`, `arc_img_src`) by **name**.

---

## 4. Core design workflows (step by step)

These apply to any **LVGL v3** project (flow or no-flow); steps that differ are labeled. When EEZ
Studio is running with the MCP bridge, prefer driving these via the **`eez-studio-mcp` tools** — the
full **203-method** surface covering pages, widgets, styles, assets (fonts/bitmaps/colors), variables,
the flow graph, code generation/build, and the LVGL-WASM simulator (see [`PROTOCOL.md`](PROTOCOL.md)) —
and **self-check every change with `render_page`**.

### 4.1 Create the project
`File → New Project` → choose **LVGL** → choose the flow mode: *no-flow-specific:* pick the **plain
LVGL template** (*not* "LVGL with EEZ Flow") to get a native/no-flow project; for a **flow** project
pick the **"LVGL with EEZ Flow"** template (which links `eez-framework`). Then choose **LVGL version**
(`8.4.0`…`9.5.0`, default `8.4.0`) → name it. Set the display resolution **in two places**: the
**main Page** (Width/Height) *and* **Settings** — make them match your panel.
(<https://blog.embeddedexpert.io/?p=2765>.)

### 4.2 Add a page (screen)
The project starts with `Main`. Add Pages for more screens; each root is an `LVGLScreenWidget` and
your widgets are its children. Set each page's Width/Height to the display size.

### 4.3 Add and position widgets
1. **Drag** a widget from the palette onto the canvas (or onto a parent in the tree to nest it).
2. **Resize/move** by dragging handles, or type exact **Left/Top/Width/Height** in Properties.
3. Choose **units**: `px` fixed, `%` relative to parent, `content` to auto-size a Label/Image/Button.
4. Give a **Name** (General) if C code must reference the widget → `objects.<snake_name>`.

### 4.4 Style a widget (local, parts/states)
Select widget → **Style** → pick **Part** (e.g. `MAIN`) and **State** (e.g. `Default`) → set
attributes (Background `bg_color`/`bg_opa`, Text `text_color`/`text_font`, Border, Shadow, Radius,
Padding, …). **Colors** = `#RRGGBB` or theme name; **opacity** = integer **0–255** (not a percent).
Repeat for other states (e.g. `Pressed` → darker `bg_color`) for designed press feedback.

### 4.5 Content-size + align (the clean centering recipe)
Center a Label inside a Button: select the Label → set **Width unit = content**, **Height unit =
content** → Style **`align: CENTER`**. No manual left/top. For edge placement (e.g. right-side icon),
use `align: RIGHT_MID` + a small negative `Left` offset.

### 4.6 Add a font and use it
1. Fonts panel → **Add item** → **Name**, TTF/OTF, **bpp** (4), **size (px)**, **Ranges**
   (`0x20-0x7F` for ASCII; add symbols/accents as needed).
2. Select a text widget → Style → TEXT → **`text_font`** → choose your font by project name.
3. Ensure every glyph you display is inside the font's Ranges/Symbols, else it renders as `▯`.

### 4.7 Wire an event → native action (*no-flow-specific*)
*In flow projects*, instead of a native C action you set the handler's **Handler type = Flow** and wire
the widget's event output into flow logic (see §3.9/§3.10). The steps below are for **no-flow**, from
the official example (<https://github.com/eez-open/native-interface-lvgl-no-flow>):
1. **Define the user action:** User Actions tab → `+` → name it (e.g. `inc_counter`).
2. **Attach it:** widget → **Events** → add handler → pick event (e.g. `CLICKED`) → **Handler type =
   Action** → select `inc_counter`.
3. **Implement in C:** EEZ declares `void action_inc_counter(lv_event_t *e);` in `actions.h`; you write
   the body (kept in a file *outside* `src/ui` so rebuilds don't overwrite it). Inside you have the
   LVGL event/target, e.g. `lv_obj_t *btn = lv_event_get_target(e);`.
   Screen change from an action: call `loadScreen(SCREEN_ID_<NAME>)`.

### 4.8 Bind a variable to widget content
1. Variables → Global → `+` → name + type (e.g. `selected_item : integer`).
2. On the widget field (Label `Text`, Bar `Value`), switch to **expression**, enter the variable name,
   set a **preview value** for the editor.
3. *No-flow-specific:* implement `get_var_selected_item()` / `set_var_selected_item(value)` (declared
   in `vars.h`); EEZ calls the getter during `ui_tick()`. *In flow projects* the flow runtime stores
   and updates the variable, so no C getter/setter is written.

### 4.9 Add a bitmap and place an image
1. Bitmaps panel → add → **Name**, **Image file**, **Color format** (`TRUE COLOR ALPHA` for RGBA PNGs).
2. Drag an **Image** widget → set **Image = your bitmap name**.
3. **Sizing caveat:** an Image draws at the bitmap's *native* pixel size (clipped to the box) unless
   you set **Zoom** (`256 = 1×`). Prefer pre-scaling the bitmap so the box equals native size at
   `zoom:256`. For rotation, set the pivot to the image center (§6).

### 4.10 Define a shared (Project) style and reuse it
1. Style one representative widget (local style) the way you want it.
2. From its local-style popup choose **Create New Style** → name it (e.g. `PrimaryButton`). EEZ makes a
   Project style bound to that widget type.
3. On other same-type widgets, set **Use style → PrimaryButton**. Optionally make it the per-type
   **default** so new widgets of that type inherit it automatically.

---

## 5. Building / exporting to LVGL C

### 5.1 Build inside EEZ Studio
Click the **Build** icon. Generated files go to **`src/ui`** (relative to the `.eez-project`). Typical
LVGL output: `ui.c/h`, `screens.c/h`, `styles.c/h`, `images.c/h`, `fonts.c/h`, `actions.h`, and
(*no-flow*) `vars.h`. Names follow the code-gen conventions (identifier → `objects.<snake>`, action →
`action_<snake>`, font → `ui_font_<snake>`, bitmap → `img_<snake>`). *Flow* projects additionally emit
the flow definition/runtime glue and link against `eez-framework`. The build can also be triggered via
the bridge. (FAQ; source `lvgl/build.ts`.)

### 5.2 Integrate into firmware
1. Copy the generated `ui` folder alongside your LVGL sources; add it to include paths.
2. `#include "ui.h"` in `main`.
3. After `lv_init()` and display/input init, call **`ui_init()`**.
4. Per loop, after `lv_timer_handler()`/`lv_task_handler()`, call **`ui_tick()`**.
5. *No-flow-specific:* implement native actions (`action_*`) and, if used, native variables
   (`get_var_*`/`set_var_*`) — keep them **outside `src/ui`** so rebuilds don't wipe them. *Flow*
   projects need none of this — logic runs in the linked `eez-framework` runtime — but you must build
   and link `eez-framework`.

```c
#include "lvgl/lvgl.h"
#include "ui.h"
int main(void) {
    lv_init();
    /* ... init display + input drivers ... */
    ui_init();                 // build the EEZ-designed UI
    while (1) {
        lv_timer_handler();    // or lv_task_handler()
        ui_tick();             // refresh EEZ variable-bound widgets
    }
}
```

### 5.3 Build settings you will touch (common failures)
- **`LV_LVGL_H_INCLUDE_SIMPLE`** — controls `#include "lvgl.h"` vs `#include "lvgl/lvgl.h"`. Toggle it
  in **Settings → Build** to match your layout; a mismatch is the #1 "missing `lvgl.h`" error.
- **Enable fonts in `lv_conf.h`** — a built-in Montserrat font shown in the simulator can be *invisible
  on device* if not enabled in `lv_conf.h`. Enable the sizes you use.
- **`undefined reference to native_vars`** (*no-flow-specific*) — the no-flow project is missing
  `flow_def.c` (or its `//${eez-studio LVGL_NATIVE_VARS_TABLE_DEF}` marker); copy it from a fresh
  project.
- **LVGL 9.x** — color-format constants and some style prop names change; a project made for 8.x is not
  trivially retargeted to 9.x. Pick the version up front.
(All: FAQ <https://github.com/eez-open/studio/wiki/FAQ>; DeepWiki
<https://deepwiki.com/eez-open/studio/5.2-lvgl-integration-and-widget-system>.)

---

## 6. Key gotchas experienced users know

**Design/rendering**
1. **`align` moves the whole widget, not text.** Center a child = `content` size + `align: CENTER`;
   justify text in a fixed box = `text_align`. `align: CENTER` on several siblings overlaps them.
2. **Images don't scale to the box.** An Image draws at native pixel size (clipped) unless you set
   `zoom` (256 = 1×) and size the box to match. Non-native `zoom` is *unreliable* in the preview —
   prefer pre-scaled bitmaps at `zoom:256`.
3. **Rotated images pivot around (0,0) and fly off-box.** For any `angle ≠ 0`, set `setPivot: true` and
   pivot X/Y to the image center.
4. **Glyphs outside the font range render as `▯`.** Watch the Unicode MINUS `−` (U+2212) — use the
   ASCII hyphen `-` — plus arrows/symbols. Add missing glyphs to the font's Symbols.
5. **Don't over-specify styles.** The theme sets shadow/padding; a flat, edge-tight card usually needs
   `shadow_width: 0` and `pad_*: 0`. Don't set values already equal to the default (`border_width:0`,
   `bg_opa:255`, `text_align:LEFT`) — it just bloats the file.
6. **Opacity is 0–255, not a percentage** (`bg_opa: 128` ≈ 50%). Colors are `#RRGGBB` or a theme name,
   never `0x…`.

**Build/integration**
7. `lvgl.h` not found → toggle `LV_LVGL_H_INCLUDE_SIMPLE`.
8. Font in simulator but invisible on device → enable it in `lv_conf.h`.
9. (*no-flow*) `undefined reference to native_vars` → missing `flow_def.c` / its marker; copy from a
   fresh project.
10. Call order: `lv_init()` → display/input init → `ui_init()`; per loop `lv_timer_handler()` →
    `ui_tick()`.
11. (*no-flow*) Keep `action_*` / `get_var_*` implementations **outside `src/ui`** so rebuilds don't
    wipe them. (*Flow* projects have no such hand-written C to preserve.)
12. Set the resolution in **both** the Page and Settings.

**Version discipline**
13. Pick LVGL **8.x vs 9.x at creation and stay consistent** — flag/enum/state bit layouts and
    color-format constants differ. When hand-editing, match existing widgets' flag strings.
14. **Every object needs a unique `objID` (GUID).** Copying a widget/style/font/action in raw JSON
    requires a *fresh* UUID — code and connection lines key off it. (The MCP bridge assigns IDs for you,
    so this applies to raw-JSON editing only.)
15. **In LVGL projects the flow `style` object is disabled.** All styling lives in `useStyle` +
    `localStyles`.

---

## 7. Two ways to drive EEZ Studio (which to use)

| Situation | Use |
|---|---|
| **EEZ Studio is running with the project open** (the `eez-studio-mcp` tools are available) | **PREFERRED: live MCP editing.** Inspect → edit → **`render_page` self-check** → adjust. Edits appear instantly in the GUI, are undoable, and `render_page` returns EEZ's own LVGL-WASM preview as PNG (ground truth). See [`PROTOCOL.md`](PROTOCOL.md). |
| **EEZ Studio is closed** (offline) | **Fallback: hand-edit the raw `.eez-project` JSON** using the exact serialization format, validate JSON, and run a static render check. |

Either way, the **EEZ preview is the ground truth** for geometry/zoom/clip: the canvas preview runs the
real LVGL as WASM and blits its framebuffer, so what the preview shows is what the device shows for
those properties. Under the MCP, `render_page` captures exactly that preview, and the bridge can also
drive the interactive **LVGL-WASM simulator** (including flow-runtime behavior in flow projects) to
verify runtime logic — not just static layout.

---

## 8. Curated references (study material)

**Official example `.eez-project` files (LVGL)** — repo `eez-open/eez-project-examples`, folder
`examples/LVGL/` (<https://github.com/eez-open/eez-project-examples>), also in-app via the **Examples**
tab. Best small files to study: **QR Code** (~33 KB), **Tabview** (~38 KB), **Styled Tabview** (~40 KB),
**Spinbox** (~45 KB), **Arc** (~78 KB). (Replace `/blob/` with
`raw.githubusercontent.com/.../master/...` to fetch JSON.) Larger showcases: **Calculator**, **Change
Screen**, **LVGL Widgets Demo**, **Smart Home** (and its LVGL 9.x / low-res variants).

**Integration repos**
- No-flow canonical example: <https://github.com/eez-open/native-interface-lvgl-no-flow>
- With-flow counterpart: <https://github.com/eez-open/native-interface-lvgl-with-flow>
- Project templates: <https://github.com/eez-open/eez-project-templates>
- `eez-framework` (with-flow runtime only): <https://github.com/eez-open/eez-framework>
- Real-world firmware: <https://github.com/eez-open/modular-psu-firmware>

**Docs, tutorials, videos**
- Official docs (P1–P13; **P9** Styles, **P10** Bitmaps, **P11** Fonts):
  <https://www.envox.eu/eez-studio-docs/>
- Renesas RZ/G HMI SDK end-to-end walkthrough:
  <https://renesas-rz.github.io/rzg_hmi_sdk/v2.3.0.0/wiki/lvgl_develop-gui-using-eez-studio/>
- EmbeddedExpertIO integration guide: <https://blog.embeddedexpert.io/?p=2765>
- Seeed Studio wiki (reTerminal): <https://wiki.seeedstudio.com/reterminal_e10xx_with_eezstudio/>
- DeepWiki LVGL integration overview:
  <https://deepwiki.com/eez-open/studio/5.2-lvgl-integration-and-widget-system>
- Official YouTube tutorial #1: <https://www.youtube.com/watch?v=MGq8zmtOeVM>
- FAQ (flow vs no-flow, native vars/actions, build issues):
  <https://github.com/eez-open/studio/wiki/FAQ>
- LVGL groups/indev: <https://docs.lvgl.io/latest/en/html/overview/indev.html> · image color formats:
  <https://docs.lvgl.io/8.3/overview/image.html#color-formats>

**This repo**
- [`PROTOCOL.md`](PROTOCOL.md) — the EEZ Studio MCP bridge wire protocol (methods, identity, value
  formats, render).
