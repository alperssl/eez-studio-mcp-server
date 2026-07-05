"use strict";
// Pixel-exact PNG capture from EEZ Studio's own LVGL-WASM editor preview.
//
// Strategy: ensure the target page's editor is open (which mounts an
// LVGLPageEditorRuntime that continuously blits the WASM framebuffer to its 2D
// canvas via putImageData), wait for a painted frame, then read the canvas with
// toDataURL("image/png"). Capturing the already-painted canvas sidesteps any
// RGBA/BGRA byte-order concerns — the pixels are correct by construction.
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderPage = renderPage;
exports.renderSelection = renderSelection;
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
const CANVAS_WAIT_MS = 6000;
const SETTLE_FRAMES = 6;
const SETTLE_MS = 200;
function nextFrame() {
    return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function editorCanvas(page) {
    const runtime = page._lvglRuntime;
    const canvas = runtime?.ctx?.canvas;
    return canvas || undefined;
}
async function waitForEditorCanvas(page) {
    const deadline = Date.now() + CANVAS_WAIT_MS;
    while (Date.now() < deadline) {
        const canvas = editorCanvas(page);
        if (canvas && canvas.width > 0 && canvas.height > 0) {
            return canvas;
        }
        await delay(50);
    }
    throw new protocol_1.BridgeError("INTERNAL", `Timed out waiting for the LVGL preview of page "${page.name}" to mount.`);
}
function stripDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
async function capturePageCanvas(store, page) {
    // Mount the page editor if it isn't already the source of a live runtime.
    if (!editorCanvas(page)) {
        store.editorsStore.openEditor(page);
    }
    const canvas = await waitForEditorCanvas(page);
    // Let the raf loop paint a few frames so animations/layout settle.
    for (let i = 0; i < SETTLE_FRAMES; i++) {
        await nextFrame();
    }
    await delay(SETTLE_MS);
    return canvas;
}
async function renderPage(store, pageName) {
    const page = (0, project_access_1.resolvePage)(store, pageName);
    const canvas = await capturePageCanvas(store, page);
    return {
        pngBase64: stripDataUrl(canvas.toDataURL("image/png")),
        width: canvas.width,
        height: canvas.height
    };
}
async function renderSelection(store, objID) {
    let widget;
    if (objID) {
        widget = (0, project_access_1.resolveObject)(store, objID);
    }
    else {
        const selected = store.navigationStore?.selectedPanel?.selectedObjects || [];
        widget = selected.find(o => o && o.objID && o.type);
        if (!widget) {
            throw new protocol_1.BridgeError("NOT_FOUND", "No widget is selected and no objID was provided.");
        }
    }
    const page = (0, project_access_1.pageOfObject)(widget);
    if (!page) {
        throw new protocol_1.BridgeError("NOT_FOUND", "Could not find the page containing the selected widget.");
    }
    const pageCanvas = await capturePageCanvas(store, page);
    const rect = (0, project_access_1.absoluteRect)(widget);
    const w = Math.max(1, Math.min(rect.width, pageCanvas.width - rect.x));
    const h = Math.max(1, Math.min(rect.height, pageCanvas.height - rect.y));
    const x = Math.max(0, Math.min(rect.x, pageCanvas.width - 1));
    const y = Math.max(0, Math.min(rect.y, pageCanvas.height - 1));
    const crop = document.createElement("canvas");
    crop.width = w;
    crop.height = h;
    const ctx = crop.getContext("2d");
    if (!ctx) {
        throw new protocol_1.BridgeError("INTERNAL", "Could not create a crop canvas.");
    }
    ctx.drawImage(pageCanvas, x, y, w, h, 0, 0, w, h);
    return {
        pngBase64: stripDataUrl(crop.toDataURL("image/png")),
        width: w,
        height: h,
        objID: widget.objID
    };
}
