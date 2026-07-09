# EEZ Studio LVGL Rendering Rules (LVGL 8.4.0–9.5.0, EEZ project schema v3)

Source-cited rules for making hand-edited `.eez-project` files render correctly on the
device (and in the EEZ canvas preview). Every rule traces to EEZ Studio source in
`packages/project-editor/lvgl/…`. These complement the format guide in the
`eez-project-editor` skill; this file is specifically about **why a JSON-valid file still
renders wrong**.

**Version note:** these rules cover LVGL **8.4.0 through 9.5.0** (bridge default `8.4.0`);
version-specific codegen differences (e.g. `lv_img_set_zoom` v8 vs `lv_image_set_scale` v9,
and the `OVERFLOW_VISIBLE` bit) are called out inline. `v3` above is the **EEZ project
schema `projectVersion`** — it is unrelated to the LVGL major version. **Scope:** everything
here is about pixel/geometry rendering, so it applies equally to **flow and no-flow** LVGL
projects. Where a widget property is flow-controlled (expression-bound), it is still laid out
by the same rules below; the bound value simply supplies the number at runtime.

---

## 1. Image scaling — the CORRECT way to show a bitmap at a non-native size

**The core fact:** `LVGLImageWidget` draws its bitmap at **native pixel size**, positioned
inside the fixed widget box, and clips to that box. The widget's `width`/`height` do **not**
scale the bitmap. Scaling is driven only by the dedicated `zoom` field, which emits
`lv_img_set_zoom(obj, zoom)` (v8) / `lv_image_set_scale` (v9) directly.
*(cite: Image.tsx:390–394 zoom codegen; Image.tsx:164–167 `content`-unit defaults;
Image.tsx:414–419 sizeMode.)*

### The zoom scale (memorize this)
- **`zoom = 256` is 1× (100%). NOT 0.** `<256` shrinks, `>256` enlarges. Default is 256.
  *(gotcha: zoom default is 256, not 0.)*
- Formula: **`zoom = round(targetPx / nativePx × 256)`**.
- The `zoom` value applies to BOTH axes uniformly (single scalar).

### The "zoom doesn't scale" mystery — RESOLVED
`widthUnit`/`heightUnit` default to `"content"`, meaning **the widget box size is decoupled
from the bitmap**. Zoom does **not** auto-expand the widget bounds. So if you zoom past the
box, LVGL renders the scaled bitmap but the box clips it — you see only the top-left corner
("cut-off logo" symptom). Zoom *is* scaling; the box just isn't following.
*(cite: Image.tsx:164–167; sizeMode VIRTUAL/innerAlign CENTER position inside fixed bounds.)*

**The correct recipe (both must agree):**
1. Set `zoom = round(target/native × 256)`.
2. Set the widget `width`/`height` (with `widthUnit`/`heightUnit = "px"`) to the **scaled**
   size so the box contains the zoomed bitmap.

**Worked example — a wide logo bitmap (verified correct):**
`logo_w_480` is natively **480×101** px. It is shown at **340×72** px with
`zoom = 181`.
- Check: `480 × 181/256 = 339.4 ≈ 340` and `101 × 181/256 = 71.4 ≈ 72`. ✔
- The box matches the scaled bitmap, so nothing clips. This is the *right* pattern.
- Had the box been left at 480×101 (or `content`) with zoom 181, the bitmap would render at
  340×72 inside a 480×101 box (letterboxed), or if the box were 340×72 with zoom 256 it
  would show a cropped 340×72 slice of the 480px bitmap.

**Do NOT use style `transform_zoom` for images.** The Image widget's `toLVGLCode()` ignores
`transform_zoom`; only the widget's own `zoom` field is honored.
*(cite: Image.tsx:390–394; style-catalog.tsx:407–419 transform_zoom is for generic styling,
not consumed by the Image widget.)*

### Alternative to zoom
Set `sizeMode="REAL"` (v8) / `innerAlign="STRETCH"` (v9) to make the widget auto-scale the
bitmap to the box. But the project's convention is the explicit zoom+matched-box recipe
above — keep it consistent. *(cite: lvgl-constants.ts:799–802 SIZE_MODE enum.)*

### Native size source
The bitmap's true W×H lives in the generated LVGL image header (`.header.w` / `.header.h`,
2×16-bit). LVGL reads it on `lv_img_set_src`; it is independent of zoom/sizeMode. For a
hand-edit workflow, read native size straight from the base64 PNG's IHDR (bytes 16–24).
*(cite: lv_img_conv/lib/convert.ts:18–19, 353–354.)*

### Rotation (bonus)
`angle` unit is **0.1°** (`450` = 45°, not raw degrees). **To rotate around the image CENTER
(the usual case) just set `angle` and leave `setPivot: false`** — that is the EEZ default (the
field is literally labelled *"Change pivot point (default is center)"*), and with
`setPivot:false` EEZ emits **no** `lv_img_set_pivot`, so LVGL rotates about the center.
**Do NOT enable `setPivot` and set the pivot to the center — it is redundant.** Only set
`setPivot: true` (+ `pivotX/pivotY`) when you want a **non-center** pivot.
**Raw-JSON gotcha:** if you hand-write an Image object and OMIT `setPivot`, EEZ's
beforeLoadHook forces `setPivot:true` while `pivotX/pivotY` stay `0,0` → rotation about the
**top-left**, flinging the image out of its box (a sliver in the corner). So in raw JSON always
write `setPivot: false` explicitly for centered rotation. *(cite: Image.tsx:75–76 label +
pivotX/Y disabled unless setPivot, :168 default `false`, :306–311 pivot emitted only if
setPivot, :397–403 angle, :190–191 hook forces true only when the field is undefined.)*

---

## 2. The Spinner widget — real schema

`LVGLSpinnerWidget` has **no custom properties** (`properties: []` in classInfo). Animation
is fully internal to LVGL's spinner renderer; there are **no gif/anim fields to set**.
- v9: `lv_spinner_create(parent)` (no timing args).
- v8: `lv_spinner_create(parent, SPIN_TIME=1000, ARC_LENGTH=60)`.
- Parts: `[MAIN, INDICATOR]`. Style the arc via the `INDICATOR` part (`arc_color`,
  `arc_width`, `arc_rounded`), and the track via `MAIN`.
*(cite: Spinner.tsx:14–20 classInfo, 43–50 parts/flags, 59–71 toLVGLCode.)*

So: a spinner "spins" by itself once created — do not look for an animation property. To
change its look, drive `MAIN`/`INDICATOR` arc styles only.

---

## 3. Label sizing — how to keep text from clipping

A label's text is drawn at the **font's line-height**. If the label's fixed pixel height is
smaller than that line-height, the glyph tops/bottoms (ascenders/descenders) clip.

- **Line-height source (exact):** each `fonts[i]` entry carries a real **`height`** field
  (plus `ascent`/`descent`). Use that. In the current project:
  `roboto16 → 21`, `roboto22 → 27`, `roboto28 → 36`, `roboto44 → 54`.
- **Approximation when `height` is absent:** `lineHeight ≈ round(size × 1.3)`.
- **Rule:** if `heightUnit == "px"`, require `height >= fontLineHeight`. Better: set
  `heightUnit = "content"` (`LV_SIZE_CONTENT`) so the label auto-sizes to the text and can
  never clip vertically. *(cite: Base.tsx:1563–1577 getLvglCreateRect — `content` →
  LV_SIZE_CONTENT.)*
- **`longMode` does NOT save you.** `LV_LABEL_LONG_CLIP/WRAP/DOT` only govern overflow inside
  the label's own bounds; it can't defeat a too-short box or a clipping parent.

**Live example in this project:** many `MainControl` labels use `roboto28` (line-height 36)
in a `height=30px` box → the digits/caps clip at top and bottom. Fix: raise height to ≥36 or
switch to `heightUnit="content"`.

---

## 4. `align` vs `left`/`top` positioning

- The style prop **`align`** compiles to `lv_obj_set_align` → it repositions the **whole
  widget** relative to its **parent anchor** and **overrides `left`/`top`** (they become
  offsets from the anchor, not parent-relative absolute coords).
  *(cite: style-catalog.tsx:309–347 align_property_info; :281–307 x/y are "considering the
  set align"; style-definition.tsx:809–876 emits `lv_style_set_align`.)*
- Default is `LV_ALIGN_DEFAULT` → top-left (LTR). With default align, `left`/`top` are plain
  parent-relative pixels. *(cite: style-catalog.tsx:315–316.)*
- 21 enum values exist (`TOP_LEFT/MID/RIGHT`, `CENTER`, `LEFT_MID`, `RIGHT_MID`,
  `BOTTOM_*`, plus 11 `OUT_*`). All stored bare (no `LV_` prefix).
- **To center TEXT inside a label, use `text_align` (LEFT｜CENTER｜RIGHT), never `align`.**
  `align` moves the label; `text_align` centers glyphs within it.
- **Symptom of misuse:** put `align: CENTER` on two children of the same small parent and
  both jump to the parent's center and overlap. Position both by explicit `left`/`top`
  instead. *(This is why the linter WARNs on ANY `align` key.)*
- `align` is applied via a **style** (`lv_obj_add_style`), so it affects every widget that
  style is added to — a shared style carrying `align` will move all its users.

Child `left`/`top` are always parent-relative (percent → relative to parent content area).
Exception: geometry controlled by parent layout (dropdown/tabview/Tab children) skips
`lv_obj_set_pos/size` entirely. *(cite: widget-common.tsx:199–208 isGeometryControlledByParent;
build.ts:1245–1246.)* Screen root geometry comes from `Page.rect`, not the Screen widget's
own properties. *(cite: Screen.tsx:16–57; Base.tsx:1564–1566; build.ts:1239–1252.)*

---

## 5. Panel / child clipping — causes and avoidance

- **Panels and Containers clip children by default** because their `defaultFlags` include
  `SCROLLABLE`. `SCROLLABLE` *enables scrolling*, and clipping children to the parent
  boundary is its side-effect. *(cite: Panel.tsx:47, Container.tsx:117 defaultFlags include
  `SCROLLABLE`.)*
- **To disable clipping, add the `OVERFLOW_VISIBLE` flag** to the parent's `widgetFlags` —
  do NOT just remove `SCROLLABLE`. `OVERFLOW_VISIBLE` is the authoritative "don't clip
  children" flag. **Bit layout differs by version: `1<<19` in v8.4, `1<<20` in v9.0+** —
  keep the string form (`"OVERFLOW_VISIBLE"`) and let codegen pick the bit; a wrong raw bit
  breaks it. *(cite: lvgl-constants.ts:225, 248.)*
- **`clip_corner` is NOT general clipping.** It only clips content on rounded corners and
  only does anything when the parent has a `radius`. *(cite: style-catalog.tsx:2413–2427.)*
- **Padding shrinks the content area, not the parent.** `pad_bottom` (and the other pads)
  make the content box smaller in that direction, so a child near the bottom edge clips even
  though the parent height is unchanged. If a label clips at the bottom: either its
  `y + textHeight` exceeds `parentHeight − pad_bottom`, or the parent is simply too short.
  *(cite: style-catalog.tsx:957–970 pad_bottom `layout:true`; Container.tsx:285–287.)*
- **`extDraw:false`** on all clip/pad/border styles means content never draws beyond the
  parent boundary — it must fit within `parentSize − padding`. *(cite: style-catalog.tsx
  clip_corner:2425, pad_bottom:968.)*
- **Container auto-padding trap:** `Container.tsx` applies default `pad_*` to new Container
  instances when `containerVersion != 1`, silently reducing usable space.

**Avoidance checklist:** ensure `parentHeight ≥ maxChildBottom + pad_bottom` (and same for
width/right); add `OVERFLOW_VISIBLE` when a child legitimately needs to draw past the parent;
don't rely on `clip_corner` for anything but rounded-corner masking.

---

## 6. Glyphs outside the font range render as ▯ boxes

A character not covered by the font's `lvglRanges`/`lvglSymbols` renders as an empty box.
- `lvglRanges` is a comma list of decimal or `0x` hex ranges, e.g. `"32-127,192-383"`
  (ASCII + Latin-1 Supplement + Latin Extended-A — covers Turkish ç ı ş ğ ü ö İ).
- Common traps: Unicode MINUS `−` (U+2212) — use ASCII hyphen `-` (U+002D); arrows
  `←↑→↓`; diamond `◆`. Add the glyph to the font's Symbols or use an image asset instead.
- **Per-font, not per-project:** in the current project `roboto44` only has range
  `32-127`, so any Turkish accented letter set in a roboto44 label will box out, even though
  roboto16/22/28 (range `32-127,192-383`) render it fine.

---

## 7. Preview vs device differences

- The EEZ canvas **preview runs the real LVGL as WASM** and blits the framebuffer via
  `putImageData()`. It does **not** pre-scale bitmaps or compute transforms in JS — all
  zoom/rotate/clip is done by LVGL itself. *(cite: page-runtime.ts:897–932 tick,
  754–778 init.)*
- Consequence: **what the preview shows is what the device shows** for geometry/zoom/clip —
  the preview is trustworthy for these. Real divergences come from *outside* LVGL's
  computation: fonts embedded/subset differently, a bitmap re-encoded at a different bpp, or
  a build-time `sizeMode` the preview and target evaluate under different LVGL minor
  versions. Version-sensitive items to watch: `OVERFLOW_VISIBLE` bit (v8 vs v9) and the
  zoom/scale function name (`lv_img_set_zoom` v8 vs `lv_image_set_scale` v9).

---

## 8. Widget gotchas (buttons, steppers, textareas, hit areas)

Learned live/from source — see `LEARNINGS.md` for the full evidence. Apply these proactively:

- **A Button ships a default "Button" label.** `create_widget { type: "LVGLButtonWidget" }` auto-inserts
  a child `LVGLLabelWidget` with `text:"Button"`, `identifier:null` (`Button.tsx` defaultValue children).
  If you add your own icon/label, the stray "Button" still renders behind it. **After creating any
  button, `get_widget` it and `delete_widget` the child label whose `text==="Button"` and
  `identifier==null`.**
- **Zero a Button/Panel's four pads before absolute-positioning children.** LVGL's default theme gives a
  Button non-zero `MAIN` padding, and EEZ measures a child's `left`/`top` from the **content box** (inside
  the pad), so hand-placed children land offset (e.g. `+16,+10` on a fresh button). Set
  `pad_left/pad_top/pad_right/pad_bottom: 0` on the button's `MAIN/DEFAULT` local style (there is no
  `pad_all` serialized prop — set all four) so child `left`/`top` map from the true top-left. `align:CENTER`
  children are pad-immune (which is why a centered child looks fine while `left`/`top` ones shift).
- **A variable-length readout between fixed controls needs a fixed-width box + `text_align CENTER`.** A
  `content`-width label re-sizes per value ("30 sn" vs "180 sn"), so a hand-centred content label drifts
  and crowds the − / + buttons. Give the label a **fixed `px` width == the gap** between the controls,
  keep its anchor, and set `text_align: CENTER` — the box never moves and any string stays centred.
- **LVGL 8.4: never style a Textarea's `CUSTOM1` / `TEXTAREA_PLACEHOLDER` part.** EEZ emits
  `LV_PART_CUSTOM1`, which is **undeclared in LVGL 8.4** → generated `screens.c` fails to compile
  (`'LV_PART_CUSTOM1' undeclared`). `run_checks`/`render_page` do NOT catch it — it only breaks at C
  compile time. On 8.4 only `MAIN`, `CURSOR`, `SELECTED`, `SCROLLBAR` are safe on a Textarea; leave the
  placeholder at its default muted colour. (On 9.x `CUSTOM1` compiles, so it's fine there.) Read
  `lvglVersion` from `get_project_info` first.
- **Extended touch area → use `set_ext_click_area`.** `ext_click_area` is **not** a style/property in
  EEZ's model (only a runtime call), so `set_style` / `update_widget` / `localStyles` can't set it — don't
  try. Use the dedicated tool **`set_ext_click_area({ objID | identifier, size })`**: it injects a
  self-managed `lv_obj_set_ext_click_area(objects.<id>, size)` into the `ui.c` build template that runs once
  the object exists (survives rebuilds; `size:0` removes it). The widget **must have an `identifier`** — set
  one with `set_identifier` first if it doesn't.

---

## Quick reference — working field values

| Goal | Field(s) | Correct value |
|---|---|---|
| Show 480×101 bitmap at 340×72 | `zoom` + `width`/`height` | `zoom:181`, `width:340,height:72`, units `px` |
| 1× (native) image | `zoom` | `256` |
| Rotate image 90° about center | `angle` (leave `setPivot:false`) | `angle:900` |
| Rotate image about a NON-center pivot | `angle`,`setPivot`,`pivotX/Y` | `angle:900,setPivot:true,pivotX:10,pivotY:10` |
| Label never clips vertically | `heightUnit` | `"content"` (or `height ≥ font.height`) |
| Center text in label | `text_align` (MAIN/DEFAULT) | `"CENTER"` (leave `align` unset) |
| Stop parent clipping a child | parent `widgetFlags` | add `OVERFLOW_VISIBLE` |
| Spinner look | `INDICATOR`/`MAIN` arc styles | no anim field exists |
