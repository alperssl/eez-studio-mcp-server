#!/usr/bin/env python3
"""
eez_lint.py -- static RENDER linter for an EEZ Studio v3 LVGL (.eez-project) file.

Stdlib only. Usage:  python eez_lint.py path/to/file.eez-project

Walks the widget tree, computes ABSOLUTE positions (respecting parent nesting and
the 'align' style), and reports PASS/WARN/FAIL per check with the offending widget's
identifier / type / coords. Exits non-zero if any FAIL.

Checks:
  (a) IMAGE_SCALE   Image displayed size != native bitmap px size unless zoom compensates.
  (b) LABEL_CLIP    Label fixed px height < font line-height  -> text clip.
  (c) STYLE_ALIGN   Any 'align' key present on a widget style -> overrides left/top.
  (d) GLYPH_RANGE   Label text glyph outside its font's lvglRanges/lvglSymbols -> box.
  (e) CHILD_OVERFLOW Child (l,t,w,h) overflows parent's content box (parent size - padding).
  (f) SIBLING_OVERLAP Overlapping sibling widgets under the same parent.
"""

import json
import base64
import struct
import re
import sys

# ---- tunables -------------------------------------------------------------
ZOOM_UNIT = 256                 # LVGL zoom: 256 == 1x
ZOOM_TOL_PX = 2                 # px tolerance when comparing displayed vs scaled native size
LINEHEIGHT_FACTOR = 1.3         # fallback line-height = round(size * factor) when font.height absent
CONTAINER_CLIPPING_TYPES = {"LVGLPanelWidget", "LVGLContainerWidget", "LVGLScreenWidget"}
# widget types that are commonly full-bleed background/fill layers -> ignore for overlap
BG_HINT_RE = re.compile(r"(bg|background|fill|overlay|backdrop|card|panel_bg)", re.I)

# ---- result plumbing ------------------------------------------------------
PASS, WARN, FAIL = "PASS", "WARN", "FAIL"

class Report:
    def __init__(self):
        self.items = []  # (check, level, msg)
    def add(self, check, level, msg):
        self.items.append((check, level, msg))
    def by_check(self, check):
        return [i for i in self.items if i[0] == check]
    def worst(self):
        levels = {PASS: 0, WARN: 1, FAIL: 2}
        w = PASS
        for _, lvl, _ in self.items:
            if levels[lvl] > levels[w]:
                w = lvl
        return w


# ---- helpers --------------------------------------------------------------

def png_native_size(image_field):
    """Return (w,h) from a base64 (data-URI or raw) PNG, or None."""
    if not isinstance(image_field, str) or not image_field:
        return None
    b64 = image_field.split("base64,", 1)[1] if "base64," in image_field else image_field
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    # IHDR width/height live at bytes 16..24 (two big-endian uint32)
    try:
        w, h = struct.unpack(">II", raw[16:24])
        return (w, h)
    except struct.error:
        return None


def parse_ranges(lvgl_ranges):
    """Parse '32-127,192-383' (dec or 0x hex) into a list of (lo,hi) inclusive tuples."""
    out = []
    if not lvgl_ranges:
        return out
    for part in str(lvgl_ranges).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            lo, hi = _num(a), _num(b)
        else:
            lo = hi = _num(part)
        if lo is not None and hi is not None:
            out.append((lo, hi))
    return out


def _num(s):
    s = s.strip()
    try:
        return int(s, 16) if s.lower().startswith("0x") else int(s)
    except ValueError:
        return None


def codepoint_covered(cp, ranges, symbols):
    for lo, hi in ranges:
        if lo <= cp <= hi:
            return True
    if symbols and chr(cp) in symbols:
        return True
    return False


def widget_label(w):
    ident = w.get("identifier")
    t = w.get("type", "?")
    return f"{t}[{ident}]" if ident else t


def style_defs(w):
    """Yield (part, state, propsdict) for each localStyles definition on a widget."""
    ls = w.get("localStyles")
    if not isinstance(ls, dict):
        return
    dfn = ls.get("definition")
    if not isinstance(dfn, dict):
        return
    for part, states in dfn.items():
        if not isinstance(states, dict):
            continue
        for state, props in states.items():
            if isinstance(props, dict):
                yield part, state, props


def label_font(w):
    """text_font referenced by a label's localStyles, if any."""
    for _, _, props in style_defs(w):
        if "text_font" in props:
            return props["text_font"]
    return None


def label_padding(w):
    """Return (l,t,r,b) padding declared in MAIN/DEFAULT-ish style, best effort."""
    pad = {"pad_left": 0, "pad_top": 0, "pad_right": 0, "pad_bottom": 0}
    for part, state, props in style_defs(w):
        if part != "MAIN":
            continue
        for k in pad:
            if isinstance(props.get(k), (int, float)):
                pad[k] = max(pad[k], int(props[k]))
    return pad["pad_left"], pad["pad_top"], pad["pad_right"], pad["pad_bottom"]


def has_overflow_visible(w):
    flags = w.get("widgetFlags", "") or ""
    return "OVERFLOW_VISIBLE" in flags


def get_align(w):
    """Return the align enum value from any style on the widget, else None."""
    for _, _, props in style_defs(w):
        if "align" in props:
            return props["align"]
    return None


# align enum -> anchor factor (fx, fy) of the parent box for the widget's origin
ALIGN_ANCHOR = {
    "DEFAULT": (0.0, 0.0), "TOP_LEFT": (0.0, 0.0), "TOP_MID": (0.5, 0.0),
    "TOP_RIGHT": (1.0, 0.0), "BOTTOM_LEFT": (0.0, 1.0), "BOTTOM_MID": (0.5, 1.0),
    "BOTTOM_RIGHT": (1.0, 1.0), "LEFT_MID": (0.0, 0.5), "RIGHT_MID": (1.0, 0.5),
    "CENTER": (0.5, 0.5),
}


def resolve_pos(w, parent_abs_x, parent_abs_y, parent_w, parent_h):
    """
    Compute this widget's absolute (x,y) given parent absolute origin+size.
    Respects 'align' (anchor within parent, with left/top as offsets) when present.
    """
    left = w.get("left", 0) or 0
    top = w.get("top", 0) or 0
    ww = w.get("width", 0) or 0
    wh = w.get("height", 0) or 0
    align = get_align(w)
    if align:
        base = align.split("|")[0].strip()
        fx, fy = ALIGN_ANCHOR.get(base, (0.0, 0.0))
        ax = parent_abs_x + int(parent_w * fx) - int(ww * fx) + left
        ay = parent_abs_y + int(parent_h * fy) - int(wh * fy) + top
        return ax, ay
    return parent_abs_x + left, parent_abs_y + top


# ---- checks ---------------------------------------------------------------

def lint(project, rep):
    fonts = {f.get("name"): f for f in project.get("fonts", []) if isinstance(f, dict)}
    bitmaps = {}
    for b in project.get("bitmaps", []):
        if isinstance(b, dict):
            size = png_native_size(b.get("image"))
            bitmaps[b.get("name")] = size

    # font -> line height
    def font_lineheight(name):
        f = fonts.get(name)
        if not f:
            return None, None
        h = f.get("height")
        if isinstance(h, (int, float)) and h > 0:
            return int(h), False  # exact
        size = (f.get("source") or {}).get("size")
        if isinstance(size, (int, float)):
            return round(size * LINEHEIGHT_FACTOR), True  # approx
        return None, None

    def font_ranges(name):
        f = fonts.get(name)
        if not f:
            return [], ""
        return parse_ranges(f.get("lvglRanges")), (f.get("lvglSymbols") or "")

    a_hits = b_hits = c_hits = d_hits = e_hits = f_hits = 0

    def walk(w, px, py, pw, ph, siblings_accum):
        nonlocal a_hits, b_hits, c_hits, d_hits, e_hits, f_hits
        wx, wy = resolve_pos(w, px, py, pw, ph)
        ww = w.get("width", 0) or 0
        wh = w.get("height", 0) or 0
        wtype = w.get("type")

        # (c) STYLE_ALIGN
        align = get_align(w)
        if align:
            c_hits += 1
            rep.add("STYLE_ALIGN", WARN,
                    f"{widget_label(w)} has style align='{align}' (overrides left/top; "
                    f"anchors to parent). abs~=({wx},{wy})")

        # (a) IMAGE_SCALE
        if wtype == "LVGLImageWidget":
            _image_check(w, ww, wh, bitmaps, rep)
            # count fails/warns via rep after; track hits by scanning last item
        # (b) LABEL_CLIP + (d) GLYPH_RANGE
        if wtype == "LVGLLabelWidget":
            _label_checks(w, ww, wh, font_lineheight, font_ranges, rep)

        # descend, tracking children for overflow + overlap
        children = w.get("children", []) or []
        # content box of THIS widget (for its children): subtract padding
        pl, pt, pr, pb = label_padding(w) if wtype in CONTAINER_CLIPPING_TYPES else (0, 0, 0, 0)
        content_x, content_y = wx + pl, wy + pt
        content_w, content_h = ww - pl - pr, wh - pt - pb
        clips = (wtype in CONTAINER_CLIPPING_TYPES) and not has_overflow_visible(w)

        child_boxes = []
        for ch in children:
            cx, cy = resolve_pos(ch, content_x, content_y, content_w, content_h)
            cw = ch.get("width", 0) or 0
            chh = ch.get("height", 0) or 0
            child_boxes.append((ch, cx, cy, cw, chh))

            # (e) CHILD_OVERFLOW -- only meaningful if this parent clips
            if clips and not get_align(ch):
                over = []
                if (cx - content_x) < 0:
                    over.append("left")
                if (cy - content_y) < 0:
                    over.append("top")
                if cw and (cx - content_x) + cw > content_w:
                    over.append(f"right(+{(cx - content_x) + cw - content_w}px)")
                if chh and (cy - content_y) + chh > content_h:
                    over.append(f"bottom(+{(cy - content_y) + chh - content_h}px)")
                if over:
                    e_hits_local(rep, ch, wx, wy, ww, wh, cx, cy, cw, chh, over)

        # (f) SIBLING_OVERLAP -- pairwise among these children
        _overlap_check(child_boxes, rep)

        for ch, cx, cy, cw, chh in child_boxes:
            walk(ch, content_x, content_y, content_w, content_h, None)

    def e_hits_local(rep, ch, pwx, pwy, pww, pwh, cx, cy, cw, chh, over):
        rep.add("CHILD_OVERFLOW", FAIL,
                f"{widget_label(ch)} at abs({cx},{cy}) {cw}x{chh} overflows parent "
                f"content box (parent abs {pwx},{pwy} {pww}x{pwh}) on {', '.join(over)}")

    # roots = each page's LVGLScreenWidget component(s)
    for page in project.get("userPages", []):
        prect = (page.get("left", 0), page.get("top", 0),
                 page.get("width", 0), page.get("height", 0))
        for comp in page.get("components", []):
            # screen widget uses page rect as its box
            sw = comp.get("width", prect[2]) or prect[2]
            sh = comp.get("height", prect[3]) or prect[3]
            walk(comp, 0, 0, sw, sh, None)

    # tally per-check counts from report
    for check in ("IMAGE_SCALE", "LABEL_CLIP", "STYLE_ALIGN", "GLYPH_RANGE",
                  "CHILD_OVERFLOW", "SIBLING_OVERLAP"):
        pass  # counts derived from rep in printing


def _image_check(w, ww, wh, bitmaps, rep):
    img = w.get("image")
    if not img:
        rep.add("IMAGE_SCALE", WARN, f"{widget_label(w)} has no image assigned.")
        return
    native = bitmaps.get(img)
    if native is None:
        rep.add("IMAGE_SCALE", WARN,
                f"{widget_label(w)} image '{img}' native size unknown (not a decodable PNG).")
        return
    nw, nh = native
    zoom = w.get("zoom", ZOOM_UNIT)
    if not isinstance(zoom, (int, float)) or zoom <= 0:
        zoom = ZOOM_UNIT
    disp_w = nw * zoom / ZOOM_UNIT
    disp_h = nh * zoom / ZOOM_UNIT
    dw_ok = abs(disp_w - ww) <= ZOOM_TOL_PX
    dh_ok = abs(disp_h - wh) <= ZOOM_TOL_PX
    if dw_ok and dh_ok:
        if zoom != ZOOM_UNIT:
            # EMPIRICAL: non-native zoom does NOT reliably scale in this LVGL/EEZ preview
            # (a zoom-181 logo rendered clipped to native size, while native-size 60x60
            # arrows/chevrons rendered fine). Box math agrees but render does not. Prefer
            # a pre-scaled native bitmap at zoom 256.
            rep.add("IMAGE_SCALE", WARN,
                    f"{widget_label(w)} '{img}' uses zoom {zoom} (box {ww}x{wh} matches the "
                    f"scaled math, BUT non-native zoom does NOT reliably render-scale here -> "
                    f"clip risk). PREFER a native-size bitmap ({ww}x{wh}) at zoom 256.")
        else:
            rep.add("IMAGE_SCALE", PASS,
                    f"{widget_label(w)} '{img}' native {nw}x{nh}, zoom {zoom} -> "
                    f"{disp_w:.0f}x{disp_h:.0f} == box {ww}x{wh}. OK")
    else:
        # suggest correct zoom to fit the box width (uniform)
        suggest = round(ww / nw * ZOOM_UNIT) if nw else ZOOM_UNIT
        rep.add("IMAGE_SCALE", FAIL,
                f"{widget_label(w)} '{img}' native {nw}x{nh}, zoom {zoom} -> "
                f"scaled {disp_w:.0f}x{disp_h:.0f} but box is {ww}x{wh} "
                f"-> CLIP/letterbox risk. Set box to {disp_w:.0f}x{disp_h:.0f} "
                f"OR zoom~={suggest} to fit width.")


def _label_checks(w, ww, wh, font_lineheight, font_ranges, rep):
    fnt = label_font(w)
    text = w.get("text", "")
    # (b) LABEL_CLIP
    if w.get("heightUnit") == "px" and isinstance(wh, int) and fnt:
        lh, approx = font_lineheight(fnt)
        if lh and wh < lh:
            tag = "~" if approx else ""
            rep.add("LABEL_CLIP", WARN,
                    f"{widget_label(w)} height {wh}px < font '{fnt}' line-height {tag}{lh}px "
                    f"(text={text!r:.30}) -> vertical clip. Use heightUnit='content' or "
                    f"height>={lh}.")
    # (d) GLYPH_RANGE
    if fnt and text and w.get("textType", "literal") != "expression":
        ranges, symbols = font_ranges(fnt)
        if ranges or symbols:
            bad = sorted({c for c in str(text)
                          if not codepoint_covered(ord(c), ranges, symbols)})
            if bad:
                shown = "".join(bad)[:12]
                cps = ",".join(f"U+{ord(c):04X}" for c in bad[:6])
                rep.add("GLYPH_RANGE", WARN,
                        f"{widget_label(w)} font '{fnt}' missing glyph(s) {shown!r} ({cps}) "
                        f"for text={text!r:.30} -> renders as boxes.")


TEXTUAL = ("LVGLLabelWidget", "LVGLImageWidget", "LVGLButtonWidget")


def _overlap_check(child_boxes, rep):
    n = len(child_boxes)
    for i in range(n):
        wi, xi, yi, wwi, hi = child_boxes[i]
        if not (wwi and hi):
            continue
        for j in range(i + 1, n):
            wj, xj, yj, wwj, hj = child_boxes[j]
            if not (wwj and hj):
                continue
            if not _intersect(xi, yi, wwi, hi, xj, yj, wwj, hj):
                continue
            # ignore explicit background/fill layers by identifier hint
            if _is_bg(wi) or _is_bg(wj):
                continue
            # ignore a container acting as another widget's BACKGROUND:
            # a Panel/Container whose box fully contains the sibling is a backing surface,
            # not a competing overlap. (status bars, cards, button faces, etc.)
            if _is_backing(wi, xi, yi, wwi, hi, wj, xj, yj, wwj, hj):
                continue
            if _is_backing(wj, xj, yj, wwj, hj, wi, xi, yi, wwi, hi):
                continue
            # only warn when two content/interactive widgets genuinely collide
            if wi.get("type") in TEXTUAL or wj.get("type") in TEXTUAL:
                # highlight full stacks (near-identical boxes) as the strongest signal
                stacked = (abs(xi - xj) <= 2 and abs(yi - yj) <= 2 and
                           abs(wwi - wwj) <= 2 and abs(hi - hj) <= 2)
                tag = " [FULL STACK - same cell]" if stacked else ""
                rep.add("SIBLING_OVERLAP", WARN,
                        f"{widget_label(wi)} @({xi},{yi},{wwi}x{hi}) overlaps "
                        f"{widget_label(wj)} @({xj},{yj},{wwj}x{hj}).{tag}")


def _is_backing(container, cx, cy, cw, ch, other, ox, oy, ow, oh):
    """True if `container` is a Panel/Container whose box fully encloses `other`
    (i.e. it is acting as a background surface for that sibling, not overlapping it)."""
    if container.get("type") not in ("LVGLPanelWidget", "LVGLContainerWidget"):
        return False
    return cx <= ox and cy <= oy and cx + cw >= ox + ow and cy + ch >= oy + oh


def _is_bg(w):
    ident = (w.get("identifier") or "")
    return bool(BG_HINT_RE.search(ident))


def _intersect(x1, y1, w1, h1, x2, y2, w2, h2):
    return not (x1 + w1 <= x2 or x2 + w2 <= x1 or y1 + h1 <= y2 or y2 + h2 <= y1)


# ---- main -----------------------------------------------------------------

def main(argv):
    if len(argv) < 2:
        print("usage: python eez_lint.py path/to/file.eez-project", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path, encoding="utf-8") as fh:
            project = json.load(fh)
    except Exception as exc:
        print(f"FAIL: cannot parse '{path}': {exc}", file=sys.stderr)
        return 2

    rep = Report()
    lint(project, rep)

    checks = [
        ("a", "IMAGE_SCALE", "Image displayed size vs native bitmap px (zoom compensation)"),
        ("b", "LABEL_CLIP", "Label px height vs font line-height (text clip)"),
        ("c", "STYLE_ALIGN", "Style 'align' present (overrides left/top)"),
        ("d", "GLYPH_RANGE", "Label glyphs outside font range (box risk)"),
        ("e", "CHILD_OVERFLOW", "Child overflows clipping parent's content box"),
        ("f", "SIBLING_OVERLAP", "Overlapping sibling widgets"),
    ]

    print("=" * 78)
    print(f"EEZ RENDER LINT  --  {path}")
    print("=" * 78)

    any_fail = False
    for letter, key, desc in checks:
        items = rep.by_check(key)
        fails = [i for i in items if i[1] == FAIL]
        warns = [i for i in items if i[1] == WARN]
        if fails:
            status = FAIL
        elif warns:
            status = WARN
        else:
            status = PASS
        any_fail = any_fail or bool(fails)
        print(f"\n[{letter}] {key:15s} {status:4s}  {desc}")
        # print details (cap to keep output readable)
        detail = fails + warns
        cap = 20
        for _, lvl, msg in detail[:cap]:
            print(f"     {lvl}: {msg}")
        if len(detail) > cap:
            print(f"     ... (+{len(detail) - cap} more)")
        if status == PASS:
            print("     (no issues)")

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("-" * 78)
    total_fail = total_warn = 0
    for _, key, _ in [(c[0], c[1], c[2]) for c in checks]:
        items = rep.by_check(key)
        f = sum(1 for i in items if i[1] == FAIL)
        wn = sum(1 for i in items if i[1] == WARN)
        total_fail += f
        total_warn += wn
        print(f"  {key:15s}  FAIL={f:<3d} WARN={wn:<3d}")
    print("-" * 78)
    print(f"  TOTAL           FAIL={total_fail:<3d} WARN={total_warn:<3d}")
    verdict = "FAIL" if total_fail else ("WARN" if total_warn else "PASS")
    print(f"  VERDICT: {verdict}")
    print("=" * 78)

    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
