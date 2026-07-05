// Font + bitmap OPTION-edit bridge handlers. All mutations go through the live
// ProjectStore command/undo API, mirroring handlers-assets.ts so the GUI,
// undo/redo, validation and codegen stay consistent.
//
// Two mutation shapes here:
//   RE-EXTRACT (contents changed) — set_font_ranges / set_font_symbols /
//     add_font_additional_source. updateObject does NOT rebuild Font.glyphs or
//     embeddedFontFile, so we re-run extractFont and splice the glyph array,
//     grouped into ONE undo step (mirrors edit_font, handlers-assets.ts:340-368).
//   PLAIN updateObject (build-time-only props) — set_bitmap_options /
//     set_font_fallback. These affect the built output, not the editor's
//     glyph/pixel arrays, so a straight updateObject is correct.
//
// export_bitmap is a side-effecting fs write (embedded data-URL decode, or copy
// the referenced source file) — not a store mutation, mirrors the GUI
// "Export Bitmap File" button (bitmap.tsx:64-108).

import { createObject } from "project-editor/store";

import {
    Glyph,
    AdditionalFontSource,
    getEncodings,
    getLvglEncodingsAndSymbols
} from "project-editor/features/font/font";
import { extractFont } from "project-editor/features/font/font-extract";
import { getLvglBitmapColorFormats } from "project-editor/lvgl/lvgl-versions";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    resolveByName,
    projectFonts,
    projectBitmaps,
    ProjectStoreLike
} from "mcp-bridge/project-access";

const DEFAULT_FONT_THRESHOLD = 128;

/**
 * Re-run the LVGL font extractor for a font whose CONTENTS changed, then replace
 * the persisted font fields + glyph array wholesale in ONE undo step.
 * Mirrors edit_font (handlers-assets.ts:340-368) and reloadLvglGlyphs
 * (font.tsx:2438-2464). Caller must set the changed prop (lvglRanges/lvglSymbols/
 * additional source) BEFORE building `extractParams`, and pass the already-computed
 * extract params (usually font._lvglExtractFontParams or a hand-built equivalent).
 */
async function reExtractAndReplaceGlyphs(
    store: ProjectStoreLike,
    font: any,
    extractParams: any,
    extraFontProps: any
): Promise<void> {
    let fp: any;
    try {
        fp = await extractFont({
            ...extractParams,
            createGlyphs: true,
            getAllGlyphs: true
        } as any);
    } catch (e: any) {
        throw new BridgeError(
            "UNSUPPORTED",
            `Font extraction failed: ${
                e && e.message ? e.message : String(e)
            }`
        );
    }

    store.undoManager.setCombineCommands(true);
    try {
        store.updateObject(font, {
            bpp: fp.bpp,
            ascent: fp.ascent,
            descent: fp.descent,
            height: fp.height,
            embeddedFontFile: fp.embeddedFontFile,
            ...extraFontProps
        });
        // Replace glyphs wholesale (matches reloadLvglGlyphs splice, font.tsx:2448-2459).
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
}

/**
 * Build extractFont params for an existing font with a given ranges/symbols pair,
 * reusing the already-embedded TTF bytes (no disk re-read). Mirrors the §2
 * canonical sequence from the source-v5 report and edit_font.
 */
function buildExtractParams(
    store: ProjectStoreLike,
    font: any,
    newRanges: string,
    newSymbols: string
): any {
    const { encodings, symbols } = getLvglEncodingsAndSymbols(
        newRanges,
        newSymbols
    );

    const relPath: string = font.source && font.source.filePath;
    if (!relPath) {
        throw new BridgeError("BAD_PARAMS", "font has no source file.");
    }
    const absoluteFilePath = store.getAbsoluteFilePath(relPath);

    return {
        name: font.name,
        absoluteFilePath,
        embeddedFontFile: font.embeddedFontFile,
        relativeFilePath: relPath,
        renderingEngine: "LVGL",
        bpp: font.bpp,
        size: font.source && font.source.size,
        threshold: font.threshold ?? DEFAULT_FONT_THRESHOLD,
        createGlyphs: true,
        encodings,
        symbols,
        createBlankGlyphs: false,
        doNotAddGlyphIfNotFound: false,
        getAllGlyphs: true,
        lvglVersion: store.project.settings.general.lvglVersion,
        lvglInclude: store.project.settings.build.lvglInclude,
        additionalSources: font.getAdditionalSourcesParams(store),
        lv_fallback: font.lvglFallbackFont || undefined
    };
}

/** Reject FreeType LVGL fonts, which have no editable glyphs/ranges/symbols/sources. */
function assertNotFreeType(font: any): void {
    if (font.lvglUseFreeType) {
        throw new BridgeError(
            "UNSUPPORTED",
            "FreeType fonts have no editable glyphs, ranges, symbols or additional sources."
        );
    }
}

export const fontBitmapOpsHandlers: Record<string, Handler> = {
    // Change the character ranges of an LVGL font and re-extract its glyphs.
    // RE-EXTRACT: updateObject alone would leave Font.glyphs/embeddedFontFile stale.
    async set_font_ranges(params: any) {
        const store = requireLvglStore();
        const font: any = resolveByName(
            projectFonts(store),
            params.fontName,
            "font"
        );
        assertNotFreeType(font);

        const newRanges: string = params.ranges ?? "";
        const newSymbols: string = font.lvglSymbols ?? "";

        // Validate ranges up-front (getLvglEncodingsAndSymbols calls getEncodings(...)!).
        if (getEncodings(newRanges) === undefined) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid ranges string "${newRanges}".`
            );
        }

        const extractParams = buildExtractParams(
            store,
            font,
            newRanges,
            newSymbols
        );
        await reExtractAndReplaceGlyphs(store, font, extractParams, {
            lvglRanges: newRanges,
            lvglSymbols: newSymbols
        });

        return { fontName: font.name, ranges: newRanges };
    },

    // Change the extra symbols of an LVGL font and re-extract its glyphs. RE-EXTRACT.
    async set_font_symbols(params: any) {
        const store = requireLvglStore();
        const font: any = resolveByName(
            projectFonts(store),
            params.fontName,
            "font"
        );
        assertNotFreeType(font);

        const newRanges: string = font.lvglRanges ?? "";
        const newSymbols: string = params.symbols ?? "";

        // Validate the existing ranges (still fed to getEncodings inside the extract).
        if (getEncodings(newRanges) === undefined) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid ranges string "${newRanges}".`
            );
        }

        const extractParams = buildExtractParams(
            store,
            font,
            newRanges,
            newSymbols
        );
        await reExtractAndReplaceGlyphs(store, font, extractParams, {
            lvglRanges: newRanges,
            lvglSymbols: newSymbols
        });

        return { fontName: font.name, symbols: newSymbols };
    },

    // Read-only: list the extracted glyphs of a font. For LVGL fonts Font.glyphs is
    // populated in the live editor after an extract (blanked only on save).
    list_font_glyphs(params: any) {
        const store = requireProjectStore();
        const font = resolveByName(
            projectFonts(store),
            params.fontName,
            "font"
        );
        return {
            glyphs: (font.glyphs || []).map((g: any) => ({
                encoding: g.encoding,
                width: g.width,
                height: g.height,
                dx: g.dx
            }))
        };
    },

    // Merge a second TTF/OTF/WOFF (e.g. an icon font) into an LVGL font by appending
    // an AdditionalFontSource child, then re-extracting the whole font. RE-EXTRACT.
    async add_font_additional_source(params: any) {
        const store = requireLvglStore();
        const font: any = resolveByName(
            projectFonts(store),
            params.fontName,
            "font"
        );
        assertNotFreeType(font);

        if (!params.filePath) {
            throw new BridgeError("BAD_PARAMS", "filePath is required.");
        }
        if (!(font.source && font.source.filePath)) {
            throw new BridgeError(
                "BAD_PARAMS",
                "font has no primary source; add the font first."
            );
        }

        const addRanges: string = params.ranges ?? "";
        const addSymbols: string = params.symbols ?? "";
        // Require ranges OR symbols (mirrors requiredRangesOrSymbols, font.tsx:2620-2629).
        if (!addRanges && !addSymbols) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Either ranges or symbols is required for an additional source."
            );
        }
        if (addRanges && getEncodings(addRanges) === undefined) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid ranges string "${addRanges}".`
            );
        }

        const relPath: string = store.getFilePathRelativeToProjectPath(
            params.filePath
        );

        // Append the child first so _lvglExtractFontParams (a MobX computed reading
        // this.lvglAdditionalSources) reflects it, then re-extract.
        store.undoManager.setCombineCommands(true);
        try {
            const srcSeed: any = {
                filePath: relPath,
                lvglRanges: addRanges,
                lvglSymbols: addSymbols
            };
            const src: any = createObject(store, srcSeed, AdditionalFontSource);
            store.addObject(font.lvglAdditionalSources, src);

            // The class-computed params assemble opts_string + additionalSources +
            // lv_fallback. It is undefined if the primary font has no ranges/symbols;
            // fall back to a hand-built param set that still merges the sources.
            let extractParams: any = font._lvglExtractFontParams;
            if (!extractParams) {
                extractParams = buildExtractParams(
                    store,
                    font,
                    font.lvglRanges ?? "",
                    font.lvglSymbols ?? ""
                );
            }

            let fp: any;
            try {
                fp = await extractFont({
                    ...extractParams,
                    createGlyphs: true,
                    getAllGlyphs: true
                } as any);
            } catch (e: any) {
                throw new BridgeError(
                    "UNSUPPORTED",
                    `Font extraction failed: ${
                        e && e.message ? e.message : String(e)
                    }`
                );
            }

            store.updateObject(font, {
                bpp: fp.bpp,
                ascent: fp.ascent,
                descent: fp.descent,
                height: fp.height,
                embeddedFontFile: fp.embeddedFontFile
            });
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

        return {
            fontName: font.name,
            sourceIndex: font.lvglAdditionalSources.length - 1
        };
    },

    // Set build-time bitmap conversion options. PLAIN updateObject — conversion runs
    // at build time from the stored image data, so no re-convert is needed.
    set_bitmap_options(params: any) {
        const store = requireProjectStore();
        const bitmap = resolveByName(
            projectBitmaps(store),
            params.bitmapName,
            "bitmap"
        );

        const props: any = {};
        if (params.bpp !== undefined) {
            props.bpp = resolveBitmapBpp(store, params.bpp);
        }
        if (params.lvglBinaryOutputFormat !== undefined) {
            props.lvglBinaryOutputFormat = params.lvglBinaryOutputFormat;
        }
        if (params.lvglDither !== undefined) {
            props.lvglDither = !!params.lvglDither;
        }
        if (params.alwaysBuild !== undefined) {
            props.alwaysBuild = !!params.alwaysBuild;
        }
        if (params.style !== undefined) {
            props.style = params.style;
        }
        if (Object.keys(props).length === 0) {
            throw new BridgeError("BAD_PARAMS", "No options provided.");
        }

        store.updateObject(bitmap, props); // one undo step
        return { bitmapName: bitmap.name };
    },

    // Set an LVGL font's build-time fallback font symbol. PLAIN updateObject —
    // lvglFallbackFont feeds `--lv-fallback` at build time and does NOT change the
    // font's own glyph set, so no re-extract is required. "" clears it.
    set_font_fallback(params: any) {
        const store = requireLvglStore();
        const font = resolveByName(
            projectFonts(store),
            params.fontName,
            "font"
        );
        const fallback: string = params.fallbackFontName ?? "";
        store.updateObject(font, { lvglFallbackFont: fallback });
        return { fontName: font.name, fallbackFontName: fallback };
    },

    // PARTIAL: export a bitmap to an OS path. For embedded data:image/... bitmaps,
    // base64-decode the stored bytes (mirrors the GUI export, bitmap.tsx:64-108).
    // For non-embedded bitmaps (image is a relative project path) copy the source
    // file. No rasterizer/format-conversion — the stored format is preserved.
    async export_bitmap(params: any) {
        const store = requireProjectStore();
        const bitmap = resolveByName(
            projectBitmaps(store),
            params.bitmapName,
            "bitmap"
        );
        if (!params.filePath) {
            throw new BridgeError("BAD_PARAMS", "filePath is required.");
        }

        const fs = require("fs");
        const img: string = bitmap.image;

        if (img && img.indexOf("data:image/") === 0) {
            const comma = img.indexOf(",");
            const bin = Buffer.from(img.substring(comma + 1), "base64");
            await fs.promises.writeFile(params.filePath, bin);
        } else {
            if (!img) {
                throw new BridgeError(
                    "NOT_FOUND",
                    "Bitmap has no image data to export."
                );
            }
            const abs = store.getAbsoluteFilePath(img);
            if (!abs || !fs.existsSync(abs)) {
                throw new BridgeError(
                    "NOT_FOUND",
                    `Bitmap source file not found: ${abs}`
                );
            }
            await fs.promises.copyFile(abs, params.filePath);
        }
        return { filePath: params.filePath };
    }
};

/**
 * Resolve a bitmap bpp/color-format from a caller value. For LVGL projects accept a
 * numeric color-format id or its case-insensitive label; for non-LVGL projects only
 * 16 or 32 are valid (bitmap.tsx:189). Mirrors resolveColorFormat in handlers-assets.ts.
 */
function resolveBitmapBpp(store: ProjectStoreLike, bpp: any): number {
    const general = store.project.settings && store.project.settings.general;
    const isLvgl = !!(general && general.lvglVersion);

    if (!isLvgl) {
        const n = typeof bpp === "number" ? bpp : Number(bpp);
        if (n !== 16 && n !== 32) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Non-LVGL bitmap bpp must be 16 or 32 (got ${bpp}).`
            );
        }
        return n;
    }

    const formats: any[] = getLvglBitmapColorFormats(store.project) || [];
    if (typeof bpp === "number") {
        const byId = formats.find(f => f.id === bpp);
        if (!byId) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown bitmap color-format id ${bpp}.`
            );
        }
        return byId.id;
    }
    const label = String(bpp).toUpperCase();
    const byLabel = formats.find(
        f => String(f.label).toUpperCase() === label
    );
    if (!byLabel) {
        throw new BridgeError(
            "BAD_PARAMS",
            `Unknown bitmap color-format "${bpp}".`
        );
    }
    return byLabel.id;
}
