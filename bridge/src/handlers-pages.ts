// Page/screen lifecycle handlers: create / delete / rename / reorder / settings.
// All mutations go through the ProjectStore command API so the GUI, undo/redo,
// validation and codegen stay consistent. New screens go into project.userPages
// (project.pages is a computed union of userPages+userWidgets and cannot be spliced).

import { createObject } from "project-editor/store";
import { findClass, getDefaultValue } from "project-editor/core/object";
import { replaceObjectReference } from "project-editor/core/search";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireLvglStore,
    requireProjectStore,
    resolvePage,
    ProjectStoreLike
} from "mcp-bridge/project-access";

/** Throw BAD_PARAMS if a page name already exists in the project (pages = union). */
function assertPageNameFree(store: ProjectStoreLike, name: string): void {
    if (!name) {
        throw new BridgeError("BAD_PARAMS", "page name is required.");
    }
    const pages: any[] = store.project.pages || [];
    if (pages.some((p: any) => p && p.name === name)) {
        throw new BridgeError(
            "BAD_PARAMS",
            `A page named "${name}" already exists.`
        );
    }
}

export const pagesHandlers: Record<string, Handler> = {
    create_page(params: any) {
        const store = requireLvglStore();
        const name: string = params.name;
        if (!name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertPageNameFree(store, name);

        const cls = findClass("Page");
        if (!cls) {
            throw new BridgeError("NOT_FOUND", 'Page class not found.');
        }

        const g = store.project.settings.general;
        const seed: any = {
            ...(getDefaultValue(store, cls.classInfo) || {}),
            name,
            left: 0,
            top: 0,
            width: params.width ?? g.displayWidth,
            height: params.height ?? g.displayHeight,
            components: [],
            isUsedAsUserWidget: false
        };

        // beforeLoadHook (fired inside createObject) injects the root LVGLScreenWidget.
        const page: any = createObject(store, seed, cls);

        const userPages: any[] = store.project.userPages;
        if (typeof params.index === "number") {
            const idx = Math.max(0, Math.min(params.index, userPages.length));
            store.insertObject(userPages, idx, page);
        } else {
            store.addObject(userPages, page);
        }

        return {
            page: page.name,
            rootObjID: page.lvglScreenWidget?.objID ?? null
        };
    },

    delete_page(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.name);
        store.deleteObject(page);
        return { deleted: params.name };
    },

    rename_page(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.name);
        const newName: string = params.newName;
        if (!newName) {
            throw new BridgeError("BAD_PARAMS", "newName is required.");
        }
        if (newName !== page.name) {
            assertPageNameFree(store, newName);
        }

        // Rebind all references then rename, as one undo step (mirrors the UI's
        // UniqueValueInput rename path).
        store.undoManager.setCombineCommands(true);
        try {
            replaceObjectReference(page, newName);
            store.updateObject(page, { name: newName });
        } finally {
            store.undoManager.setCombineCommands(false);
        }

        return { page: newName };
    },

    reorder_page(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.name);
        const userPages: any[] = store.project.userPages;
        if (userPages.indexOf(page) < 0) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Page "${params.name}" is not a reorderable screen.`
            );
        }
        if (typeof params.index !== "number") {
            throw new BridgeError("BAD_PARAMS", "index (number) is required.");
        }
        const idx = Math.max(0, Math.min(params.index, userPages.length - 1));

        // Remove + reinsert at the target index, as one undo step.
        store.undoManager.setCombineCommands(true);
        try {
            store.deleteObject(page);
            store.insertObject(userPages, idx, page);
        } finally {
            store.undoManager.setCombineCommands(false);
        }

        return { page: page.name, index: idx };
    },

    set_page_settings(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.name);
        const props = params.props || {};

        // A name change must go through the reference-rebinding rename path.
        if (props.name !== undefined && props.name !== page.name) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Use rename_page to change a page's name (references must be rebound)."
            );
        }

        store.updateObject(page, props);
        return { page: page.name };
    }
};
