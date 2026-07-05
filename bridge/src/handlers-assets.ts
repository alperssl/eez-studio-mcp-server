// Asset bridge handlers: bitmaps + fonts. Each mutation goes through the live
// ProjectStore command/undo API (addObject/updateObject/deleteObject), mirroring
// handlers.ts, so the GUI, undo/redo, validation and codegen stay consistent.
//
// add_bitmap  — embed image bytes as a data URL and createObject/addObject a Bitmap
//               (LVGL conversion is build-time only; no async convert at add time).
// delete_bitmap — resolve by name, deleteObject.
// add_font    — run EEZ's async LVGL font extractor (lv_font_conv worker), then
//               createObject/addObject the returned FontProperties seed.
// edit_font   — re-extract and replace persisted fields + glyphs in ONE undo step
//               (updateObject does NOT auto-rebuild embeddedFontFile/glyphs).
// delete_font — resolve by name, deleteObject.

import { createObject } from "project-editor/store";
import { getUniquePropertyValue } from "project-editor/store/commands";

import { Bitmap } from "project-editor/features/bitmap/bitmap";
import {
    Font,
    Glyph,
    getEncodings,
    getLvglEncodingsAndSymbols
} from "project-editor/features/font/font";
import { extractFont } from "project-editor/features/font/font-extract";
import { getLvglBitmapColorFormats } from "project-editor/lvgl/lvgl-versions";
import { CF_TRUE_COLOR_ALPHA } from "project-editor/lvgl/lvgl-constants";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    resolveObject,
    resolveByName,
    assertNameFree,
    projectFonts,
    projectBitmaps,
    ProjectStoreLike
} from "mcp-bridge/project-access";

const DEFAULT_FONT_THRESHOLD = 128;

/** Guess an image MIME type from a file extension (mirrors createBitmap, bitmap.tsx:681-689). */
function fileTypeFromExt(filePath: string): string {
    const ext = filePath.toLowerCase();
    if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) {
        return "image/jpg";
    }
    return "image/png";
}

/** Base name (no dir, no extension) of a file path. */
function baseNameNoExt(filePath: string): string {
    const parts = filePath.replace(/\\/g, "/").split("/");
    const last = parts[parts.length - 1] || filePath;
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(0, dot) : last;
}

/**
 * Decode a bitmap image string (data URL or absolute path) to its pixel width/height
 * via a renderer HTMLImageElement. Width/height are NOT stored on the Bitmap object
 * (bitmap.tsx:518-544 derives them from the decoded image), so we decode here to fill
 * the protocol's { width, height } result. Best-effort: resolves 0/0 on decode failure.
 */
function decodeImageSize(src: string): Promise<{ width: number; height: number }> {
    return new Promise(resolve => {
        try {
            const img = new Image();
            img.onload = () =>
                resolve({ width: img.width, height: img.height });
            img.onerror = () => resolve({ width: 0, height: 0 });
            img.src = src;
        } catch (e) {
            resolve({ width: 0, height: 0 });
        }
    });
}

/** Resolve the per-bitmap color-format code from a caller value, or the LVGL default. */
function resolveColorFormat(store: ProjectStoreLike, colorFormat: any): number {
    if (colorFormat === undefined || colorFormat === null) {
        return CF_TRUE_COLOR_ALPHA;
    }
    const formats: any[] = getLvglBitmapColorFormats(store.project) || [];
    // Accept a numeric id or a label (case-insensitive).
    if (typeof colorFormat === "number") {
        const byId = formats.find(f => f.id === colorFormat);
        if (!byId) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown colorFormat id ${colorFormat}.`
            );
        }
        return byId.id;
    }
    const label = String(colorFormat).toUpperCase();
    const byLabel = formats.find(
        f => String(f.label).toUpperCase() === label
    );
    if (!byLabel) {
        throw new BridgeError(
            "BAD_PARAMS",
            `Unknown colorFormat "${colorFormat}".`
        );
    }
    return byLabel.id;
}

export const assetsHandlers: Record<string, Handler> = {
    // Import an image as an LVGL Bitmap. Params: { name?, filePath? | dataBase64?,
    // fileType?, colorFormat? }. Referenceable by name in LVGLImageWidget.image.
    async add_bitmap(params: any) {
        const store = requireLvglStore();
        const general = store.project.settings.general;

        // Resolve a unique name (default from filePath basename, else "image").
        const base = params.filePath
            ? baseNameNoExt(params.filePath)
            : "image";
        let name: string = params.name;
        if (name) {
            assertNameFree(projectBitmaps(store), name, "bitmap");
        } else {
            name = getUniquePropertyValue(
                store.project.bitmaps,
                "name",
                base
            ) as string;
        }

        // Build the persisted image string: embedded data URL (default) or rel path.
        let image: string;
        if (general.embedBitmaps) {
            if (params.dataBase64) {
                const b64: string = params.dataBase64;
                image = b64.startsWith("data:image/")
                    ? b64
                    : `data:${params.fileType || "image/png"};base64,` + b64;
            } else if (params.filePath) {
                const fs = require("fs");
                const bytes: string = fs.readFileSync(
                    params.filePath,
                    "base64"
                );
                const fileType = params.fileType || fileTypeFromExt(params.filePath);
                image = `data:${fileType};base64,` + bytes;
            } else {
                throw new BridgeError(
                    "BAD_PARAMS",
                    "Either dataBase64 or filePath is required."
                );
            }
        } else {
            if (!params.filePath) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    "filePath is required when embedBitmaps is disabled."
                );
            }
            image = store.getFilePathRelativeToProjectPath(params.filePath);
        }

        const bpp = resolveColorFormat(store, params.colorFormat);

        const seed: any = { name, image, bpp, alwaysBuild: false };
        const bitmap: any = createObject(store, seed, Bitmap);
        store.addObject(store.project.bitmaps, bitmap);

        // Derive width/height by decoding the image (not stored on the Bitmap).
        const size = await decodeImageSize(bitmap.imageSrc || image);
        return { name: bitmap.name, width: size.width, height: size.height };
    },

    // Remove a bitmap by name. Dangling LVGLImageWidget.image name references are left
    // as validation errors (matches GUI + delete_widget); run_checks surfaces them.
    delete_bitmap(params: any) {
        const store = requireProjectStore();
        const bitmap = resolveByName(
            projectBitmaps(store),
            params.name,
            "bitmap"
        );
        store.deleteObject(bitmap);
        return { deleted: bitmap.name };
    },

    // Import a TTF/OTF as an LVGL font with glyph ranges. Params: { name, filePath,
    // size, bpp, ranges }. Runs EEZ's async lv_font_conv worker via extractFont.
    async add_font(params: any) {
        const store = requireLvglStore();

        const name: string = params.name;
        if (!name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        if (name.indexOf(".") !== -1) {
            throw new BridgeError(
                "BAD_PARAMS",
                'LVGL font name must not contain "." characters.'
            );
        }
        assertNameFree(projectFonts(store), name, "font");

        if (!params.filePath) {
            throw new BridgeError("BAD_PARAMS", "filePath is required.");
        }
        const size = params.size;
        const bpp = params.bpp;
        if (typeof size !== "number" || typeof bpp !== "number") {
            throw new BridgeError(
                "BAD_PARAMS",
                "size (pixels) and bpp (1|2|4|8) are required numbers."
            );
        }

        const lvglRanges: string = params.ranges ?? "";
        const lvglSymbols: string = params.symbols ?? "";
        // Validate ranges up-front (getLvglEncodingsAndSymbols does getEncodings(...)!).
        if (getEncodings(lvglRanges) === undefined) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid ranges string "${lvglRanges}".`
            );
        }
        const { encodings, symbols } = getLvglEncodingsAndSymbols(
            lvglRanges,
            lvglSymbols
        );

        const relativeFilePath = store.getFilePathRelativeToProjectPath(
            params.filePath
        );

        let fontProperties: any;
        try {
            fontProperties = await extractFont({
                name,
                absoluteFilePath: params.filePath,
                relativeFilePath,
                renderingEngine: "LVGL",
                bpp,
                size,
                threshold: DEFAULT_FONT_THRESHOLD,
                createGlyphs: true,
                encodings,
                symbols,
                createBlankGlyphs: false,
                doNotAddGlyphIfNotFound: false,
                lvglVersion: store.project.settings.general.lvglVersion,
                lvglInclude: store.project.settings.build.lvglInclude,
                getAllGlyphs: true
            } as any);
        } catch (e: any) {
            throw new BridgeError(
                "UNSUPPORTED",
                `Font extraction failed: ${e && e.message ? e.message : String(e)}`
            );
        }

        // Essential: without lvglRanges/lvglSymbols the build cannot rebuild the bin.
        (fontProperties as any).lvglRanges = lvglRanges;
        (fontProperties as any).lvglSymbols = lvglSymbols;

        const font: any = createObject(store, fontProperties as any, Font);
        store.addObject(store.project.fonts, font);
        return { name: font.name };
    },

    // Change size/bpp/ranges of a font and re-extract. updateObject does NOT rebuild
    // embeddedFontFile/glyphs, so re-run extractFont and replace them in ONE undo step.
    async edit_font(params: any) {
        const store = requireLvglStore();

        const font: any = params.name
            ? resolveByName(projectFonts(store), params.name, "font")
            : resolveObject(store, params.objID);

        const newBpp: number = params.bpp ?? font.bpp;
        const newSize: number = params.size ?? font.source?.size;
        const newRanges: string = params.ranges ?? font.lvglRanges ?? "";
        const newSymbols: string = params.symbols ?? font.lvglSymbols ?? "";

        if (typeof newSize !== "number") {
            throw new BridgeError(
                "BAD_PARAMS",
                "size is required (font has no existing source size)."
            );
        }
        if (getEncodings(newRanges) === undefined) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid ranges string "${newRanges}".`
            );
        }
        const { encodings, symbols } = getLvglEncodingsAndSymbols(
            newRanges,
            newSymbols
        );

        const relPath: string = params.filePath
            ? store.getFilePathRelativeToProjectPath(params.filePath)
            : font.source?.filePath;
        if (!relPath) {
            throw new BridgeError(
                "BAD_PARAMS",
                "font has no source file; filePath is required."
            );
        }
        const absoluteFilePath = store.getAbsoluteFilePath(relPath);

        let fp: any;
        try {
            fp = await extractFont({
                name: font.name,
                absoluteFilePath,
                embeddedFontFile: params.filePath
                    ? undefined
                    : font.embeddedFontFile,
                relativeFilePath: relPath,
                renderingEngine: "LVGL",
                bpp: newBpp,
                size: newSize,
                threshold: font.threshold ?? DEFAULT_FONT_THRESHOLD,
                createGlyphs: true,
                encodings,
                symbols,
                createBlankGlyphs: false,
                doNotAddGlyphIfNotFound: false,
                getAllGlyphs: true,
                lvglVersion: store.project.settings.general.lvglVersion,
                lvglInclude: store.project.settings.build.lvglInclude
            } as any);
        } catch (e: any) {
            throw new BridgeError(
                "UNSUPPORTED",
                `Font extraction failed: ${e && e.message ? e.message : String(e)}`
            );
        }

        // Apply everything as ONE undo step (mirrors ChangeBitsPerPixel.onModify).
        store.undoManager.setCombineCommands(true);
        try {
            store.updateObject(font, {
                bpp: fp.bpp,
                ascent: fp.ascent,
                descent: fp.descent,
                height: fp.height,
                lvglRanges: newRanges,
                lvglSymbols: newSymbols,
                embeddedFontFile: fp.embeddedFontFile
            });
            if (font.source) {
                store.updateObject(font.source, {
                    filePath: relPath,
                    size: newSize
                });
            }
            // Replace glyphs wholesale (matches reloadLvglGlyphs, font.tsx:2448-2459).
            for (const g of [...(font.glyphs || [])]) {
                store.deleteObject(g);
            }
            for (const gp of fp.glyphs || []) {
                const glyph: any = createObject(store, gp as any, Glyph);
                store.addObject(font.glyphs, glyph);
            }
        } finally {
            store.undoManager.setCombineCommands(false);
        }

        return { name: font.name };
    },

    // Remove a font by name. Dangling text_font name references in styles are left as
    // validation errors (matches GUI + delete_widget); run_checks surfaces them.
    delete_font(params: any) {
        const store = requireProjectStore();
        const font = resolveByName(projectFonts(store), params.name, "font");
        store.deleteObject(font);
        return { deleted: font.name };
    }
};
