"use strict";
// Full-simulator (Docker preview) + dashboard/extension export for the MCP bridge.
//
// - start/stop_full_simulator drive the F7 Docker full-simulator: they mirror
//   ProjectStore.onSetFullSimulatorMode / onExitFullSimulatorMode by flipping the
//   observable isDockerSimulatorMode flag and calling the dockerBuildManager
//   singleton. NONE of these are undo commands — they touch UI/runtime/build state
//   only (no updateObject, no undo manager). The Docker build is gated on LVGL +
//   useDockerDesktop; when Docker is unavailable startFullSimulator records an error
//   into the per-project observable rather than throwing, so we kick it off and
//   return the observable state promptly instead of hanging.
// - export_dashboard runs EEZ's real buildProject(store,"buildFiles") which, for
//   Dashboard projects, writes <dest>/<base>.eez-dashboard. Fully headless. Guarded
//   on projectTypeTraits.isDashboard (LVGL fixture → UNSUPPORTED).
// - build_extensions runs buildExtensions(store) → string[] of IDF .zip paths;
//   non-IEXT projects yield [] ("nothing to build"). Optional install replays the
//   store's auto-approve installExtension loop.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullSimExportHandlers = void 0;
const tslib_1 = require("tslib");
const path = tslib_1.__importStar(require("path"));
const mobx_1 = require("mobx");
const output_sections_1 = require("project-editor/store/output-sections");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const docker_build_state_1 = require("project-editor/lvgl/docker-build/docker-build-state");
const extensions_1 = require("eez-studio-shared/extensions/extensions");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
/** Absolute path of the build destination folder (empty/"." → project dir). */
function destinationAbs(store) {
    const dest = store.project.settings.build.destinationFolder || ".";
    return store.getAbsoluteFilePath(dest);
}
/** basename of the .eez-project file, without extension. */
function projectBaseName(filePath) {
    return path.basename(filePath, ".eez-project");
}
exports.fullSimExportHandlers = {
    // Enter Docker full-simulator mode (mirrors the F7 button). Gated on LVGL +
    // useDockerDesktop + a saved project. Kicks off dockerBuildManager.startFullSimulator
    // (which resolves once the preview is up OR sets an error state — it does NOT
    // throw on missing Docker) and returns the observable preview state promptly.
    async start_full_simulator(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const useDockerDesktop = store.project.settings?.build?.useDockerDesktop === true;
        if (!useDockerDesktop) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "start_full_simulator requires 'Use Docker Desktop' to be enabled " +
                "in the project's build settings. Enable it via update_settings " +
                "(build.useDockerDesktop = true), or use render_page for a " +
                "headless screenshot of the running page runtime.");
        }
        if (!store.filePath) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Save the project before starting the full simulator.");
        }
        // Exit F5 run mode first if a runtime is active (index.ts:1374-1376).
        if (store.runtime) {
            await store.setEditorMode(true);
        }
        (0, mobx_1.runInAction)(() => {
            store.layoutModels.isDockerSimulatorMode = true;
        });
        // Kick off the real Docker flow. It resolves after the preview server is up
        // or after it records an error into the per-project observable (it swallows
        // Docker failures into state rather than throwing), so awaiting it does not
        // hang on a headless box without Docker.
        const { dockerBuildManager } = await Promise.resolve().then(() => tslib_1.__importStar(require("project-editor/lvgl/docker-build/build-manager")));
        await dockerBuildManager.startFullSimulator(store, !!params.forceRebuild);
        const ps = docker_build_state_1.dockerBuildState.getProjectState(store.filePath);
        return {
            mode: store.layoutModels.isDockerSimulatorMode
                ? "full-simulator"
                : "editor",
            previewUrl: ps.previewUrl ?? null,
            building: ps.state === "building",
            state: ps.state,
            error: ps.errorMessage ?? null
        };
    },
    // Leave Docker full-simulator mode. stopFullSimulator kills containers + stops
    // the preview server if a sim was running, and is a harmless no-op otherwise, so
    // this is safe to call even when Docker was never started.
    async stop_full_simulator() {
        const store = (0, project_access_1.requireProjectStore)();
        const { dockerBuildManager } = await Promise.resolve().then(() => tslib_1.__importStar(require("project-editor/lvgl/docker-build/build-manager")));
        await dockerBuildManager.stopFullSimulator(store.filePath);
        (0, mobx_1.runInAction)(() => {
            store.layoutModels.isDockerSimulatorMode = false;
        });
        return { mode: "editor" };
    },
    // Export the project as a .eez-dashboard bundle. Guarded on Dashboard project
    // type: buildProject(store,"buildFiles") only writes <dest>/<base>.eez-dashboard
    // for dashboards; the LVGL branch writes C sources instead, so a non-dashboard
    // project honestly throws UNSUPPORTED. Errors go to Section.OUTPUT, not thrown.
    async export_dashboard() {
        const store = (0, project_access_1.requireProjectStore)();
        if (!store.projectTypeTraits.isDashboard) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "export_dashboard requires a Dashboard project. The open project " +
                "is '" +
                store.project.settings.general.projectType +
                "'.");
        }
        if (!store.filePath) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Save the project before exporting a dashboard.");
        }
        await project_editor_interface_1.ProjectEditor.build.buildProject(store, "buildFiles");
        const out = store.outputSectionsStore.getSection(output_sections_1.Section.OUTPUT);
        const ok = (out?.numErrors ?? 0) === 0;
        const filePath = path.join(destinationAbs(store), projectBaseName(store.filePath) + ".eez-dashboard");
        return { filePath, ok };
    },
    // Build IEXT/INSTRUMENT extension .zip artifacts. buildExtensions returns [] for
    // projects with nothing to build (e.g. the LVGL fixture) — surfaced honestly as
    // {built:[], note}. With install:true, replay the store's auto-approve
    // installExtension loop (index.ts:857-904) so the bridge controls the return shape.
    async build_extensions(params) {
        const store = (0, project_access_1.requireProjectStore)();
        // EEZ's buildExtensions -> extensionDefinitionAnythingToBuild ->
        // getExtensionsToBuild(store).length crashes when the extensionDefinitions
        // feature is not enabled (project.extensionDefinitions is undefined). Guard
        // here so non-IEXT projects (e.g. the LVGL fixture) report cleanly.
        const defs = store.project.extensionDefinitions;
        if (!defs || defs.length === 0) {
            return {
                built: [],
                note: "Nothing to build (no extension definitions in this project)."
            };
        }
        const paths = (await project_editor_interface_1.ProjectEditor.build.buildExtensions(store)) || [];
        if (paths.length === 0) {
            return {
                built: [],
                note: "Nothing to build (no buildable extension definitions in this project)."
            };
        }
        const installed = [];
        if (params.install) {
            for (const p of paths) {
                const ext = await (0, extensions_1.installExtension)(p, {
                    notFound() { },
                    async confirmReplaceNewerVersion() {
                        return true;
                    },
                    async confirmReplaceOlderVersion() {
                        return true;
                    },
                    async confirmReplaceTheSameVersion() {
                        return true;
                    }
                });
                if (ext) {
                    installed.push(p);
                }
            }
        }
        return {
            built: paths,
            extensionFilePaths: paths,
            installed: params.install ? installed : undefined
        };
    }
};
