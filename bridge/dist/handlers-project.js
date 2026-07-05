"use strict";
// Project settings (get/update) + build for the MCP bridge.
// Settings are live observable props on store.project.settings.general/.build,
// read directly and mutated via ProjectStore.updateObject so GUI/undo stay in sync.
// build runs EEZ's real Generate (buildProject(store, "buildFiles")): it writes
// C sources to disk and records problems in Section.OUTPUT rather than throwing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectHandlers = void 0;
const tslib_1 = require("tslib");
const fs = tslib_1.__importStar(require("fs"));
const path = tslib_1.__importStar(require("path"));
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const output_sections_1 = require("project-editor/store/output-sections");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Local diagnostics helpers (self-contained copy of handlers.ts:68-123, so this
// module has no cross-file dependency on those non-exported helpers). ---------------
function severityOf(type) {
    if (type === object_1.MessageType.ERROR)
        return "error";
    if (type === object_1.MessageType.WARNING)
        return "warning";
    return "info";
}
function nearestObjID(object) {
    let cur = object;
    for (let i = 0; i < 64 && cur; i++) {
        if (cur.objID)
            return cur.objID;
        cur = (0, object_1.getParent)(cur);
    }
    return undefined;
}
function safe(fn) {
    try {
        return fn();
    }
    catch (e) {
        return undefined;
    }
}
function collectProblems(section) {
    const out = [];
    const walk = (msgs, group) => {
        for (const m of msgs || []) {
            if (m.type === object_1.MessageType.GROUP) {
                walk(m.messages || [], m.text);
            }
            else {
                out.push({
                    severity: severityOf(m.type),
                    text: m.text,
                    group,
                    objID: nearestObjID(m.object),
                    path: m.object
                        ? safe(() => (0, store_1.getObjectPathAsString)(m.object))
                        : undefined,
                    label: m.object ? safe(() => (0, store_1.getLabel)(m.object)) : undefined
                });
            }
        }
    };
    walk(section?.messages?.messages || []);
    return out;
}
function baseName(filePath) {
    if (!filePath) {
        return "untitled";
    }
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1].replace(/\.eez-project$/i, "");
}
/** Absolute path of the build destination folder (empty/"." → project dir). */
function destinationAbs(store) {
    const dest = store.project.settings.build.destinationFolder || ".";
    return store.getAbsoluteFilePath(dest);
}
/**
 * Read the generated file list from EEZ's build manifest.
 * After a successful buildFiles for non-dashboard projects EEZ writes
 * <destinationFolder>/.eez-project-build = { files: string[] } (relative POSIX
 * paths). Absent manifest → [] (files may still have been partially written).
 */
function readGeneratedFiles(destAbs) {
    try {
        const manifestPath = path.join(destAbs, ".eez-project-build");
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw);
        const files = Array.isArray(manifest?.files)
            ? manifest.files
            : [];
        return files.map((f) => path.join(destAbs, String(f)));
    }
    catch (e) {
        return [];
    }
}
exports.projectHandlers = {
    // Full read of project settings — superset of get_project_info. Pure read of the
    // two live EezObjects; no mutation, no async.
    get_settings() {
        const store = (0, project_access_1.requireProjectStore)();
        const g = store.project.settings.general;
        const b = store.project.settings.build;
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
            general: {
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
                keywords: g.keywords,
                author: g.author,
                targetPlatform: g.targetPlatform,
                minStudioVersion: g.minStudioVersion
            },
            build: {
                destinationFolder: b.destinationFolder ?? null,
                lvglInclude: b.lvglInclude,
                screensLifetimeSupport: b.screensLifetimeSupport,
                generateSourceCodeForEezFramework: b.generateSourceCodeForEezFramework,
                compressFlowDefinition: b.compressFlowDefinition,
                executionQueueSize: b.executionQueueSize,
                expressionEvaluatorStackSize: b.expressionEvaluatorStackSize,
                imageExportMode: b.imageExportMode,
                fontExportMode: b.fontExportMode,
                fileSystemPath: b.fileSystemPath,
                separateFolderForImagesAndFonts: b.separateFolderForImagesAndFonts,
                useDockerDesktop: b.useDockerDesktop
            }
        };
    },
    // Update general and/or build settings. updateObject validates each key against
    // the object's classInfo (unknown keys are ignored, not thrown). When both
    // sub-objects are edited, combine them into ONE undo step.
    update_settings(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const general = params.general;
        const build = params.build;
        if ((!general || typeof general !== "object") &&
            (!build || typeof build !== "object")) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Provide 'general' and/or 'build' object(s) to update.");
        }
        const um = store.undoManager;
        const combine = general &&
            typeof general === "object" &&
            build &&
            typeof build === "object";
        if (combine) {
            um.setCombineCommands(true);
        }
        try {
            if (general && typeof general === "object") {
                store.updateObject(store.project.settings.general, general);
            }
            if (build && typeof build === "object") {
                store.updateObject(store.project.settings.build, build);
            }
        }
        finally {
            if (combine) {
                um.setCombineCommands(false);
            }
        }
        return {
            updated: {
                general: general && typeof general === "object"
                    ? Object.keys(general)
                    : [],
                build: build && typeof build === "object" ? Object.keys(build) : []
            }
        };
    },
    // Run EEZ's real Generate (Build 🔧): buildProject(store,"buildFiles") writes the
    // LVGL C sources to the configured destination via the plain Node writer (no
    // Docker; useDockerDesktop only gates the F7 Full-Simulator preview). Errors are
    // recorded in Section.OUTPUT, not thrown — inspect numErrors, do not try/catch.
    async build() {
        const store = (0, project_access_1.requireLvglStore)();
        await project_editor_interface_1.ProjectEditor.build.buildProject(store, "buildFiles");
        const out = store.outputSectionsStore.getSection(output_sections_1.Section.OUTPUT);
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
