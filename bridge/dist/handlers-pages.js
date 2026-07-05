"use strict";
// Page/screen lifecycle handlers: create / delete / rename / reorder / settings.
// All mutations go through the ProjectStore command API so the GUI, undo/redo,
// validation and codegen stay consistent. New screens go into project.userPages
// (project.pages is a computed union of userPages+userWidgets and cannot be spliced).
Object.defineProperty(exports, "__esModule", { value: true });
exports.pagesHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const search_1 = require("project-editor/core/search");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
/** Throw BAD_PARAMS if a page name already exists in the project (pages = union). */
function assertPageNameFree(store, name) {
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "page name is required.");
    }
    const pages = store.project.pages || [];
    if (pages.some((p) => p && p.name === name)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `A page named "${name}" already exists.`);
    }
}
exports.pagesHandlers = {
    create_page(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const name = params.name;
        if (!name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        assertPageNameFree(store, name);
        const cls = (0, object_1.findClass)("Page");
        if (!cls) {
            throw new protocol_1.BridgeError("NOT_FOUND", 'Page class not found.');
        }
        const g = store.project.settings.general;
        const seed = {
            ...((0, object_1.getDefaultValue)(store, cls.classInfo) || {}),
            name,
            left: 0,
            top: 0,
            width: params.width ?? g.displayWidth,
            height: params.height ?? g.displayHeight,
            components: [],
            isUsedAsUserWidget: false
        };
        // beforeLoadHook (fired inside createObject) injects the root LVGLScreenWidget.
        const page = (0, store_1.createObject)(store, seed, cls);
        const userPages = store.project.userPages;
        if (typeof params.index === "number") {
            const idx = Math.max(0, Math.min(params.index, userPages.length));
            store.insertObject(userPages, idx, page);
        }
        else {
            store.addObject(userPages, page);
        }
        return {
            page: page.name,
            rootObjID: page.lvglScreenWidget?.objID ?? null
        };
    },
    delete_page(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.name);
        store.deleteObject(page);
        return { deleted: params.name };
    },
    rename_page(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.name);
        const newName = params.newName;
        if (!newName) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "newName is required.");
        }
        if (newName !== page.name) {
            assertPageNameFree(store, newName);
        }
        // Rebind all references then rename, as one undo step (mirrors the UI's
        // UniqueValueInput rename path).
        store.undoManager.setCombineCommands(true);
        try {
            (0, search_1.replaceObjectReference)(page, newName);
            store.updateObject(page, { name: newName });
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { page: newName };
    },
    reorder_page(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.name);
        const userPages = store.project.userPages;
        if (userPages.indexOf(page) < 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Page "${params.name}" is not a reorderable screen.`);
        }
        if (typeof params.index !== "number") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "index (number) is required.");
        }
        const idx = Math.max(0, Math.min(params.index, userPages.length - 1));
        // Remove + reinsert at the target index, as one undo step.
        store.undoManager.setCombineCommands(true);
        try {
            store.deleteObject(page);
            store.insertObject(userPages, idx, page);
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { page: page.name, index: idx };
    },
    set_page_settings(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.name);
        const props = params.props || {};
        // A name change must go through the reference-rebinding rename path.
        if (props.name !== undefined && props.name !== page.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Use rename_page to change a page's name (references must be rebound).");
        }
        store.updateObject(page, props);
        return { page: page.name };
    }
};
