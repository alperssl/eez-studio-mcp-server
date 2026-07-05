// Pixel-exact PNG capture from EEZ Studio's own LVGL-WASM editor preview.
//
// Strategy: ensure the target page's editor is open (which mounts an
// LVGLPageEditorRuntime that continuously blits the WASM framebuffer to its 2D
// canvas via putImageData), wait for a painted frame, then read the canvas with
// toDataURL("image/png"). Capturing the already-painted canvas sidesteps any
// RGBA/BGRA byte-order concerns — the pixels are correct by construction.

import { BridgeError } from "mcp-bridge/protocol";
import {
    resolvePage,
    resolveObject,
    pageOfObject,
    absoluteRect,
    ProjectStoreLike
} from "mcp-bridge/project-access";

const CANVAS_WAIT_MS = 6000;
const SETTLE_FRAMES = 6;
const SETTLE_MS = 200;

function nextFrame(): Promise<void> {
    return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function editorCanvas(page: any): HTMLCanvasElement | undefined {
    const runtime: any = page._lvglRuntime;
    const canvas: HTMLCanvasElement | undefined = runtime?.ctx?.canvas;
    return canvas || undefined;
}

async function waitForEditorCanvas(page: any): Promise<HTMLCanvasElement> {
    const deadline = Date.now() + CANVAS_WAIT_MS;
    while (Date.now() < deadline) {
        const canvas = editorCanvas(page);
        if (canvas && canvas.width > 0 && canvas.height > 0) {
            return canvas;
        }
        await delay(50);
    }
    throw new BridgeError(
        "INTERNAL",
        `Timed out waiting for the LVGL preview of page "${page.name}" to mount.`
    );
}

function stripDataUrl(dataUrl: string): string {
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export interface RenderResult {
    pngBase64: string;
    width: number;
    height: number;
}

async function capturePageCanvas(
    store: ProjectStoreLike,
    page: any
): Promise<HTMLCanvasElement> {
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

export async function renderPage(
    store: ProjectStoreLike,
    pageName: string
): Promise<RenderResult> {
    const page = resolvePage(store, pageName);
    const canvas = await capturePageCanvas(store, page);
    return {
        pngBase64: stripDataUrl(canvas.toDataURL("image/png")),
        width: canvas.width,
        height: canvas.height
    };
}

export async function renderSelection(
    store: ProjectStoreLike,
    objID?: string
): Promise<RenderResult & { objID: string }> {
    let widget: any;
    if (objID) {
        widget = resolveObject(store, objID);
    } else {
        const selected: any[] =
            store.navigationStore?.selectedPanel?.selectedObjects || [];
        widget = selected.find(o => o && o.objID && o.type);
        if (!widget) {
            throw new BridgeError(
                "NOT_FOUND",
                "No widget is selected and no objID was provided."
            );
        }
    }
    const page = pageOfObject(widget);
    if (!page) {
        throw new BridgeError(
            "NOT_FOUND",
            "Could not find the page containing the selected widget."
        );
    }
    const pageCanvas = await capturePageCanvas(store, page);

    const rect = absoluteRect(widget);
    const w = Math.max(1, Math.min(rect.width, pageCanvas.width - rect.x));
    const h = Math.max(1, Math.min(rect.height, pageCanvas.height - rect.y));
    const x = Math.max(0, Math.min(rect.x, pageCanvas.width - 1));
    const y = Math.max(0, Math.min(rect.y, pageCanvas.height - 1));

    const crop = document.createElement("canvas");
    crop.width = w;
    crop.height = h;
    const ctx = crop.getContext("2d");
    if (!ctx) {
        throw new BridgeError("INTERNAL", "Could not create a crop canvas.");
    }
    ctx.drawImage(pageCanvas, x, y, w, h, 0, 0, w, h);
    return {
        pngBase64: stripDataUrl(crop.toDataURL("image/png")),
        width: w,
        height: h,
        objID: widget.objID
    };
}
