# eez-project-editor — learnings log

Durable, **source-verified** corrections the `eez-editor` agent has captured while working —
things its guidance got wrong or was missing. Newest first. Each entry records what was
believed, the correction, and a `studio/packages/**` (EEZ source) `file:line` citation or a
reproduced live result. See the agent's **Self-learning** protocol
(`.claude/agents/eez-editor.md`); publish new entries with `node tools/learn.mjs "<summary>"`.

Only add an entry that is (a) a general EEZ/LVGL fact, not a one-off project quirk,
(b) verified against source or a live repro, and (c) actionable for a future run.

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
