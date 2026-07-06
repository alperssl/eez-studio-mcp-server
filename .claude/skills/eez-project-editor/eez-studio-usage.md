# How EEZ Studio Works — and How to Drive It

> Agent-facing teaching guide for operating **EEZ Studio** the way an experienced human user does,
> for **LVGL** projects on the **EEZ `v3`** schema — **flow or no-flow**, LVGL `8.4.0`..`9.5.0`
> (version differences noted). The bridge fully supports **both** modes: no-flow projects use native
> C variables/actions, while **`flowSupport:true`** projects add a visual flow graph the MCP bridge
> authors directly (`create_flow_component`/`connect_components`/`set_reactive_*`/… — see
> [`SKILL.md`](SKILL.md) §2 "Flow"). C-interface details below are labeled *no-flow-specific* with
> the flow equivalent noted in place. This teaches the *tool*; for the exact `.eez-project` JSON
> format see [`reference.md`](reference.md) and [`rendering-rules.md`](rendering-rules.md), and for
> the live editing protocol (all **207 tools**, authoritatively specified in
> [`docs/PROTOCOL.md`](../../../docs/PROTOCOL.md)) see [`SKILL.md`](SKILL.md) §"Live editing via MCP".
>
> Non-obvious claims are cited with a URL or a source-file reference, as in the research guide.

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

### 2.2 Flow vs no-flow (a per-project mode, not a target)
An LVGL project is built **with EEZ Flow** or **without it** (native / "no-flow"). The bridge fully
supports **both** — read `flowSupport` from `get_project_info` (or `get_settings`) and drive the
project accordingly.

- **With Flow (`flowSupport:true`):** application logic is wired *visually* via EEZ's flowchart
  engine (action components + connection lines); widget properties/flags/states can be
  **expression-bound** to variables. Requires linking the **`eez-framework`** runtime into firmware
  (C++). The MCP bridge authors flow graphs directly (`create_flow_component`, `connect_components`,
  `set_reactive_flag`/`set_reactive_state`, `add_component_output`, …). (FAQ;
  <https://github.com/eez-open/native-interface-lvgl-with-flow>.)
- **No-flow (`flowSupport:false`):** you still design visually and can define **variables** and
  **user actions**, but you **implement them yourself in C/C++**. No Flow runtime, no `eez-framework`
  dependency — generated code is plain LVGL plus small hooks you write.
  (<https://github.com/eez-open/native-interface-lvgl-no-flow>.)

Both modes share the same visual editor (§3) and design workflows (§4). Where §3–§4 gives
**C-interface details** (`get_var_*`, `action_*`), those are *no-flow-specific*; a **flow** project
instead binds the same fields to expressions and wires logic with flow components + connection lines
(authored via the tools above; see `SKILL.md` §2 "Flow"). Both are called out in place below.

> **"Native" = "implemented in C/C++"** (not managed by the Flow engine). Native variables use C
> getter/setter functions; native actions are C functions you write. (FAQ.)

**No-flow-specific:** runtime-changing widget content is driven by **native variables** → you
implement `get_var_<name>()` / `set_var_<name>(value)`; widget events wire to **user actions** → you
implement `void action_<name>(lv_event_t *e)`.
(<https://github.com/eez-open/native-interface-lvgl-no-flow>.) In a **flow** project the same widget
content is bound to an expression that the Flow runtime evaluates, and the event fires a flow instead
of a C function — no `get_var_*`/`action_*` code.

### 2.3 "Version 3" (the EEZ schema, not an LVGL version)
`.eez-project` files carry a **project (schema) version** string in `settings` — `get_project_info`
returns it as `projectVersion`. **`"v3"`** is the current serialization. This is a *separate axis*
from the **LVGL version** (`lvglVersion`, e.g. `8.4.0`/`9.5.0`, §2.4) — do not conflate schema `v3`
with "LVGL 3". Practical consequences: screens and reusable widgets are two separate top-level
arrays — **`userPages`** (screens) and **`userWidgets`** (reusable groups); `themesVersion` is `3`;
`lvglStyles`/`lvglGroups` are dedicated top-level containers. Legacy single-`gui`/`pages` files
auto-migrate on load, but new v3 files write these directly. (Source-verified; see
[`reference.md`](reference.md).)

### 2.4 LVGL 8.4 vs 9.x
The **LVGL version** is chosen at creation and visible in `settings` (`lvglVersion`). EEZ supports the
range **`8.4.0` .. `9.5.0`** (specifically `8.4.0`, `9.2.2`, `9.3.0`, `9.4.0`, `9.5.0`), and
**`8.4.0` is the default** for new projects. (Source-verified: `lvgl/lvgl-versions.ts`.) Differences
to respect: 8.x uses `LV_IMG_CF_*`, 9.0 uses `LV_COLOR_FORMAT_*` and renames some style props (e.g.
`bg_img_src` → `bg_image_src`). A few widget default-flag strings and enum/state bit layouts differ
(`OVERFLOW_VISIBLE` flag bit, v9.5.0 state bits; default font bpp is 8 on 9.3.0+). **Keep any authored
widget's flags consistent with the LVGL version already in the file.**
(DeepWiki: <https://deepwiki.com/eez-open/studio/5.2-lvgl-integration-and-widget-system>.)

---

## 3. The editor model (what each surface does)

Docs "Projects" chapters P1–P13: <https://www.envox.eu/eez-studio-docs/>.

### 3.1 Pages (screens)
Each **Page** is one LVGL **screen**, with geometry **Left/Top/Width/Height**. Set the main screen's
Width/Height to your **display resolution** (e.g. 480×272, 240×320) — **and also set it in Settings**;
forgetting one gives a canvas/display mismatch. Multiple pages = multiple screens; a screen transition
is a **`ChangeScreen` flow action** in flow projects, or (no-flow-specific) a native action calling
`loadScreen(SCREEN_ID_<NAME>)`. Reusable composite widgets live under **User Widgets**
(`userWidgets`) and are instanced with `LVGLUserWidgetWidget`.
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
**expression** binds the field to a variable/expression. In **flow** projects the Flow runtime
evaluates that expression at runtime; in **no-flow** it drives runtime content via `get_var_*`.
Applies to `Text`, `Value`, `Checked`, etc. (The bridge writes these via `set_reactive_*`.)

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
the **user action** name. **No-flow:** use Handler type = **Action**, pointing at a user action you
defined (§4.7). **Flow:** use Handler type = **Flow** — the handler becomes a flow output you wire
with `connect_components` (the bridge's `bind_flow_event` seeds this). (Per-widget "Events" docs.)

### 3.10 Actions (native vs flow)
**User actions** live in a **User Actions / Actions** tab.
- **No-flow:** actions are **native** — add one, name it, attach it to an event handler, and implement
  the C function yourself (§4.7). (<https://github.com/eez-open/native-interface-lvgl-no-flow>.)
- **Flow:** an action is itself a **flow** (its own graph), and the built-in **LVGL action** flow
  component performs LVGL ops declaratively — Change Screen, Slider Set Value, Add/Clear Flag, … —
  which in no-flow you'd hand-write as C. Author flow-mode logic with `create_flow_component` +
  `connect_components`. (See `SKILL.md` §2.)

### 3.11 Groups (keypad/encoder focus)
Objects driven by a **keypad or encoder** must be added to a **Group** (one object is focused and
receives key/encoder events). EEZ exposes `Group` + `Group index` per widget and a top-level
`lvglGroups`. **For a pure touch-panel UI, leave `Group` empty.**
(LVGL groups: <https://docs.lvgl.io/latest/en/html/overview/indev.html>.)

### 3.12 Variables
Variables tab → Global (or Local, in flow) → add (name + type). Bind to a widget field via its
**expression** mode. **No-flow-specific:** implement `get_var_<name>()` / `set_var_<name>(value)` in
C; EEZ calls the getter during `ui_tick()`. **Flow:** the Flow runtime holds the variable's value and
re-evaluates bound expressions automatically — no getter/setter code. EEZ also supports **enums,
structures, and arrays** as variable types (the bridge exposes create/list tools for each).
(<https://github.com/eez-open/native-interface-lvgl-no-flow>.)

### 3.13 Bitmaps / images (docs **P10**: <https://www.envox.eu/eez-studio-docs/p10-bitmaps/>)
**Add a bitmap:** dialog fields **Name**, **Image** (file), **Color format** (maps to LVGL constants,
e.g. `TRUE COLOR ALPHA` = `LV_IMG_CF_TRUE_COLOR_ALPHA` for RGBA PNGs; also `ALPHA 8 BIT`,
`INDEXED 8 BIT`, `RGB565A8`, …). Bitmaps are used by the **Image widget** and referenced from styles
(`bg_img_src`, `arc_img_src`) by **name**.

---

## 4. Core design workflows (step by step)

These workflows apply to any **LVGL v3** project; the C-interface notes (native vars/actions) are
no-flow specifics, while flow projects wire the equivalent logic visually (`SKILL.md` §2 "Flow").
When EEZ Studio is running with the bridge, prefer driving these via the **`eez-studio-mcp` tools**
(see [`SKILL.md`](SKILL.md) §"Live editing via MCP") and **self-check every change with
`render_page`**.

### 4.1 Create the project
`File → New Project` → choose **LVGL** → **pick your mode**: the plain **LVGL** template for
**no-flow** (native C hooks), or the **"LVGL with EEZ Flow"** template for a **flow** project
(`flowSupport:true`, visual logic + `eez-framework` runtime). → choose **LVGL version** (default
`8.4.0`, up to `9.5.0`) → name it. Set the display resolution **in two places**: the **main Page**
(Width/Height) *and* **Settings** — make them match your panel. When driving an existing project,
read the mode from `get_project_info` (`flowSupport`) rather than assuming.
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

### 4.7 Wire an event → native action *(no-flow-specific)*
> **Flow equivalent:** add a **Flow**-type event handler (`bind_flow_event`), then
> `create_flow_component` for the logic (e.g. an **LVGL action** component) and `connect_components`
> from the widget's event output to it — no C function. The steps below are the **no-flow** path.

From the official no-flow example (<https://github.com/eez-open/native-interface-lvgl-no-flow>):
1. **Define the user action:** User Actions tab → `+` → name it (e.g. `inc_counter`).
2. **Attach it:** widget → **Events** → add handler → pick event (e.g. `CLICKED`) → **Handler type =
   Action** → select `inc_counter`.
3. **Implement in C:** EEZ declares `void action_inc_counter(lv_event_t *e);` in `actions.h`; you write
   the body (kept in a file *outside* `src/ui` so rebuilds don't overwrite it). Inside you have the
   LVGL event/target, e.g. `lv_obj_t *btn = lv_event_get_target(e);`.
   Screen change from an action: call `loadScreen(SCREEN_ID_<NAME>)`.

### 4.8 Bind a variable to widget content
1. Variables → Global → `+` → name + type (e.g. `selected_item : integer`).
2. On the widget field (Label `Text`, Bar `Value`), switch to **expression**, enter the variable
   name (or any valid expression), set a **preview value** for the editor.
3. **No-flow-specific:** implement `get_var_selected_item()` / `set_var_selected_item(value)`
   (declared in `vars.h`); EEZ calls the getter during `ui_tick()`.
   **Flow:** stop here — the Flow runtime stores the variable and refreshes the binding automatically;
   set/read it from flow components instead of C.

### 4.9 Add a bitmap and place an image
1. Bitmaps panel → add → **Name**, **Image file**, **Color format** (`TRUE COLOR ALPHA` for RGBA PNGs).
2. Drag an **Image** widget → set **Image = your bitmap name**.
3. **Sizing caveat:** an Image draws at the bitmap's *native* pixel size (clipped to the box) unless
   you set **Zoom** (`256 = 1×`). Prefer pre-scaling the bitmap so the box equals native size at
   `zoom:256`. For rotation, just set **Angle** — the pivot is the **center** by default; leave
   *Change pivot point* off (§6).

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
(no-flow) `vars.h`. Names follow the code-gen conventions (identifier → `objects.<snake>`, action →
`action_<snake>`, font → `ui_font_<snake>`, bitmap → `img_<snake>`). (FAQ; source `lvgl/build.ts`.)

### 5.2 Integrate into firmware
1. Copy the generated `ui` folder alongside your LVGL sources; add it to include paths.
2. `#include "ui.h"` in `main`.
3. After `lv_init()` and display/input init, call **`ui_init()`**.
4. Per loop, after `lv_timer_handler()`/`lv_task_handler()`, call **`ui_tick()`**.
5. **No-flow:** implement native actions (`action_*`) and, if used, native variables
   (`get_var_*`/`set_var_*`) — keep them **outside `src/ui`** so rebuilds don't wipe them.
   **Flow:** instead add the **`eez-framework`** runtime to your build; the generated flow code drives
   logic, so there are no `action_*`/`get_var_*` hooks to write.

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
- **`undefined reference to native_vars`** *(no-flow-specific)* — the no-flow project is missing
  `flow_def.c` (or its `//${eez-studio LVGL_NATIVE_VARS_TABLE_DEF}` marker); copy it from a fresh
  project. (Flow projects link `eez-framework` instead and don't hit this.)
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
3. **Images rotate around their CENTER by default.** Just set `angle` (unit **0.1°**: `450` = 45°) and
   leave `setPivot: false` (EEZ default — *"Change pivot point (default is center)"*). Enabling `setPivot`
   and setting the pivot to the center is **redundant**; only set `setPivot:true` + `pivotX/pivotY` for a
   **non-center** pivot. *(Raw-JSON only:* omitting `setPivot` makes the loader force it `true` with pivot
   `0,0` → top-left fly-off, so always write `setPivot:false` explicitly there.)
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
9. *(no-flow)* `undefined reference to native_vars` → missing `flow_def.c` / its marker; copy from a
   fresh project. *(flow)* instead ensure `eez-framework` is linked.
10. Call order: `lv_init()` → display/input init → `ui_init()`; per loop `lv_timer_handler()` →
    `ui_tick()`.
11. *(no-flow)* Keep `action_*` / `get_var_*` implementations **outside `src/ui`** so rebuilds don't
    wipe them.
12. Set the resolution in **both** the Page and Settings.

**Version discipline**
13. Pick LVGL **8.x vs 9.x at creation and stay consistent** — flag/enum/state bit layouts and
    color-format constants differ. When hand-editing, match existing widgets' flag strings.
14. **Every object needs a unique `objID` (GUID).** Copying a widget/style/font/action in JSON requires
    a *fresh* UUID — code and connection lines key off it. (This applies to raw-JSON editing; the MCP
    assigns IDs for you.)
15. **In LVGL projects the flow `style` object is disabled.** All styling lives in `useStyle` +
    `localStyles`.

---

## 7. Two ways to drive EEZ Studio (which to use)

| Situation | Use |
|---|---|
| **EEZ Studio is running with the project open** (the `eez-studio-mcp` tools are available) | **PREFERRED: live MCP editing.** Inspect → edit → **`render_page` self-check** → adjust. Edits appear instantly in the GUI, are undoable, and `render_page` returns EEZ's own LVGL-WASM preview as PNG (ground truth). See [`SKILL.md`](SKILL.md) §"Live editing via MCP". |
| **EEZ Studio is closed** (offline) | **Fallback: hand-edit the raw `.eez-project` JSON** using the exact serialization in [`SKILL.md`](SKILL.md), [`reference.md`](reference.md), [`rendering-rules.md`](rendering-rules.md); validate JSON and run `eez_lint.py` (static check). |

Either way, the **EEZ preview is the ground truth** for geometry/zoom/clip: the canvas preview runs the
real LVGL as WASM and blits its framebuffer, so what the preview shows is what the device shows for
those properties. Under the MCP, `render_page` captures exactly that preview.

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

**Local (for the exact JSON format & live protocol)**
- [`SKILL.md`](SKILL.md) — operational editing guide (+ the MCP live-editing section)
- [`reference.md`](reference.md) — exhaustive v3 / LVGL-8.4 serialization catalog
- [`rendering-rules.md`](rendering-rules.md) — source-cited render-correctness rules
