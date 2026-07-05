// MCP bridge handlers for project-level SETTINGS: features (list/enable/disable),
// project imports, build configurations, editor zoom (UI state), and the readme file.
//
// Every project-data mutation goes through the live ProjectStore command/undo API
// (updateObject / addObject / deleteObject) so the GUI, undo/redo and validation stay
// consistent — exactly like handlers.ts / handlers-assets.ts.
//
// Feature enable/disable is an exact copy of SettingsNavigation's onAdd/onRemove: a
// feature is a Project object-property named `feature.key`, and presence <=> enabled.
// set_zoom is the ONLY exception: zoom is editor UI state (uiStateStore + the active
// PageTabState.transform) and must NOT go through undo.

import { createObject } from "project-editor/store";
import { getProperty } from "project-editor/core/object";
import { getProjectFeatures } from "project-editor/store/features";
import { ImportDirective, BuildConfiguration } from "project-editor/project/project";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolvePage,
    ProjectStoreLike
} from "mcp-bridge/project-access";

// --- Local helpers -----------------------------------------------------------

/** Find a registered project feature by key, or throw BAD_PARAMS. */
function requireFeature(key: string): any {
    if (!key) {
        throw new BridgeError("BAD_PARAMS", "key is required.");
    }
    const feature = getProjectFeatures().find((f: any) => f.key === key);
    if (!feature) {
        throw new BridgeError("BAD_PARAMS", `Unknown feature "${key}".`);
    }
    return feature;
}

/**
 * Effective mandatory-ness for a feature, replicating the project-type overrides
 * from getProjectClassInfo.isOptional + SettingsNavigation's render() logic:
 *  - LVGL: fonts/bitmaps/lvglStyles/lvglGroups are mandatory.
 *  - IEXT: extensionDefinitions mandatory; scpi iff protocol SCPI;
 *          instrumentCommands iff protocol PROPRIETARY.
 */
function isEffectivelyMandatory(store: ProjectStoreLike, feature: any): boolean {
    let mandatory = !!feature.mandatory;
    const traits = store.project.projectTypeTraits;
    const proto = store.project.settings?.general?.commandsProtocol;
    const key = feature.key;

    if (traits.isLVGL) {
        if (
            key === "fonts" ||
            key === "bitmaps" ||
            key === "lvglStyles" ||
            key === "lvglGroups"
        ) {
            mandatory = true;
        }
    }
    if (traits.isIEXT) {
        if (key === "extensionDefinitions") {
            mandatory = true;
        } else if (key === "scpi") {
            mandatory = proto === "SCPI";
        } else if (key === "instrumentCommands") {
            mandatory = proto === "PROPRIETARY";
        }
    }
    return mandatory;
}

/** The live project imports array (settings.general.imports). */
function projectImports(store: ProjectStoreLike): any[] {
    return store.project.settings?.general?.imports || [];
}

/** The live build configurations array (settings.build.configurations). */
function projectBuildConfigs(store: ProjectStoreLike): any[] {
    return store.project.settings?.build?.configurations || [];
}

export const settingsHandlers: Record<string, Handler> = {
    // --- Features ------------------------------------------------------------

    // Enumerate every project feature with its enabled + effective-mandatory state.
    list_features() {
        const store = requireProjectStore();
        const project = store.project;
        return {
            features: getProjectFeatures().map((f: any) => ({
                key: f.key,
                displayName: f.displayName || f.name,
                enabled: !!getProperty(project, f.key),
                mandatory: isEffectivelyMandatory(store, f)
            }))
        };
    },

    // Enable a feature: exact copy of SettingsNavigation.onAdd — createObject with the
    // feature's authoritative seed + typeClass + key, then set it as a Project property
    // in a single updateObject (ONE undo step). Idempotent if already present.
    enable_feature(params: any) {
        const store = requireProjectStore();
        const project = store.project;
        const feature = requireFeature(params.key);

        if (getProperty(project, feature.key)) {
            return { key: feature.key, enabled: true };
        }

        const seed = feature.create();
        const newObj = createObject(store, seed, feature.typeClass, feature.key);
        store.updateObject(project, { [feature.key]: newObj });
        if (typeof project.enableTabs === "function") {
            project.enableTabs();
        }
        return { key: feature.key, enabled: true };
    },

    // Disable a feature: copy of SettingsNavigation.onRemove. Set the Project property to
    // undefined; for extensionDefinitions ALSO null scpi/instrumentCommands/shortcuts in
    // the same updateObject (atomic cascade = one undo step). Guards effective-mandatory
    // features. Idempotent if already absent.
    disable_feature(params: any) {
        const store = requireProjectStore();
        const project = store.project;
        const feature = requireFeature(params.key);

        if (!getProperty(project, feature.key)) {
            return { key: feature.key, enabled: false };
        }
        if (isEffectivelyMandatory(store, feature)) {
            throw new BridgeError(
                "UNSUPPORTED",
                `Feature "${feature.key}" is mandatory for this project type and cannot be removed.`
            );
        }

        const values: any = { [feature.key]: undefined };
        if (feature.key === "extensionDefinitions") {
            values["scpi"] = undefined;
            values["instrumentCommands"] = undefined;
            values["shortcuts"] = undefined;
        }
        store.updateObject(project, values);
        if (typeof project.enableTabs === "function") {
            project.enableTabs();
        }
        return { key: feature.key, enabled: false };
    },

    // --- Project imports -----------------------------------------------------

    // Add an ImportDirective into settings.general.imports. Rejected for master-project /
    // applet / IEXT projects (mirrors the imports PropertyInfo `disabled` closure).
    add_project_import(params: any) {
        const store = requireProjectStore();
        const general = store.project.settings?.general;
        if (!general) {
            throw new BridgeError(
                "NOT_FOUND",
                "Project has no general settings."
            );
        }
        if (!params.projectFilePath) {
            throw new BridgeError("BAD_PARAMS", "projectFilePath is required.");
        }

        const traits = store.project.projectTypeTraits;
        if (general.masterProject || traits.isApplet || traits.isIEXT) {
            throw new BridgeError(
                "UNSUPPORTED",
                "Imports are not allowed for master-project / applet / IEXT projects."
            );
        }

        // importAs is unique across imports (matches ImportDirective.importAs unique:true).
        if (params.importAs) {
            if (
                projectImports(store).some(
                    (i: any) => i.importAs === params.importAs
                )
            ) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    `importAs "${params.importAs}" is already used.`
                );
            }
        }

        // projectFilePath is a RelativeFile — persist it relative to the project.
        const relPath = store.getFilePathRelativeToProjectPath(
            params.projectFilePath
        );
        const seed: any = { projectFilePath: relPath };
        if (params.importAs) {
            seed.importAs = params.importAs;
        }
        const imp: any = createObject(store, seed, ImportDirective);
        store.addObject(general.imports, imp);
        return { objID: imp.objID };
    },

    // Remove an ImportDirective by importAs (preferred) or projectFilePath.
    remove_project_import(params: any) {
        const store = requireProjectStore();
        const imports = projectImports(store);

        let imp: any;
        if (params.importAs) {
            imp = imports.find((i: any) => i.importAs === params.importAs);
        } else if (params.projectFilePath) {
            const rel = store.getFilePathRelativeToProjectPath(
                params.projectFilePath
            );
            imp = imports.find(
                (i: any) =>
                    i.projectFilePath === rel ||
                    i.projectFilePath === params.projectFilePath
            );
        } else {
            throw new BridgeError(
                "BAD_PARAMS",
                "Either importAs or projectFilePath is required."
            );
        }
        if (!imp) {
            throw new BridgeError(
                "NOT_FOUND",
                "No matching import directive."
            );
        }
        store.deleteObject(imp);
        return { deleted: true };
    },

    // --- Build configurations ------------------------------------------------

    // Add a BuildConfiguration by name into settings.build.configurations (skips the GUI
    // name dialog). Name is unique. LVGL projects hide the tree node but the array is real.
    add_build_configuration(params: any) {
        const store = requireProjectStore();
        const build = store.project.settings?.build;
        if (!build) {
            throw new BridgeError(
                "NOT_FOUND",
                "Project has no build settings (dashboard / master project)."
            );
        }
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        if (
            projectBuildConfigs(store).some(
                (c: any) => c.name === params.name
            )
        ) {
            throw new BridgeError(
                "BAD_PARAMS",
                `A build configuration named "${params.name}" already exists.`
            );
        }
        const cfg: any = createObject(
            store,
            { name: params.name } as any,
            BuildConfiguration
        );
        store.addObject(build.configurations, cfg);
        return { objID: cfg.objID, name: cfg.name };
    },

    // --- Zoom (UI state — NOT undo) ------------------------------------------

    // Set the active page editor's zoom. Modes:
    //   reset  -> scale=1 + center (resetTransform)
    //   level  -> numeric zoom (params.level, 1.0 == 100%)
    //   center -> recenter at current scale
    //   fit    -> best-effort; UNSUPPORTED unless the editor viewport (clientRect) is mounted
    // This is view state: it writes uiStateStore.flowZoom + PageTabState.transform and
    // intentionally bypasses the undo manager.
    set_zoom(params: any) {
        const store = requireProjectStore();

        // Optionally focus a page first so there is an active page editor.
        if (params.page) {
            const page = resolvePage(store, params.page);
            store.editorsStore.openEditor(page);
        }

        const editor = store.editorsStore.activeEditor;
        const state: any = editor && editor.state;
        if (!state || typeof state.transform === "undefined") {
            throw new BridgeError(
                "NO_PROJECT",
                "No active page editor to zoom. Open a page first."
            );
        }

        const mode: string = params.mode;
        if (!mode) {
            throw new BridgeError(
                "BAD_PARAMS",
                "mode is required (level | fit | center | reset)."
            );
        }

        if (mode === "reset") {
            state.resetTransform();
            return { zoom: state.transform.scale };
        }

        if (mode === "level") {
            if (typeof params.level !== "number") {
                throw new BridgeError(
                    "BAD_PARAMS",
                    "level (number) is required for mode 'level'."
                );
            }
            const level: number = params.level;
            if (store.uiStateStore.globalFlowZoom) {
                store.uiStateStore.flowZoom = level;
            }
            const t = state.transform;
            t.scale = level;
            state.centerView(t);
            state.transform = t;
            return { zoom: t.scale };
        }

        if (mode === "center") {
            state.centerView();
            return { zoom: state.transform.scale };
        }

        if (mode === "fit") {
            const t = state.transform;
            if (!t.clientRect || !t.clientRect.width) {
                throw new BridgeError(
                    "UNSUPPORTED",
                    "fit requires a mounted editor viewport (clientRect); use mode 'reset' or a numeric level."
                );
            }
            const pr = state.flow.pageRect;
            const margin = 1.1;
            const scale = Math.min(
                t.clientRect.width / (pr.width * margin),
                t.clientRect.height / (pr.height * margin)
            );
            if (store.uiStateStore.globalFlowZoom) {
                store.uiStateStore.flowZoom = scale;
            }
            t.scale = scale;
            state.centerView(t);
            state.transform = t;
            return { zoom: t.scale };
        }

        throw new BridgeError(
            "BAD_PARAMS",
            `Unknown zoom mode "${mode}" (expected level | fit | center | reset).`
        );
    },

    // --- Readme --------------------------------------------------------------

    // Set the project readme file. Readme is a FEATURE object at project.readme with a
    // single prop readmeFile (NOT settings.general.readme). Enable the readme feature if
    // absent, then set readmeFile — grouped into ONE undo step via setCombineCommands.
    set_readme(params: any) {
        const store = requireProjectStore();
        const project = store.project;
        if (!params.readmeFile) {
            throw new BridgeError("BAD_PARAMS", "readmeFile is required.");
        }
        const relPath = store.getFilePathRelativeToProjectPath(
            params.readmeFile
        );

        store.undoManager.setCombineCommands(true);
        try {
            if (!project.readme) {
                const feature = requireFeature("readme");
                const readmeObj = createObject(
                    store,
                    feature.create(),
                    feature.typeClass,
                    "readme"
                );
                store.updateObject(project, { readme: readmeObj });
            }
            store.updateObject(project.readme, { readmeFile: relPath });
        } finally {
            store.undoManager.setCombineCommands(false);
        }
        return { ok: true };
    }
};
