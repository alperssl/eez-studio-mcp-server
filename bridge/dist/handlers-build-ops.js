"use strict";
// Build operations (non-simulator) for the MCP bridge.
// Five tools over EEZ's real Generate/Build pipeline: an in-memory asset build,
// build-destination reads, an OS-shell reveal, and build-configuration list/select.
// None are undo commands: build_assets is in-memory compute (writes only to
// Section.OUTPUT), the two destination reads are pure reads, open_build_folder is an
// OS-shell side effect, and set_build_configuration mutates UI state (ui-state store),
// NOT the project/undo manager.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOpsHandlers = void 0;
const tslib_1 = require("tslib");
const fs = tslib_1.__importStar(require("fs"));
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const output_sections_1 = require("project-editor/store/output-sections");
const mobx_1 = require("mobx");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Local diagnostics helpers (self-contained copy of the non-exported helpers in
// handlers-project.ts, so this module has no cross-file dependency on them). ---------
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
// --- Build-file (code-generation template) helpers ---------------------------
/** The live build settings object, or throw. */
function requireBuild(store) {
    const build = store.project.settings?.build;
    if (!build) {
        throw new protocol_1.BridgeError("NOT_FOUND", "Project has no build settings (dashboard / master project).");
    }
    return build;
}
/** The live build-file template array (settings.build.files). */
function buildFiles(store) {
    return requireBuild(store).files || [];
}
/** Resolve one build file by objID | index | fileName. Returns { file, index }. */
function resolveBuildFile(store, params) {
    const files = buildFiles(store);
    if (params.objID != undefined) {
        const i = files.findIndex((f) => f.objID === params.objID);
        if (i < 0) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No build file with objID "${params.objID}".`);
        }
        return { file: files[i], index: i };
    }
    if (params.index != undefined) {
        const i = Number(params.index);
        if (!Number.isInteger(i) || i < 0 || i >= files.length) {
            throw new protocol_1.BridgeError("NOT_FOUND", `Build file index ${params.index} is out of range (0..${files.length - 1}).`);
        }
        return { file: files[i], index: i };
    }
    if (params.fileName != undefined) {
        const matches = files
            .map((f, i) => ({ f, i }))
            .filter((x) => x.f.fileName === params.fileName);
        if (matches.length === 0) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No build file named "${params.fileName}".`);
        }
        if (matches.length > 1) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Multiple build files named "${params.fileName}"; address it by index or objID instead.`);
        }
        return { file: matches[0].f, index: matches[0].i };
    }
    throw new protocol_1.BridgeError("BAD_PARAMS", "One of fileName, objID, or index is required.");
}
/** Literal (non-regex) find/replace; returns the new string + occurrence count. */
function literalReplaceAll(str, find, replacement, matchCase) {
    if (matchCase) {
        const parts = str.split(find);
        return { out: parts.join(replacement), count: parts.length - 1 };
    }
    // Case-insensitive literal scan; lowercasing preserves length, so the indices
    // computed against the lowercased copy are valid against the original string.
    const lower = str.toLowerCase();
    const needle = find.toLowerCase();
    let out = "";
    let prev = 0;
    let count = 0;
    let idx = lower.indexOf(needle, prev);
    while (idx !== -1) {
        out += str.substring(prev, idx) + replacement;
        prev = idx + needle.length;
        count++;
        idx = lower.indexOf(needle, prev);
    }
    return { out: out + str.substring(prev), count };
}
// --- ext_click_area injection into the ui.c build template -------------------
// EEZ has NO model property for a widget's extended click/touch area (it exists only as the
// LVGL runtime call lv_obj_set_ext_click_area), so set_ext_click_area maintains a self-managed
// helper in the ui.c template that applies the call to each named object once it exists, called
// from ui_tick() (works for flow + no-flow, whatever the object-creation timing).
const EXT_BEGIN = "/* ${eez-mcp:ext_click_area} managed by set_ext_click_area — do not edit */";
const EXT_END = "/* ${eez-mcp:ext_click_area:end} */";
const EXT_CALL = "eez_mcp_ext_click_areas(); /* ${eez-mcp:call} */";
/** Parse the identifier -> size map from the managed block, if present. */
function parseExtClickAreas(text) {
    const map = new Map();
    const bi = text.indexOf(EXT_BEGIN);
    const ei = text.indexOf(EXT_END);
    if (bi >= 0 && ei > bi) {
        const block = text.substring(bi, ei);
        const re = /objects\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(\d+)\s*\)/g;
        let m;
        while ((m = re.exec(block)) !== null) {
            map.set(m[1], parseInt(m[2], 10));
        }
    }
    return map;
}
/**
 * Rewrite the ui.c template so it applies exactly the given identifier -> size map via a
 * self-managed static helper called from every ui_tick(). Strips any prior managed block +
 * marked calls first (idempotent). Returns the new template text.
 */
function writeExtClickAreas(text, map) {
    // 1. strip a prior managed block + any marked calls.
    const bi = text.indexOf(EXT_BEGIN);
    const ei = text.indexOf(EXT_END);
    if (bi >= 0 && ei > bi) {
        text =
            text.substring(0, bi).replace(/\n+$/, "\n") +
                text.substring(ei + EXT_END.length).replace(/^\n+/, "");
    }
    text = text
        .split("\n")
        .filter(l => l.indexOf("${eez-mcp:call}") === -1)
        .join("\n");
    if (map.size === 0) {
        return text; // nothing left to inject
    }
    // 2. build the helper (int guard, no <stdbool.h> dependency).
    let helper = EXT_BEGIN + "\nstatic void eez_mcp_ext_click_areas(void) {\n";
    for (const [id, sz] of map) {
        helper +=
            `    { static int _a = 0; if (!_a && objects.${id}) { ` +
                `lv_obj_set_ext_click_area(objects.${id}, ${sz}); _a = 1; } }\n`;
    }
    helper += "}\n" + EXT_END + "\n";
    // 3. insert the helper right after the ACTIONS_ARRAY_DEF marker (file scope, before both
    //    #if/#else ui_tick definitions), else fall back to prepend.
    const anchor = "//${eez-studio LVGL_ACTIONS_ARRAY_DEF}";
    const ai = text.indexOf(anchor);
    if (ai >= 0) {
        const nl = text.indexOf("\n", ai);
        const at = nl >= 0 ? nl + 1 : text.length;
        text = text.substring(0, at) + "\n" + helper + text.substring(at);
    }
    else {
        text = helper + "\n" + text;
    }
    // 4. call it from every ui_tick().
    text = text.replace(/(void\s+ui_tick\s*\(\s*\)\s*\{)/g, `$1\n    ${EXT_CALL}`);
    return text;
}
exports.buildOpsHandlers = {
    // Build in-memory LVGL assets without writing files (fast validation).
    // store.buildAssets() = buildProject(store,"buildAssets"): assembles `parts` in
    // memory and returns it, writing NO files. Errors are recorded into Section.OUTPUT
    // (not thrown), so inspect numErrors rather than try/catch. GUI_ASSETS_DATA is a
    // Node Buffer — summarize it (byte length), never ship it raw over JSON-RPC.
    async build_assets() {
        const store = (0, project_access_1.requireLvglStore)();
        const t0 = Date.now();
        const parts = await store.buildAssets(); // may be undefined on error
        const durationMs = Date.now() - t0;
        const out = store.outputSectionsStore.getSection(output_sections_1.Section.OUTPUT);
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
        const store = (0, project_access_1.requireProjectStore)();
        const relative = store.project.settings.build.destinationFolder || ".";
        const absolute = store.getAbsoluteFilePath(relative);
        return { relative, absolute, exists: fs.existsSync(absolute) };
    },
    // Reveal the build output folder in the OS file manager (OS-shell side effect,
    // opens a Finder/Explorer window). shell.openPath resolves with "" on success or a
    // non-empty error string on failure. If the folder does not exist, report it as
    // not opened rather than spawning an error window.
    async open_build_folder() {
        const store = (0, project_access_1.requireProjectStore)();
        const relative = store.project.settings.build.destinationFolder || ".";
        const absolute = store.getAbsoluteFilePath(relative);
        if (!fs.existsSync(absolute)) {
            return { opened: false, path: absolute };
        }
        const { shell } = require("electron");
        const err = await shell.openPath(absolute); // "" on success
        return { opened: err === "", path: absolute };
    },
    // Read the build configurations and which one is selected. Pure reads.
    list_build_configurations() {
        const store = (0, project_access_1.requireProjectStore)();
        const configs = store.project.settings.build.configurations || [];
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
    set_build_configuration(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const name = params?.name;
        const configs = store.project.settings.build.configurations || [];
        if (!name || !configs.some(c => c && c.name === name)) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No build configuration named "${name}".`);
        }
        (0, mobx_1.runInAction)(() => store.uiStateStore.setSelectedBuildConfiguration(name));
        return { selected: store.selectedBuildConfiguration?.name ?? name };
    },
    // --- Build FILE templates (code-generation source) -----------------------
    // The per-file codegen templates at settings.build.files[N] carry the source the
    // LVGL/codegen pipeline expands into the generated files (e.g. ui.c). Editing the
    // GENERATED file is lost on the next rebuild; the template is the correct edit
    // target. Each BuildFile is an EezObject with { fileName, template, objID }; writes
    // go through updateObject (ONE undo step), so the GUI + undo stay consistent.
    // List every build-file template: index + fileName + objID + template size.
    list_build_files() {
        const store = (0, project_access_1.requireProjectStore)();
        const files = buildFiles(store);
        return {
            files: files.map((f, index) => ({
                index,
                fileName: f.fileName,
                objID: f.objID,
                templateLength: (f.template || "").length
            }))
        };
    },
    // Read one build-file template in full. Address by fileName | objID | index.
    get_build_file(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const { file, index } = resolveBuildFile(store, params);
        return {
            index,
            fileName: file.fileName,
            objID: file.objID,
            template: file.template != undefined ? file.template : ""
        };
    },
    // Replace a build-file template in full (ONE undo step). Address by fileName|objID|index.
    set_build_file_template(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (typeof params.template !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "template (string) is required.");
        }
        const { file, index } = resolveBuildFile(store, params);
        store.updateObject(file, { template: params.template });
        return {
            index,
            fileName: file.fileName,
            objID: file.objID,
            templateLength: params.template.length
        };
    },
    // Scoped find/replace INSIDE one build-file template (ONE undo step). Literal (not
    // regex), case-sensitive by default (code is case-sensitive). Optional expectedCount
    // guards against an unexpected match count; 0 matches => no write, changed:false.
    patch_build_file_template(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (typeof params.find !== "string" || params.find.length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "find (non-empty string) is required.");
        }
        if (typeof params.replacement !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "replacement (string) is required.");
        }
        const { file, index } = resolveBuildFile(store, params);
        const before = file.template != undefined ? file.template : "";
        const matchCase = params.matchCase !== false;
        const { out, count } = literalReplaceAll(before, params.find, params.replacement, matchCase);
        if (params.expectedCount != undefined && count !== params.expectedCount) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Expected ${params.expectedCount} occurrence(s) of the find text but found ${count}.`);
        }
        if (count === 0) {
            return {
                index,
                fileName: file.fileName,
                objID: file.objID,
                replacedCount: 0,
                changed: false
            };
        }
        store.updateObject(file, { template: out });
        return {
            index,
            fileName: file.fileName,
            objID: file.objID,
            replacedCount: count,
            changed: true
        };
    },
    // Set (or clear) a widget's LVGL **extended click / touch area**. EEZ has no model property
    // for this — it is only the runtime call lv_obj_set_ext_click_area — so this injects a
    // self-managed block into the `ui.c` build template that applies it to `objects.<identifier>`
    // once the object exists (called from ui_tick, robust to creation timing; survives rebuilds).
    // Address the widget by `identifier` (its C name) or `objID` (resolved to its identifier).
    // `size` is the extra px added on all sides; **size 0 removes** the entry. ONE undo step.
    set_ext_click_area(params) {
        const store = (0, project_access_1.requireProjectStore)();
        // Resolve the widget's C identifier (codegen names it objects.<identifier>).
        let identifier = params.identifier;
        if (!identifier && params.objID) {
            const obj = (0, project_access_1.resolveObject)(store, params.objID);
            identifier = obj && obj.identifier;
            if (!identifier) {
                throw new protocol_1.BridgeError("BAD_PARAMS", "That widget has no identifier — set one with set_identifier first " +
                    "(generated code references it as objects.<identifier>).");
            }
        }
        if (!identifier ||
            typeof identifier !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "identifier (a widget's C identifier) or objID of a widget with an identifier is required.");
        }
        const size = Number(params.size);
        if (!Number.isInteger(size) || size < 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "size (a non-negative integer of extra px on all sides; 0 removes) is required.");
        }
        const files = buildFiles(store);
        const fileName = params.fileName || "ui.c";
        const uic = files.find((f) => f.fileName === fileName);
        if (!uic) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No '${fileName}' build file. Available: ${files
                .map((f) => f.fileName)
                .join(", ")}.`);
        }
        const before = uic.template != undefined ? uic.template : "";
        if (!/void\s+ui_tick\s*\(\s*\)\s*\{/.test(before)) {
            throw new protocol_1.BridgeError("UNSUPPORTED", `'${fileName}' has no ui_tick() to hook — cannot inject the ext_click_area applier.`);
        }
        const map = parseExtClickAreas(before);
        if (size === 0) {
            map.delete(identifier);
        }
        else {
            map.set(identifier, size);
        }
        const after = writeExtClickAreas(before, map);
        store.updateObject(uic, { template: after });
        return {
            fileName: uic.fileName,
            objID: uic.objID,
            identifier,
            size,
            active: Array.from(map.entries()).map(([id, sz]) => ({
                identifier: id,
                size: sz
            }))
        };
    }
};
