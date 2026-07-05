// Build operations (non-simulator) for the MCP bridge.
// Five tools over EEZ's real Generate/Build pipeline: an in-memory asset build,
// build-destination reads, an OS-shell reveal, and build-configuration list/select.
// None are undo commands: build_assets is in-memory compute (writes only to
// Section.OUTPUT), the two destination reads are pure reads, open_build_folder is an
// OS-shell side effect, and set_build_configuration mutates UI state (ui-state store),
// NOT the project/undo manager.

import * as fs from "fs";

import {
    getObjectPathAsString,
    getLabel
} from "project-editor/store";
import { MessageType, getParent } from "project-editor/core/object";
import { Section } from "project-editor/store/output-sections";
import { runInAction } from "mobx";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore
} from "mcp-bridge/project-access";

// --- Local diagnostics helpers (self-contained copy of the non-exported helpers in
// handlers-project.ts, so this module has no cross-file dependency on them). ---------

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

export const buildOpsHandlers: Record<string, Handler> = {
    // Build in-memory LVGL assets without writing files (fast validation).
    // store.buildAssets() = buildProject(store,"buildAssets"): assembles `parts` in
    // memory and returns it, writing NO files. Errors are recorded into Section.OUTPUT
    // (not thrown), so inspect numErrors rather than try/catch. GUI_ASSETS_DATA is a
    // Node Buffer — summarize it (byte length), never ship it raw over JSON-RPC.
    async build_assets() {
        const store = requireLvglStore();
        const t0 = Date.now();
        const parts: any = await store.buildAssets(); // may be undefined on error
        const durationMs = Date.now() - t0;

        const out = store.outputSectionsStore.getSection(Section.OUTPUT);
        const problems = collectProblems(out);
        const errors = problems.filter(p => p.severity === "error");
        const warnings = problems.filter(p => p.severity === "warning");
        const ok = (out?.numErrors ?? errors.length) === 0 && !!parts;

        return {
            ok,
            durationMs,
            // Summarize; do NOT ship the raw Buffer over JSON-RPC.
            parts: parts
                ? {
                      keys: Object.keys(parts),
                      guiAssetsDataBytes: Buffer.isBuffer(parts.GUI_ASSETS_DATA)
                          ? parts.GUI_ASSETS_DATA.length
                          : undefined,
                      // GUI_ASSETS_DATA_MAP_JS is a plain object — safe to include.
                      map: parts.GUI_ASSETS_DATA_MAP_JS ?? null
                  }
                : null,
            errors,
            warnings
        };
    },

    // Resolve the build output folder. Pure synchronous reads.
    get_build_destination() {
        const store = requireProjectStore();
        const relative = store.project.settings.build.destinationFolder || ".";
        const absolute = store.getAbsoluteFilePath(relative);
        return { relative, absolute, exists: fs.existsSync(absolute) };
    },

    // Reveal the build output folder in the OS file manager (OS-shell side effect,
    // opens a Finder/Explorer window). shell.openPath resolves with "" on success or a
    // non-empty error string on failure. If the folder does not exist, report it as
    // not opened rather than spawning an error window.
    async open_build_folder() {
        const store = requireProjectStore();
        const relative = store.project.settings.build.destinationFolder || ".";
        const absolute = store.getAbsoluteFilePath(relative);
        if (!fs.existsSync(absolute)) {
            return { opened: false, path: absolute };
        }
        const { shell } = require("electron");
        const err: string = await shell.openPath(absolute); // "" on success
        return { opened: err === "", path: absolute };
    },

    // Read the build configurations and which one is selected. Pure reads.
    list_build_configurations() {
        const store = requireProjectStore();
        const configs: any[] = store.project.settings.build.configurations || [];
        return {
            configurations: configs.map(c => ({
                name: c.name,
                description: c.description ?? null,
                screenOrientation: c.screenOrientation ?? null
            })),
            // The resolved selection (honors the configurations[0] fallback):
            selected: store.selectedBuildConfiguration?.name ?? null,
            // The raw persisted UI value (may name a config that no longer exists):
            selectedName: store.uiStateStore?.selectedBuildConfiguration ?? null
        };
    },

    // Select which build configuration subsequent builds use. This is UI state
    // (ui-state store), NOT an undo/project mutation — no undo entry, project not
    // marked modified. Validate the name against configurations before setting, since
    // an unknown name silently falls back to configurations[0] at read time.
    set_build_configuration(params: any) {
        const store = requireProjectStore();
        const name = params?.name;
        const configs: any[] = store.project.settings.build.configurations || [];
        if (!name || !configs.some(c => c && c.name === name)) {
            throw new BridgeError(
                "NOT_FOUND",
                `No build configuration named "${name}".`
            );
        }
        runInAction(() =>
            store.uiStateStore.setSelectedBuildConfiguration(name)
        );
        return { selected: store.selectedBuildConfiguration?.name ?? name };
    }
};
