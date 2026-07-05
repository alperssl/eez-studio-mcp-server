#!/usr/bin/env python3
"""
eez_render.py -- approximate PNG renderer for an EEZ Studio v3 LVGL (.eez-project).

Renders each page to a PNG using the project's REAL embedded fonts and bitmaps, and
the LVGL layout rules that matter for catching render bugs: absolute position + `align`,
content-size labels (measured with the actual font), parent clipping (SCROLLABLE unless
OVERFLOW_VISIBLE), native-size images / img_recolor / angle rotation, colors/radius/border.

It is a layout previewer (not pixel-perfect LVGL), faithful enough to SEE clipping,
overlap, sizing and positioning — what static analysis misses.

Usage:  python eez_render.py path/to/file.eez-project [out_dir]
Writes out_dir/<PageName>.png for every page.
"""
import json, base64, io, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageChops

PAGE_BG_FALLBACK = (0x1a, 0x1c, 0x20)

def parse_color(c):
    if not isinstance(c, str):
        return None
    c = c.strip()
    if c.startswith('#'):
        c = c[1:]
        if len(c) == 6:
            return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))
        if len(c) == 3:
            return tuple(int(c[i]*2, 16) for i in range(3))
    return None

def style_of(w):
    props = {}
    ls = w.get('localStyles')
    if isinstance(ls, dict):
        dfn = ls.get('definition')
        if isinstance(dfn, dict):
            main = dfn.get('MAIN')
            if isinstance(main, dict):
                d = main.get('DEFAULT')
                if isinstance(d, dict):
                    props.update(d)
    return props

def load_fonts(project):
    cache = {}
    for f in project.get('fonts', []):
        name = f.get('name')
        size = int((f.get('source') or {}).get('size', 16) or 16)
        h = f.get('height')
        asc = f.get('ascent')
        emb = f.get('embeddedFontFile')
        font = None
        try:
            font = ImageFont.truetype(io.BytesIO(base64.b64decode(emb)), size)
        except Exception:
            font = ImageFont.load_default()
        cache[name] = {'font': font, 'size': size,
                       'lineheight': int(h) if h else round(size*1.3),
                       'ascent': int(asc) if asc else round(size*1.0)}
    return cache

def load_bitmaps(project):
    cache = {}
    for b in project.get('bitmaps', []):
        name = b.get('name'); img = b.get('image', '') or ''
        if 'base64,' in img:
            img = img.split('base64,', 1)[1]
        try:
            cache[name] = Image.open(io.BytesIO(base64.b64decode(img))).convert('RGBA')
        except Exception:
            cache[name] = None
    return cache

ALIGN_ANCHOR = {
    'DEFAULT': (0, 0), 'TOP_LEFT': (0, 0), 'TOP_MID': (0.5, 0), 'TOP_RIGHT': (1, 0),
    'BOTTOM_LEFT': (0, 1), 'BOTTOM_MID': (0.5, 1), 'BOTTOM_RIGHT': (1, 1),
    'LEFT_MID': (0, 0.5), 'RIGHT_MID': (1, 0.5), 'CENTER': (0.5, 0.5),
}

def has_flag(w, flag):
    return flag in (w.get('widgetFlags', '') or '')

CLIP_TYPES = {'LVGLPanelWidget', 'LVGLContainerWidget', 'LVGLScreenWidget', 'LVGLButtonWidget'}

def measured_size(w, st, fonts):
    ww = w.get('width', 0) or 0
    wh = w.get('height', 0) or 0
    if w.get('type') == 'LVGLLabelWidget':
        fm = fonts.get(st.get('text_font'))
        text = str(w.get('text', ''))
        if fm:
            try:
                bbox = fm['font'].getbbox(text or ' ')
                tw = bbox[2] - bbox[0]
            except Exception:
                tw = len(text) * fm['size'] // 2
            if w.get('widthUnit') == 'content':
                ww = tw + 2
            if w.get('heightUnit') == 'content':
                wh = fm['lineheight']
    return ww, wh

def abs_pos(w, st, px, py, pw, ph, ww, wh):
    left = w.get('left', 0) or 0
    top = w.get('top', 0) or 0
    align = st.get('align')
    if align:
        base = str(align).split('|')[0].strip()
        fx, fy = ALIGN_ANCHOR.get(base, (0, 0))
        ax = px + int(pw*fx) - int(ww*fx) + left
        ay = py + int(ph*fy) - int(wh*fy) + top
        return ax, ay
    return px + left, py + top

def composite_clipped(page, layer, clip):
    mask = layer.getchannel('A')
    cm = Image.new('L', page.size, 0)
    ImageDraw.Draw(cm).rectangle([clip[0], clip[1], clip[2]-1, clip[3]-1], fill=255)
    mask = ImageChops.multiply(mask, cm)
    page.paste(layer, (0, 0), mask)

def draw_image(layer, w, st, ax, ay, ww, wh, bitmaps):
    src = bitmaps.get(w.get('image'))
    if src is None:
        return
    im = src.copy()
    rc = parse_color(st.get('img_recolor'))
    opa = st.get('img_recolor_opa', 0)
    if rc and (opa or 0) > 0:
        solid = Image.new('RGBA', im.size, rc + (255,))
        solid.putalpha(im.getchannel('A'))
        im = solid
    zoom = w.get('zoom', 256) or 256
    if zoom != 256:
        nw, nh = im.size
        im = im.resize((max(1, round(nw*zoom/256)), max(1, round(nh*zoom/256))), Image.BICUBIC)
    angle = w.get('angle', 0) or 0
    if angle:
        im = im.rotate(-angle/10.0, expand=True, resample=Image.BICUBIC)
    # innerAlign CENTER: center image in the widget box
    ox = ax + (ww - im.size[0])//2
    oy = ay + (wh - im.size[1])//2
    layer.alpha_composite(im, (ox, oy))

def draw_text(layer, w, st, ax, ay, ww, wh, fonts):
    fm = fonts.get(st.get('text_font'))
    if not fm:
        return
    text = str(w.get('text', ''))
    col = parse_color(st.get('text_color')) or (238, 241, 245)
    ta = st.get('text_align', 'LEFT')
    d = ImageDraw.Draw(layer)
    if ta == 'CENTER':
        tx, anchor = ax + ww//2, 'ma'
    elif ta == 'RIGHT':
        tx, anchor = ax + ww, 'ra'
    else:
        tx, anchor = ax, 'la'
    try:
        d.text((tx, ay), text, font=fm['font'], fill=col + (255,), anchor=anchor)
    except Exception:
        d.text((ax, ay), text, font=fm['font'], fill=col + (255,))

def draw_box(layer, w, st, ax, ay, ww, wh):
    if ww <= 0 or wh <= 0:
        return
    d = ImageDraw.Draw(layer)
    radius = int(st.get('radius', 0) or 0)
    bg = parse_color(st.get('bg_color'))
    bg_opa = st.get('bg_opa', 255 if bg else 0)
    rect = [ax, ay, ax+ww-1, ay+wh-1]
    if bg is not None and (bg_opa or 0) > 0:
        fill = bg + (int(bg_opa),)
        if radius > 0:
            d.rounded_rectangle(rect, radius=radius, fill=fill)
        else:
            d.rectangle(rect, fill=fill)
    bcol = parse_color(st.get('border_color'))
    bw = int(st.get('border_width', 0) or 0)
    if bcol is not None and bw > 0:
        if radius > 0:
            d.rounded_rectangle(rect, radius=radius, outline=bcol + (255,), width=bw)
        else:
            d.rectangle(rect, outline=bcol + (255,), width=bw)

def render_widget(w, page, px, py, pw, ph, clip, fonts, bitmaps):
    st = style_of(w)
    wtype = w.get('type')
    ww, wh = measured_size(w, st, fonts)
    ax, ay = abs_pos(w, st, px, py, pw, ph, ww, wh)

    layer = Image.new('RGBA', page.size, (0, 0, 0, 0))
    if wtype in ('LVGLPanelWidget', 'LVGLContainerWidget', 'LVGLButtonWidget', 'LVGLScreenWidget'):
        draw_box(layer, w, st, ax, ay, ww, wh)
    if wtype == 'LVGLLabelWidget':
        draw_text(layer, w, st, ax, ay, ww, wh, fonts)
    if wtype == 'LVGLImageWidget':
        draw_image(layer, w, st, ax, ay, ww, wh, bitmaps)
    if wtype in ('LVGLSpinnerWidget', 'LVGLArcWidget'):
        d = ImageDraw.Draw(layer)
        col = parse_color(st.get('arc_color')) or (46, 130, 245)
        d.arc([ax, ay, ax+ww-1, ay+wh-1], start=30, end=290, fill=col+(255,), width=max(3, ww//12))
    composite_clipped(page, layer, clip)

    # children
    children = w.get('children', []) or []
    pad = lambda k: int(st.get(k, 0) or 0)
    cx0 = ax + pad('pad_left'); cy0 = ay + pad('pad_top')
    cw = ww - pad('pad_left') - pad('pad_right'); chh = wh - pad('pad_top') - pad('pad_bottom')
    if wtype in CLIP_TYPES and not has_flag(w, 'OVERFLOW_VISIBLE'):
        child_clip = (max(clip[0], cx0), max(clip[1], cy0),
                      min(clip[2], cx0+cw), min(clip[3], cy0+chh))
    else:
        child_clip = clip
    for ch in children:
        render_widget(ch, page, cx0, cy0, cw, chh, child_clip, fonts, bitmaps)

def render_project(path, out_dir):
    project = json.load(open(path, encoding='utf-8'))
    fonts = load_fonts(project); bitmaps = load_bitmaps(project)
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for page in project.get('userPages', []):
        name = page.get('name', 'page')
        W = page.get('width', 480) or 480; H = page.get('height', 800) or 800
        comps = page.get('components', [])
        # screen root bg
        root_bg = PAGE_BG_FALLBACK
        if comps:
            rs = style_of(comps[0])
            root_bg = parse_color(rs.get('bg_color')) or PAGE_BG_FALLBACK
        img = Image.new('RGBA', (W, H), root_bg + (255,))
        clip = (0, 0, W, H)
        for comp in comps:
            # draw screen bg already; render its children
            st = style_of(comp)
            for ch in comp.get('children', []) or []:
                render_widget(ch, img, 0, 0, W, H, clip, fonts, bitmaps)
        out = os.path.join(out_dir, f"{name}.png")
        img.convert('RGB').save(out)
        written.append(out)
    return written

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("usage: python eez_render.py file.eez-project [out_dir]"); sys.exit(2)
    outd = sys.argv[2] if len(sys.argv) > 2 else 'render_out'
    for p in render_project(sys.argv[1], outd):
        print("wrote", p)
