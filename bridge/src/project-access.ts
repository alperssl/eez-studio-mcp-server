// Resolving the active project + objects, all against the LIVE renderer ProjectStore.

import { tabs, ProjectEditorTab } from "home/tabs-store";
import { getParent } from "project-editor/core/object";
import { getObjectFromStringPath } from "project-editor/store";
import { BridgeError, AbsRect } from "mcp-bridge/protocol";

// The ProjectStore type is intentionally loose here; the bridge is glue code over
// EEZ's dynamic object model (mirrors the `any` usage throughout the codebase).
export type ProjectStoreLike = any;

/** The currently-active project editor's store, or undefined if none is open. */
export function getActiveProjectStore(): ProjectStoreLike | undefined {
    const tab = tabs?.activeTab;
    if (tab instanceof ProjectEditorTab && tab.projectStore) {
        return tab.projectStore;
    }
    return undefined;
}

/** Active store or throw NO_PROJECT. */
export function requireProjectStore(): ProjectStoreLike {
    const store = getActiveProjectStore();
    if (!store || !store.project) {
        throw new BridgeError(
            "NO_PROJECT",
            "No project is open in EEZ Studio. Open a .eez-project first."
        );
    }
    return store;
}

/** Active store that is an LVGL project, or throw. */
export function requireLvglStore(): ProjectStoreLike {
    const store = requireProjectStore();
    const general = store.project.settings?.general;
    if (!general || !general.lvglVersion) {
        throw new BridgeError(
            "NOT_LVGL",
            "The open project is not an LVGL project."
        );
    }
    return store;
}

/** Resolve a widget/object by its serialized objID GUID. */
export function resolveObject(store: ProjectStoreLike, objID: string): any {
    if (!objID) {
        throw new BridgeError("BAD_PARAMS", "objID is required.");
    }
    const obj = store.project._objectsMap.get(objID);
    if (!obj) {
        throw new BridgeError("NOT_FOUND", `No object with objID "${objID}".`);
    }
    return obj;
}

/** Resolve an object by its objID GUID or by an EEZ string path (either/or). */
export function resolveObjectOrPath(
    store: ProjectStoreLike,
    params: { objID?: string; path?: string }
): any {
    if (params.objID) {
        return resolveObject(store, params.objID);
    }
    if (params.path) {
        const obj = getObjectFromStringPath(store.project, params.path);
        if (!obj) {
            throw new BridgeError(
                "NOT_FOUND",
                `No object at path "${params.path}".`
            );
        }
        return obj;
    }
    throw new BridgeError("BAD_PARAMS", "Either objID or path is required.");
}

/** Resolve a flow (a Page or an Action, both extend Flow) by page name or action name. */
export function resolveFlow(
    store: ProjectStoreLike,
    params: { page?: string; action?: string }
): any {
    if (params.page) {
        return resolvePage(store, params.page);
    }
    if (params.action) {
        return resolveByName(
            store.project.actions || [],
            params.action,
            "action"
        );
    }
    throw new BridgeError(
        "BAD_PARAMS",
        "Either page or action is required to identify the flow."
    );
}

/** Resolve a page by its unique name. */
export function resolvePage(store: ProjectStoreLike, name: string): any {
    if (!name) {
        throw new BridgeError("BAD_PARAMS", "page name is required.");
    }
    const pages: any[] = store.project.pages || [];
    const page = pages.find(p => p.name === name);
    if (!page) {
        throw new BridgeError("NOT_FOUND", `No page named "${name}".`);
    }
    return page;
}

/** The array new top-level widgets should be added into for a page. */
export function pageChildrenTarget(page: any): any[] {
    const screen = page.lvglScreenWidget;
    if (screen && Array.isArray(screen.children)) {
        return screen.children;
    }
    return page.components;
}

/** Best-effort page-space absolute rect (sums px offsets up the widget chain). */
export function absoluteRect(widget: any): AbsRect {
    let x = 0;
    let y = 0;
    let cur: any = widget;
    // Guard against pathological trees.
    for (let i = 0; i < 64 && cur && cur.left !== undefined; i++) {
        if (cur.leftUnit === "px" || cur.leftUnit === undefined) {
            x += cur.left || 0;
        }
        if (cur.topUnit === "px" || cur.topUnit === undefined) {
            y += cur.top || 0;
        }
        const arr = getParent(cur);
        const parent = arr ? getParent(arr) : undefined;
        if (
            parent &&
            (parent as any).left !== undefined &&
            (parent as any).type !== "LVGLScreenWidget"
        ) {
            cur = parent;
        } else {
            break;
        }
    }
    return { x, y, width: widget.width || 0, height: widget.height || 0 };
}

/** The page that contains an object (or undefined). */
export function pageOfObject(obj: any): any {
    let cur: any = obj;
    for (let i = 0; i < 128 && cur; i++) {
        if (cur.constructor && cur.constructor.name === "Page") {
            return cur;
        }
        cur = getParent(cur);
    }
    return undefined;
}

// --- Named-entity access (fonts / bitmaps / actions / styles / colors / variables) ---

/** Find a named entity in a project array, or throw NOT_FOUND. */
export function resolveByName(
    list: any[] | undefined,
    name: string,
    kind: string
): any {
    if (!name) {
        throw new BridgeError("BAD_PARAMS", `${kind} name is required.`);
    }
    const found = (list || []).find(x => x && x.name === name);
    if (!found) {
        throw new BridgeError("NOT_FOUND", `No ${kind} named "${name}".`);
    }
    return found;
}

/** Throw BAD_PARAMS if a name is already taken in a project array. */
export function assertNameFree(
    list: any[] | undefined,
    name: string,
    kind: string
): void {
    if (!name) {
        throw new BridgeError("BAD_PARAMS", `${kind} name is required.`);
    }
    if ((list || []).some(x => x && x.name === name)) {
        throw new BridgeError("BAD_PARAMS", `A ${kind} named "${name}" already exists.`);
    }
}

export function projectStyles(store: ProjectStoreLike): any[] {
    return store.project.lvglStyles?.styles || [];
}
export function projectFonts(store: ProjectStoreLike): any[] {
    return store.project.fonts || [];
}
export function projectBitmaps(store: ProjectStoreLike): any[] {
    return store.project.bitmaps || [];
}
export function projectActions(store: ProjectStoreLike): any[] {
    return store.project.actions || [];
}
export function projectColors(store: ProjectStoreLike): any[] {
    return store.project.colors || [];
}
export function projectVariables(store: ProjectStoreLike): any[] {
    return store.project.variables?.globalVariables || [];
}
export function projectEnums(store: ProjectStoreLike): any[] {
    return store.project.variables?.enums || [];
}
export function projectStructures(store: ProjectStoreLike): any[] {
    return store.project.variables?.structures || [];
}
export function projectUserWidgets(store: ProjectStoreLike): any[] {
    return store.project.userWidgets || [];
}
export function projectGroups(store: ProjectStoreLike): any[] {
    return store.project.lvglGroups?.groups || [];
}
export function projectThemes(store: ProjectStoreLike): any[] {
    return store.project.themes || [];
}
