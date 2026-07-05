"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.editorsNavHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const mobx_1 = require("mobx");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
/**
 * Map of navigation "collection" keys (the public API surface) to the actual
 * observable.box field name on NavigationStore (navigation.ts:62-81, 106).
 */
const NAV_BOXES = {
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
function safePath(obj) {
    try {
        return (0, store_1.getObjectPathAsString)(obj);
    }
    catch {
        return null;
    }
}
/** Shape one open Editor tab for return. */
function describeEditor(store, ed) {
    return {
        objID: ed.object?.objID,
        path: ed.object ? safePath(ed.object) : null,
        tabId: ed.tabId,
        title: ed.title,
        active: ed === store.editorsStore.activeEditor,
        permanent: ed.permanent
    };
}
exports.editorsNavHandlers = {
    // --- Reveal / editor-tab lifecycle --------------------------------------
    reveal_object(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const obj = (0, project_access_1.resolveObjectOrPath)(store, params);
        const openEditor = params.openEditor !== false; // default true
        const showInNavigation = params.showInNavigation !== false; // default true
        const select = params.select !== false; // default true
        // Single EEZ entry point (navigation.ts:440). mobx action, no undo.
        store.navigationStore.showObjects([obj], openEditor, showInNavigation, select);
        return {
            objID: obj.objID,
            path: safePath(obj),
            editorOpened: openEditor &&
                !!project_editor_interface_1.ProjectEditor.getAncestorWithEditorComponent(obj)
        };
    },
    open_editor(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const obj = (0, project_access_1.resolveObjectOrPath)(store, params);
        let ed;
        if (params.permanent) {
            // openPermanentEditor returns void (editor.ts:516) — re-fetch.
            store.editorsStore.openPermanentEditor(obj);
            ed = store.editorsStore.getEditorByObject(obj);
        }
        else {
            ed = store.editorsStore.openEditor(obj); // editor.ts:388 returns Editor
        }
        if (!ed) {
            throw new protocol_1.BridgeError("NOT_FOUND", "Could not open an editor for that object.");
        }
        return { tabId: ed.tabId, title: ed.title };
    },
    activate_editor(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const obj = (0, project_access_1.resolveObjectOrPath)(store, params);
        const ed = store.editorsStore.getEditorByObject(obj); // editor.ts:238
        if (!ed) {
            throw new protocol_1.BridgeError("NOT_FOUND", "No open editor for that object.");
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
        const store = (0, project_access_1.requireProjectStore)();
        const es = store.editorsStore;
        return {
            editors: (es.editors || []).map((ed) => describeEditor(store, ed))
        };
    },
    close_editor(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const obj = (0, project_access_1.resolveObjectOrPath)(store, params);
        const ed = store.editorsStore.getEditorByObject(obj); // editor.ts:238
        if (!ed) {
            return { closed: false };
        }
        // Closes the tab only; does NOT delete the edited object.
        store.editorsStore.closeEditorForObject(obj); // editor.ts:535
        return { closed: true };
    },
    get_active_editor() {
        const store = (0, project_access_1.requireProjectStore)();
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
        const store = (0, project_access_1.requireProjectStore)();
        const sel = store.navigationStore.selectedPanel?.selectedObjects || [];
        if (sel.length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Select at least one widget first so select_all knows the container.");
        }
        const first = sel[0];
        // getParent(widget) is the children[] array holding its siblings.
        const siblingsArray = (0, object_1.getParent)(first);
        const siblings = Array.isArray(siblingsArray)
            ? siblingsArray
            : [first];
        // openEditor=true (scroll into view), showInNavigation=false, select=true.
        store.navigationStore.showObjects(siblings, true, false, true);
        return { objIDs: siblings.map((w) => w.objID) };
    },
    set_selection(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const ids = params.objIDs || [];
        if (ids.length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "objIDs must be a non-empty array.");
        }
        const objs = ids.map((id) => (0, project_access_1.resolveObject)(store, id));
        const ensureVisible = params.ensureVisible !== false; // default true
        // ensureVisible maps to openEditor arg: the scroll-into-view side effect
        // lives in the openEditor=true branch (navigation.ts:461-464). When false,
        // select=true still sets the selection without forcing the editor/scroll.
        store.navigationStore.showObjects(objs, ensureVisible, false, true);
        return { objIDs: objs.map((o) => o.objID) };
    },
    // --- Navigation-store per-collection selection --------------------------
    get_navigation_state() {
        const store = (0, project_access_1.requireProjectStore)();
        const ns = store.navigationStore;
        const selected = {};
        for (const [key, box] of Object.entries(NAV_BOXES)) {
            const obj = ns[box]?.get(); // observable.box (navigation.ts:62-81)
            selected[key] = obj
                ? {
                    objID: obj.objID,
                    path: safePath(obj),
                    name: obj.name
                }
                : null;
        }
        return { selected };
    },
    select_in_navigation(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const boxName = NAV_BOXES[params.collection];
        if (!boxName) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown collection "${params.collection}". Valid: ${Object.keys(NAV_BOXES).join(", ")}.`);
        }
        const obj = (0, project_access_1.resolveObjectOrPath)(store, params);
        const ns = store.navigationStore;
        // EEZ sets these boxes inside runInAction (navigation.ts:165, 275) —
        // mirror that to avoid mobx enforceActions warnings. Not an undo command.
        (0, mobx_1.runInAction)(() => {
            ns[boxName].set(obj);
        });
        // Reveal the correct left-panel tab.
        project_editor_interface_1.ProjectEditor.navigateTo(obj); // NavigationComponentFactory.tsx:143
        return { collection: params.collection, objID: obj.objID };
    }
};
