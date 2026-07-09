# eez-project-editor — learnings log

Durable, **source-verified** corrections the `eez-editor` agent has captured while working —
things its guidance got wrong or was missing. Newest first. Each entry records what was
believed, the correction, and a `studio/packages/**` (EEZ source) `file:line` citation or a
reproduced live result. See the agent's **Self-learning** protocol
(`.claude/agents/eez-editor.md`); apply with `node tools/learn.mjs` and publish with
`node tools/learn.mjs --public "<summary>"`.

Only add an entry that is (a) a general EEZ/LVGL fact, not a one-off project quirk,
(b) verified against source or a live repro, and (c) actionable for a future run.

---

## 2026-07-07 — A `LVGLButtonWidget` has DEFAULT PADDING that offsets its absolutely-positioned children
**Was believed (implicitly):** a child's `left`/`top` inside a button map 1:1 to the button's own
top-left corner, so a child at `left:10, top:10` sits 10 px in from the button edge.
**Correction (reproduced live via `render_page` + pixel-analysis on an LVGL 8.4 project):** the LVGL
default theme applies **non-zero padding to a Button** (`LV_PART_MAIN` pad), and EEZ measures a child's
`left`/`top` from the button's **content box** (inside the padding), not the border box. A 20×20 child
set to `left:10, top:10` on a freshly-created 48×48 button whose local style only set
`bg_color`/`radius`/`shadow_width` rendered at button-local **(26,20)** — an offset of ~(+16,+10) —
so every primitive I placed by hand landed in the wrong spot and appeared "invisible"/detached from an
`align:CENTER` sibling (which is padding-immune). Setting `pad_left/pad_top/pad_right/pad_bottom: 0` in
the button's `MAIN/DEFAULT` style made child coords map 1:1 to the button's top-left, and the icon
built from primitives landed exactly where computed. (This is the same "zero all four pads on any
panel/button that hosts absolutely-positioned children" rule the design-rules doc already states for
Panels — it applies to **Buttons too**, and the default button pad is *large enough to matter* at icon
scale.) `align:CENTER` children are unaffected because align ignores padding, which is why the existing
centered arc looked fine while my left/top primitives were shifted.
**Action:** before positioning any child by explicit `left`/`top` inside a `LVGLButtonWidget`, add
`pad_left/pad_top/pad_right/pad_bottom: 0` to the button's `MAIN/DEFAULT` local style (there is no
`pad_all` serialized prop — set the four). Then child left/top are measured from the button's true
top-left. Verify with `render_page` + pixel analysis, not eyeballing a tiny native-size render.

---

## 2026-07-07 — A value/readout label between +/− steppers must be a FIXED-WIDTH box + `text_align CENTER`
**Was believed (implicitly):** it's fine to size a stepper's value label with `widthUnit: content`
and hand-centre it (e.g. `align RIGHT_MID` at a computed `left`) between the − and + buttons.
**Correction (reproduced live via `render_page` on an LVGL 8.4 project):** a content-width label
resizes itself to the *current* string, so a hand-centred content label **re-centres per value** — its
box grows/shrinks as the number's digit-count changes ("30 sn" vs "180 sn"), shifting the text
left/right and crowding the − or + button. The stable fix is a **fixed `px`-width box** that exactly
spans the inter-button gap, with `text_align: CENTER` (and the widget's own anchor kept, e.g.
`align RIGHT_MID`), so the box never moves and any string is centred within it. Verified: `s_sleep_val`
set to `width 84, left -64, RIGHT_MID, text_align CENTER` (spanning abs x 312→396 between the − and +
buttons) keeps "15 sn"…"180 sn" centred with the buttons fixed; the prior content-width version drifted.
**Action:** for ANY value/readout label positioned between +/− stepper buttons (or between any two fixed
controls), give it a fixed-width box == the gap and `text_align CENTER`. Do NOT rely on content-width +
manual centring. This is distinct from single centred children (which correctly use content + `align
CENTER`) — it applies when the string length varies at runtime and the box must not move.

## 2026-07-07 — Styling a Textarea PLACEHOLDER part breaks the build on LVGL 8.4
**Was believed:** to make a textarea placeholder muted, style the `CUSTOM1` part (alias
`TEXTAREA_PLACEHOLDER`) with a `text_color` — treated as a normal, safe part.
**Correction (reproduced live on an LVGL 8.4 project):** EEZ generates the textarea placeholder
style as `LV_PART_CUSTOM1`, e.g. `lv_obj_set_style_text_color(obj, ..., LV_PART_CUSTOM1 |
LV_STATE_DEFAULT);`. `LV_PART_CUSTOM1` is an **LVGL-9 part and is UNDECLARED in LVGL 8.4**, so the
generated `screens.c` fails to compile: `error: 'LV_PART_CUSTOM1' undeclared`. LVGL 8.4 has no
user-settable textarea-placeholder colour part. `run_checks` and `render_page` do NOT catch this — it
only surfaces at C compile time, so it must be avoided by construction.
**Action:** on an **8.4** project (`lvglVersion` "8.4.x", read from `get_project_info`), do NOT set
any style on a Textarea's `CUSTOM1` / `TEXTAREA_PLACEHOLDER` part. Only `MAIN`, `CURSOR`, `SELECTED`,
`SCROLLBAR` are safe. The placeholder then renders in LVGL's default muted colour (acceptable). Check
this whenever a Textarea is added. (On LVGL 9.x `CUSTOM1` compiles, so placeholder styling is fine
there.)
**Cite:** live repro (WiFi page, `w_pw_field`, EEZ 0.28.0, LVGL 8.4) — coordinator-reported compile
error `screens.c:3060 'LV_PART_CUSTOM1' undeclared`; fixed by clearing the `CUSTOM1` cell,
`LV_PART_CUSTOM1` then absent from `screens.c`. Part alias: `reference.md` PART keys
(`CUSTOM1` = `TEXTAREA_PLACEHOLDER`).

---

## 2026-07-07 — `create_widget` on a Button auto-inserts a child "Button" label
**Was believed:** creating an `LVGLButtonWidget` via the MCP gives an empty button; you then add
your own icon/label child.
**Correction (reproduced live, EEZ 0.28.0 bridge):** every `create_widget { type:
"LVGLButtonWidget" }` also auto-inserts a child `LVGLLabelWidget` with `text:"Button"` and no
identifier — EEZ's default button content. If you add your own child on top, the stray "Button" still
renders (centered) behind/beside it and shows up in `render_page` (looks like a style bug, isn't).
**Action:** after creating ANY button, `get_widget` it, find the child label whose `text==="Button"`
and `identifier==null`, and `delete_widget` it. Reproduced deterministically: 8/8 freshly created
buttons on one page each carried this label; deleting all 8 cleared the render. A finished button that
still shows "Button" in a render just has this default child not yet removed.
**Cite:** `studio/packages/project-editor/lvgl/widgets/Button.tsx:25-38` —
`LVGLButtonWidget.classInfo.defaultValue.children` = `[{ type:"LVGLLabelWidget", text:"Button" }]`;
also reproduced live (WiFi page build, 2026-07-07, EEZ 0.28.0). Applies to any project/version via
the bridge.

---

## 2026-07-06 — Image rotation pivots around the CENTER by default
**Was believed:** for any `angle ≠ 0` you must set `setPivot: true` and `pivotX/pivotY` to the
image center, or the image "flies off around (0,0)".
**Correction:** EEZ's Image widget defaults `setPivot: false`, and the field is labelled
*"Change pivot point (default is center)"*; with `setPivot:false` the codegen emits **no**
`lv_img_set_pivot`, so LVGL rotates about the **center**. To rotate around center just set
`angle` and leave `setPivot:false`. Enabling `setPivot` + center coords is **redundant**; only
set `setPivot:true` for a **non-center** pivot.
**Real nuance (raw-JSON only):** the `beforeLoadHook` forces `setPivot:true` **only when the
field is entirely omitted** — leaving `pivotX/pivotY` at `0,0` → top-left fly-off. So raw JSON
must write `setPivot:false` explicitly for centered rotation.
**Cite:** `studio/packages/project-editor/lvgl/widgets/Image.tsx:76` (label), `:168` (default
false), `:306–311` (pivot emitted only if `setPivot`), `:190–191` (hook forces true only when
undefined). Fixed in commit 616a29d across SKILL.md / rendering-rules.md / eez-studio-usage.md /
reference.md.
