// Project settings (get/update) + build for the MCP bridge.
// Settings are live observable props on store.project.settings.general/.build,
// read directly and mutated via ProjectStore.updateObject so GUI/undo stay in sync.
// build runs EEZ's real Generate (buildProject(store, "buildFiles")): it writes
// C sources to disk and records problems in Section.OUTPUT rather than throwing.

import * as fs from "fs";
import * as path from "path";

import {
    getObjectPathAsString,
    getLabel,
    getClassInfo
} from "project-editor/store";
import { MessageType, getParent } from "project-editor/core/object";
import { Section } from "project-editor/store/output-sections";
import { ProjectEditor } from "project-editor/project-editor-interface";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    ProjectStoreLike
} from "mcp-bridge/project-access";

// --- Local diagnostics helpers (self-contained copy of handlers.ts:68-123, so this
// module has no cross-file dependency on those non-exported helpers). ---------------

function severityOf(type: number): string {
    if (type === MessageType.ERROR) return "error";
    if (type === MessageType.WARNING) return "warning";
    return "info";
}

function nearestObjID(object: any): string | undefined {
    let cur = object;
    for (let i = 0; i < 64 && cur; i++) {
        if (cur.objID) return cur.objID;
        cur = getParent(cur);
    }
    return undefined;
}

function safe(fn: () => string): string | undefined {
    try {
        return fn();
    } catch (e) {
        return undefined;
    }
}

function collectProblems(section: any): any[] {
    const out: any[] = [];
    const walk = (msgs: any[], group?: string) => {
        for (const m of msgs || []) {
            if (m.type === MessageType.GROUP) {
                walk(m.messages || [], m.text);
            } else {
                out.push({
                    severity: severityOf(m.type),
                    text: m.text,
                    group,
                    objID: nearestObjID(m.object),
                    path: m.object
                        ? safe(() => getObjectPathAsString(m.object))
                        : undefined,
                    label: m.object ? safe(() => getLabel(m.object)) : undefined
                });
            }
        }
    };
    walk(section?.messages?.messages || []);
    return out;
}

function baseName(filePath: string | undefined): string {
    if (!filePath) {
        return "untitled";
    }
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1].replace(/\.eez-project$/i, "");
}

/** Absolute path of the build destination folder (empty/"." → project dir). */
function destinationAbs(store: ProjectStoreLike): string {
    const dest = store.project.settings.build.destinationFolder || ".";
    return store.getAbsoluteFilePath(dest);
}

/**
 * Read the generated file list from EEZ's build manifest.
 * After a successful buildFiles for non-dashboard projects EEZ writes
 * <destinationFolder>/.eez-project-build = { files: string[] } (relative POSIX
 * paths). Absent manifest → [] (files may still have been partially written).
 */
function readGeneratedFiles(destAbs: string): string[] {
    try {
        const manifestPath = path.join(destAbs, ".eez-project-build");
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const manifest: any = JSON.parse(raw);
        const files: any[] = Array.isArray(manifest?.files)
            ? manifest.files
            : [];
        return files.map((f: any) => path.join(destAbs, String(f)));
    } catch (e) {
        return [];
    }
}

// Map undefined values to null so every declared settings field is always PRESENT in
// the JSON payload (JSON.stringify drops undefined). Lets a caller see the full panel —
// an empty field reads as null rather than silently vanishing.
function coalesceNull(obj: any): any {
    const out: any = {};
    for (const k of Object.keys(obj)) {
        out[k] = obj[k] === undefined ? null : obj[k];
    }
    return out;
}

// Split a settings patch into keys the object's classInfo actually declares (applied)
// vs unknown keys (ignored), so a typo'd / unsupported field is surfaced to the caller
// rather than silently dropped by updateObject's own validation.
function splitByClassInfo(
    obj: any,
    patch: any
): { applied: any; ignored: string[] } {
    const valid = new Set<string>(
        (getClassInfo(obj).properties || []).map((p: any) => p.name)
    );
    const applied: any = {};
    const ignored: string[] = [];
    for (const k of Object.keys(patch)) {
        if (valid.has(k)) {
            applied[k] = patch[k];
        } else {
            ignored.push(k);
        }
    }
    return { applied, ignored };
}

export const projectHandlers: Record<string, Handler> = {
    // Full read of project settings — superset of get_project_info. Pure read of the
    // two live EezObjects; no mutation, no async.
    get_settings() {
        const store = requireProjectStore();
        const g: any = store.project.settings.general;
        const b: any = store.project.settings.build;
        return {
            name: baseName(store.filePath),
            filePath: store.filePath || null,
            isModified: store.isModified,
            // Flattened superset fields (mirrors get_project_info + PROTOCOL §4).
            displayWidth: g.displayWidth,
            displayHeight: g.displayHeight,
            projectVersion: g.projectVersion,
            lvglVersion: g.lvglVersion,
            flowSupport: g.flowSupport,
            colorFormat: g.bitmapColorFormat,
            colorBpp: g.colorBpp,
            lvglInclude: b.lvglInclude,
            buildDestination: b.destinationFolder ?? null,
            general: coalesceNull({
                projectType: g.projectType,
                projectVersion: g.projectVersion,
                lvglVersion: g.lvglVersion,
                flowSupport: g.flowSupport,
                displayWidth: g.displayWidth,
                displayHeight: g.displayHeight,
                circularDisplay: g.circularDisplay,
                displayBorderRadius: g.displayBorderRadius,
                darkTheme: g.darkTheme,
                colorBpp: g.colorBpp,
                bitmapColorFormat: g.bitmapColorFormat,
                embedBitmaps: g.embedBitmaps,
                embedFonts: g.embedFonts,
                cacheFonts: g.cacheFonts,
                title: g.title,
                description: g.description,
                image: g.image,
                icon: g.icon,
                keywords: g.keywords,
                author: g.author,
                authorLink: g.authorLink,
                targetPlatform: g.targetPlatform,
                targetPlatformLink: g.targetPlatformLink,
                minStudioVersion: g.minStudioVersion,
                masterProject: g.masterProject,
                css: g.css
            }),
            build: coalesceNull({
                destinationFolder: b.destinationFolder ?? null,
                lvglInclude: b.lvglInclude,
                screensLifetimeSupport: b.screensLifetimeSupport,
                generateSourceCodeForEezFramework:
                    b.generateSourceCodeForEezFramework,
                compressFlowDefinition: b.compressFlowDefinition,
                executionQueueSize: b.executionQueueSize,
                expressionEvaluatorStackSize: b.expressionEvaluatorStackSize,
                imageExportMode: b.imageExportMode,
                fontExportMode: b.fontExportMode,
                fileSystemPath: b.fileSystemPath,
                separateFolderForImagesAndFonts:
                    b.separateFolderForImagesAndFonts,
                useDockerDesktop: b.useDockerDesktop
            })
        };
    },

    // Update general and/or build settings. updateObject validates each key against
    // the object's classInfo (unknown keys are ignored, not thrown). When both
    // sub-objects are edited, combine them into ONE undo step.
    update_settings(params: any) {
        const store = requireProjectStore();
        const general = params.general;
        const build = params.build;
        const hasGeneral = general && typeof general === "object";
        const hasBuild = build && typeof build === "object";
        if (!hasGeneral && !hasBuild) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Provide 'general' and/or 'build' object(s) to update (flat key -> value maps)."
            );
        }

        const settings = store.project.settings;
        const g = hasGeneral
            ? splitByClassInfo(settings.general, general)
            : { applied: {}, ignored: [] };
        const b = hasBuild
            ? splitByClassInfo(settings.build, build)
            : { applied: {}, ignored: [] };

        const gCount = Object.keys(g.applied).length;
        const bCount = Object.keys(b.applied).length;

        const um = store.undoManager;
        const combine = gCount > 0 && bCount > 0;
        if (combine) {
            um.setCombineCommands(true);
        }
        try {
            if (gCount > 0) {
                store.updateObject(settings.general, g.applied);
            }
            if (bCount > 0) {
                store.updateObject(settings.build, b.applied);
            }
        } finally {
            if (combine) {
                um.setCombineCommands(false);
            }
        }

        const result: any = {
            updated: {
                general: Object.keys(g.applied),
                build: Object.keys(b.applied)
            }
        };
        // Surface unknown keys instead of silently dropping them (parity with the
        // replace_in_project scope signal).
        const ignored = [
            ...g.ignored.map((k: string) => "general." + k),
            ...b.ignored.map((k: string) => "build." + k)
        ];
        if (ignored.length > 0) {
            result.ignored = ignored;
            result.note =
                "These keys are not valid settings.general / settings.build properties and were " +
                "ignored (see get_settings for the available fields).";
        }
        return result;
    },

    // Run EEZ's real Generate (Build 🔧): buildProject(store,"buildFiles") writes the
    // LVGL C sources to the configured destination via the plain Node writer (no
    // Docker; useDockerDesktop only gates the F7 Full-Simulator preview). Errors are
    // recorded in Section.OUTPUT, not thrown — inspect numErrors, do not try/catch.
    async build() {
        const store = requireLvglStore();
        await ProjectEditor.build.buildProject(store, "buildFiles");

        const out = store.outputSectionsStore.getSection(Section.OUTPUT);
        const problems = collectProblems(out);
        const errors = problems.filter(p => p.severity === "error");
        const warnings = problems.filter(p => p.severity === "warning");
        const ok = (out?.numErrors ?? errors.length) === 0;

        const destAbs = destinationAbs(store);
        // Manifest is only written on a fully successful build; on error it may be
        // absent → generatedFiles: [] while the destination is still reported.
        const generatedFiles = ok ? readGeneratedFiles(destAbs) : [];

        return {
            ok,
            errors,
            warnings,
            generatedFiles,
            destination: destAbs
        };
    }
};
