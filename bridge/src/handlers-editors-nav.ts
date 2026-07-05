// Editor-tab lifecycle + navigation/selection handlers, mapped onto EEZ's real
// EditorsStore + NavigationStore. See research/source-v4/editors-nav.md.
//
// CROSS-CUTTING RULE: every tool in this module manipulates TRANSIENT UI/renderer
// state — open editor tabs, the active tab, the flow-editor selection, the
// per-collection navigation selection boxes, and showObjects reveal/scroll. NONE
// of these go through store.addObject/updateObject/deleteObject and NONE are
// recorded by the undo manager. So NOTHING here is wrapped in
// undoManager.setCombineCommands and NOTHING calls updateObject. This mirrors the
// existing bridge (handlers.ts select_widget/open_page) and set_active_theme.

import { getObjectPathAsString } from "project-editor/store";
import { getParent } from "project-editor/core/object";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { runInAction } from "mobx";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveObject,
    resolveObjectOrPath,
    ProjectStoreLike
} from "mcp-bridge/project-access";

/**
 * Map of navigation "collection" keys (the public API surface) to the actual
 * observable.box field name on NavigationStore (navigation.ts:62-81, 106).
 */
const NAV_BOXES: Record<string, string> = {
    userPage: "selectedUserPageObject",
    userWidget: "selectedUserWidgetObject",
    action: "selectedActionObject",
    globalVariable: "selectedGlobalVariableObject",
    structure: "selectedStructureObject",
    enum: "selectedEnumObject",
    style: "selectedStyleObject",
    theme: "selectedThemeObject",
    themeColor: "selectedThemeColorObject",
    font: "selectedFontObject",
    glyph: "selectedGlyphObject",
    bitmap: "selectedBitmapObject",
    extensionDefinition: "selectedExtensionDefinitionObject",
    scpiSubsystem: "selectedScpiSubsystemObject",
    scpiCommand: "selectedScpiCommandObject",
    scpiEnum: "selectedScpiEnumObject",
    instrumentCommands: "selectedInstrumentCommandsObject",
    textResource: "selectedTextResourceObject",
    language: "selectedLanguageObject",
    lvglGroup: "selectedLvglGroupObject",
    localVariable: "selectedLocalVariable"
};

/** Best-effort path string; null if the object can't be serialized. */
function safePath(obj: any): string | null {
    try {
        return getObjectPathAsString(obj);
    } catch {
        return null;
    }
}

/** Shape one open Editor tab for return. */
function describeEditor(store: ProjectStoreLike, ed: any): any {
    return {
        objID: ed.object?.objID,
        path: ed.object ? safePath(ed.object) : null,
        tabId: ed.tabId,
        title: ed.title,
        active: ed === store.editorsStore.activeEditor,
        permanent: ed.permanent
    };
}

export const editorsNavHandlers: Record<string, Handler> = {
    // --- Reveal / editor-tab lifecycle --------------------------------------

    reveal_object(params: any) {
        const store = requireProjectStore();
        const obj = resolveObjectOrPath(store, params);
        const openEditor = params.openEditor !== false; // default true
        const showInNavigation = params.showInNavigation !== false; // default true
        const select = params.select !== false; // default true
        // Single EEZ entry point (navigation.ts:440). mobx action, no undo.
        store.navigationStore.showObjects(
            [obj],
            openEditor,
            showInNavigation,
            select
        );
        return {
            objID: obj.objID,
            path: safePath(obj),
            editorOpened:
                openEditor &&
                !!ProjectEditor.getAncestorWithEditorComponent(obj)
        };
    },

    open_editor(params: any) {
        const store = requireProjectStore();
        const obj = resolveObjectOrPath(store, params);
        let ed: any;
        if (params.permanent) {
            // openPermanentEditor returns void (editor.ts:516) — re-fetch.
            store.editorsStore.openPermanentEditor(obj);
            ed = store.editorsStore.getEditorByObject(obj);
        } else {
            ed = store.editorsStore.openEditor(obj); // editor.ts:388 returns Editor
        }
        if (!ed) {
            throw new BridgeError(
                "NOT_FOUND",
                "Could not open an editor for that object."
            );
        }
        return { tabId: ed.tabId, title: ed.title };
    },

    activate_editor(params: any) {
        const store = requireProjectStore();
        const obj = resolveObjectOrPath(store, params);
        const ed = store.editorsStore.getEditorByObject(obj); // editor.ts:238
        if (!ed) {
            throw new BridgeError(
                "NOT_FOUND",
                "No open editor for that object."
            );
        }
        // selectEditorTabForObject sets activeEditor synchronously in runInAction
        // (editor.ts:542), so the isActive read below is reliable — unlike
        // activateEditor whose activeEditor is reconciled on a setTimeout.
        store.editorsStore.selectEditorTabForObject(obj);
        return {
            tabId: ed.tabId,
            isActive: store.editorsStore.activeEditor === ed
        };
    },

    list_editors() {
        const store = requireProjectStore();
        const es = store.editorsStore;
        return {
            editors: (es.editors || []).map((ed: any) =>
                describeEditor(store, ed)
            )
        };
    },

    close_editor(params: any) {
        const store = requireProjectStore();
        const obj = resolveObjectOrPath(store, params);
        const ed = store.editorsStore.getEditorByObject(obj); // editor.ts:238
        if (!ed) {
            return { closed: false };
        }
        // Closes the tab only; does NOT delete the edited object.
        store.editorsStore.closeEditorForObject(obj); // editor.ts:535
        return { closed: true };
    },

    get_active_editor() {
        const store = requireProjectStore();
        const ed = store.editorsStore.activeEditor; // editor.ts:161
        if (!ed) {
            return null;
        }
        return {
            tabId: ed.tabId,
            objID: ed.object?.objID,
            path: ed.object ? safePath(ed.object) : null,
            title: ed.title
        };
    },

    // --- Selection ----------------------------------------------------------

    select_all() {
        const store = requireProjectStore();
        const sel: any[] =
            store.navigationStore.selectedPanel?.selectedObjects || [];
        if (sel.length === 0) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Select at least one widget first so select_all knows the container."
            );
        }
        const first = sel[0];
        // getParent(widget) is the children[] array holding its siblings.
        const siblingsArray: any = getParent(first);
        const siblings: any[] = Array.isArray(siblingsArray)
            ? siblingsArray
            : [first];
        // openEditor=true (scroll into view), showInNavigation=false, select=true.
        store.navigationStore.showObjects(siblings, true, false, true);
        return { objIDs: siblings.map((w: any) => w.objID) };
    },

    set_selection(params: any) {
        const store = requireProjectStore();
        const ids: string[] = params.objIDs || [];
        if (ids.length === 0) {
            throw new BridgeError(
                "BAD_PARAMS",
                "objIDs must be a non-empty array."
            );
        }
        const objs = ids.map((id: string) => resolveObject(store, id));
        const ensureVisible = params.ensureVisible !== false; // default true
        // ensureVisible maps to openEditor arg: the scroll-into-view side effect
        // lives in the openEditor=true branch (navigation.ts:461-464). When false,
        // select=true still sets the selection without forcing the editor/scroll.
        store.navigationStore.showObjects(objs, ensureVisible, false, true);
        return { objIDs: objs.map((o: any) => o.objID) };
    },

    // --- Navigation-store per-collection selection --------------------------

    get_navigation_state() {
        const store = requireProjectStore();
        const ns: any = store.navigationStore;
        const selected: Record<string, any> = {};
        for (const [key, box] of Object.entries(NAV_BOXES)) {
            const obj = ns[box]?.get(); // observable.box (navigation.ts:62-81)
            selected[key] = obj
                ? {
                      objID: obj.objID,
                      path: safePath(obj),
                      name: (obj as any).name
                  }
                : null;
        }
        return { selected };
    },

    select_in_navigation(params: any) {
        const store = requireProjectStore();
        const boxName = NAV_BOXES[params.collection];
        if (!boxName) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown collection "${params.collection}". Valid: ${Object.keys(
                    NAV_BOXES
                ).join(", ")}.`
            );
        }
        const obj = resolveObjectOrPath(store, params);
        const ns: any = store.navigationStore;
        // EEZ sets these boxes inside runInAction (navigation.ts:165, 275) —
        // mirror that to avoid mobx enforceActions warnings. Not an undo command.
        runInAction(() => {
            ns[boxName].set(obj);
        });
        // Reveal the correct left-panel tab.
        ProjectEditor.navigateTo(obj); // NavigationComponentFactory.tsx:143
        return { collection: params.collection, objID: obj.objID };
    }
};
