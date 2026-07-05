"use strict";
// Resolving the active project + objects, all against the LIVE renderer ProjectStore.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveProjectStore = getActiveProjectStore;
exports.requireProjectStore = requireProjectStore;
exports.requireLvglStore = requireLvglStore;
exports.resolveObject = resolveObject;
exports.resolveObjectOrPath = resolveObjectOrPath;
exports.resolveFlow = resolveFlow;
exports.resolvePage = resolvePage;
exports.pageChildrenTarget = pageChildrenTarget;
exports.absoluteRect = absoluteRect;
exports.pageOfObject = pageOfObject;
exports.resolveByName = resolveByName;
exports.assertNameFree = assertNameFree;
exports.projectStyles = projectStyles;
exports.projectFonts = projectFonts;
exports.projectBitmaps = projectBitmaps;
exports.projectActions = projectActions;
exports.projectColors = projectColors;
exports.projectVariables = projectVariables;
exports.projectEnums = projectEnums;
exports.projectStructures = projectStructures;
exports.projectUserWidgets = projectUserWidgets;
exports.projectGroups = projectGroups;
exports.projectThemes = projectThemes;
const tabs_store_1 = require("home/tabs-store");
const object_1 = require("project-editor/core/object");
const store_1 = require("project-editor/store");
const protocol_1 = require("mcp-bridge/protocol");
/** The currently-active project editor's store, or undefined if none is open. */
function getActiveProjectStore() {
    const tab = tabs_store_1.tabs?.activeTab;
    if (tab instanceof tabs_store_1.ProjectEditorTab && tab.projectStore) {
        return tab.projectStore;
    }
    return undefined;
}
/** Active store or throw NO_PROJECT. */
function requireProjectStore() {
    const store = getActiveProjectStore();
    if (!store || !store.project) {
        throw new protocol_1.BridgeError("NO_PROJECT", "No project is open in EEZ Studio. Open a .eez-project first.");
    }
    return store;
}
/** Active store that is an LVGL project, or throw. */
function requireLvglStore() {
    const store = requireProjectStore();
    const general = store.project.settings?.general;
    if (!general || !general.lvglVersion) {
        throw new protocol_1.BridgeError("NOT_LVGL", "The open project is not an LVGL project.");
    }
    return store;
}
/** Resolve a widget/object by its serialized objID GUID. */
function resolveObject(store, objID) {
    if (!objID) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "objID is required.");
    }
    const obj = store.project._objectsMap.get(objID);
    if (!obj) {
        throw new protocol_1.BridgeError("NOT_FOUND", `No object with objID "${objID}".`);
    }
    return obj;
}
/** Resolve an object by its objID GUID or by an EEZ string path (either/or). */
function resolveObjectOrPath(store, params) {
    if (params.objID) {
        return resolveObject(store, params.objID);
    }
    if (params.path) {
        const obj = (0, store_1.getObjectFromStringPath)(store.project, params.path);
        if (!obj) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No object at path "${params.path}".`);
        }
        return obj;
    }
    throw new protocol_1.BridgeError("BAD_PARAMS", "Either objID or path is required.");
}
/** Resolve a flow (a Page or an Action, both extend Flow) by page name or action name. */
function resolveFlow(store, params) {
    if (params.page) {
        return resolvePage(store, params.page);
    }
    if (params.action) {
        return resolveByName(store.project.actions || [], params.action, "action");
    }
    throw new protocol_1.BridgeError("BAD_PARAMS", "Either page or action is required to identify the flow.");
}
/** Resolve a page by its unique name. */
function resolvePage(store, name) {
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "page name is required.");
    }
    const pages = store.project.pages || [];
    const page = pages.find(p => p.name === name);
    if (!page) {
        throw new protocol_1.BridgeError("NOT_FOUND", `No page named "${name}".`);
    }
    return page;
}
/** The array new top-level widgets should be added into for a page. */
function pageChildrenTarget(page) {
    const screen = page.lvglScreenWidget;
    if (screen && Array.isArray(screen.children)) {
        return screen.children;
    }
    return page.components;
}
/** Best-effort page-space absolute rect (sums px offsets up the widget chain). */
function absoluteRect(widget) {
    let x = 0;
    let y = 0;
    let cur = widget;
    // Guard against pathological trees.
    for (let i = 0; i < 64 && cur && cur.left !== undefined; i++) {
        if (cur.leftUnit === "px" || cur.leftUnit === undefined) {
            x += cur.left || 0;
        }
        if (cur.topUnit === "px" || cur.topUnit === undefined) {
            y += cur.top || 0;
        }
        const arr = (0, object_1.getParent)(cur);
        const parent = arr ? (0, object_1.getParent)(arr) : undefined;
        if (parent &&
            parent.left !== undefined &&
            parent.type !== "LVGLScreenWidget") {
            cur = parent;
        }
        else {
            break;
        }
    }
    return { x, y, width: widget.width || 0, height: widget.height || 0 };
}
/** The page that contains an object (or undefined). */
function pageOfObject(obj) {
    let cur = obj;
    for (let i = 0; i < 128 && cur; i++) {
        if (cur.constructor && cur.constructor.name === "Page") {
            return cur;
        }
        cur = (0, object_1.getParent)(cur);
    }
    return undefined;
}
// --- Named-entity access (fonts / bitmaps / actions / styles / colors / variables) ---
/** Find a named entity in a project array, or throw NOT_FOUND. */
function resolveByName(list, name, kind) {
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `${kind} name is required.`);
    }
    const found = (list || []).find(x => x && x.name === name);
    if (!found) {
        throw new protocol_1.BridgeError("NOT_FOUND", `No ${kind} named "${name}".`);
    }
    return found;
}
/** Throw BAD_PARAMS if a name is already taken in a project array. */
function assertNameFree(list, name, kind) {
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `${kind} name is required.`);
    }
    if ((list || []).some(x => x && x.name === name)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `A ${kind} named "${name}" already exists.`);
    }
}
function projectStyles(store) {
    return store.project.lvglStyles?.styles || [];
}
function projectFonts(store) {
    return store.project.fonts || [];
}
function projectBitmaps(store) {
    return store.project.bitmaps || [];
}
function projectActions(store) {
    return store.project.actions || [];
}
function projectColors(store) {
    return store.project.colors || [];
}
function projectVariables(store) {
    return store.project.variables?.globalVariables || [];
}
function projectEnums(store) {
    return store.project.variables?.enums || [];
}
function projectStructures(store) {
    return store.project.variables?.structures || [];
}
function projectUserWidgets(store) {
    return store.project.userWidgets || [];
}
function projectGroups(store) {
    return store.project.lvglGroups?.groups || [];
}
function projectThemes(store) {
    return store.project.themes || [];
}
