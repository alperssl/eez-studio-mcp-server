// Clipboard bridge methods: copy / cut / paste of one or more EezObjects through
// EEZ Studio's OWN serialization + the Electron OS clipboard (MIME
// "application/eez-studio-project-editor-data"). Copy in one bridge call is
// pasteable by paste in the next — state lives on the real Electron clipboard,
// shared with the EEZ GUI, not on any per-call bridge variable.
//
// Undo semantics (per source report research/source-v4/clipboard.md):
//   - copy_objects / get_clipboard_info: pure reads of the project model; they
//     make ZERO project mutations and create NO undo entry (copy only writes the
//     OS clipboard).
//   - cut_objects: ONE undo step (store.deleteObjects is a single command); the
//     clipboard write happens AFTER the delete and is outside the undo txn,
//     mirroring the GUI cutItem/cutSelection path.
//   - paste_objects: a single addObject/addObjects/insertObject == one undo entry.

import {
    objectToClipboardData,
    copyProjectEditorDataToClipboard,
    getProjectEditorDataFromClipboard,
    checkClipboard,
    canPaste,
    pasteItem
} from "project-editor/store";
import { getClass } from "project-editor/core/object";
import { onAfterPaste } from "project-editor/core/util";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveObject,
    resolvePage
} from "mcp-bridge/project-access";

// --- Helpers ---------------------------------------------------------------

/** Serialize one or more objects to EEZ clipboard text, mirroring the GUI:
 *  single object -> objectToClipboardData (writes object/objectParentPath);
 *  multiple -> store.objectsToClipboardData (fires classInfo hooks, falls back
 *  to the free objectsToClipboardData). The paste engine branches on which
 *  field is present, so this single-vs-multi split keeps the data pasteable. */
function serializeObjects(store: any, objects: any[]): string {
    return objects.length === 1
        ? objectToClipboardData(store, objects[0])
        : store.objectsToClipboardData(objects);
}

/** Resolve the reference object a paste is resolved against, from an `into`
 *  target ({objID?} or {page?}). EEZ walks up from this reference to find the
 *  nearest container that can hold the pasted class, so passing a page's screen
 *  widget (or the page itself) lets findPastePlaceInside locate its children
 *  array. Returns undefined when neither is given. */
function resolveInto(store: any, into: any): any {
    if (!into) {
        return undefined;
    }
    if (into.objID) {
        return resolveObject(store, into.objID);
    }
    if (into.page) {
        const page = resolvePage(store, into.page);
        return page.lvglScreenWidget ?? page;
    }
    return undefined;
}

/** Require and validate a non-empty objIDs array from params. */
function requireObjIDs(params: any): string[] {
    const objIDs: string[] = params.objIDs;
    if (!Array.isArray(objIDs) || objIDs.length === 0) {
        throw new BridgeError("BAD_PARAMS", "objIDs[] is required.");
    }
    return objIDs;
}

// --- Handlers --------------------------------------------------------------

export const clipboardHandlers: Record<string, Handler> = {
    // Serialize the given objects with EEZ's own serializer and write them to the
    // OS (Electron) clipboard. Read-only w.r.t. the project — no undo entry.
    copy_objects(params: any) {
        const store = requireProjectStore();
        const objIDs = requireObjIDs(params);
        const objects = objIDs.map(id => resolveObject(store, id));

        const text = serializeObjects(store, objects);
        copyProjectEditorDataToClipboard(text);

        return {
            copied: objects.length,
            // objectClassName is the FIRST object's class on multi-copy, matching
            // clipboard.ts objectsToClipboardData.
            objectClassName: getClass(objects[0]).name
        };
    },

    // Copy + delete in ONE undo step. Serialize BEFORE deleting (deletion detaches
    // objects from the tree), then delete via store.deleteObjects (single undo
    // command, NO confirmation dialog — unlike the GUI deleteItems helper, which
    // can pop a modal for referenced objects and would hang a headless bridge
    // call), and finally write the clipboard outside the undo txn.
    cut_objects(params: any) {
        const store = requireProjectStore();
        const objIDs = requireObjIDs(params);
        const objects = objIDs.map(id => resolveObject(store, id));

        // Serialize first — must happen while objects are still attached.
        const text = serializeObjects(store, objects);

        // Single delete command == one undo entry (do NOT setCombineCommands).
        store.deleteObjects(objects);
        copyProjectEditorDataToClipboard(text);

        return { cut: objects.length, undoLabel: "Deleted" };
    },

    // Paste whatever is on the OS clipboard relative to the `into` reference.
    // EEZ's pasteItem engine mints FRESH objIDs (createObject(..., true)) and
    // resolves the actual container by walking up from the reference. A normal
    // paste is one addObject/addObjects/insertObject == one undo entry, so no
    // setCombineCommands is needed. pasteItem swallows errors and returns
    // undefined on failure, so we pre-flight with checkClipboard for an explicit
    // error and treat an undefined result as a failure.
    paste_objects(params: any) {
        const store = requireProjectStore();
        const reference = resolveInto(store, params.into);
        if (!reference) {
            throw new BridgeError(
                "BAD_PARAMS",
                "into.objID or into.page is required."
            );
        }

        // Pre-flight: is there pasteable data AND a valid place under `reference`?
        const check = checkClipboard(store, reference);
        if (!check) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Clipboard has no data that can be pasted into the target."
            );
        }

        const newObj: any = pasteItem(reference);
        if (!newObj) {
            throw new BridgeError("BAD_PARAMS", "Nothing was pasted.");
        }

        // Fire class-specific onAfterPaste hooks (matches the GUI paste path).
        onAfterPaste(newObj, reference);

        const objIDs: string[] = Array.isArray(newObj)
            ? newObj.map((o: any) => o.objID)
            : [newObj.objID];

        return { objIDs, undoLabel: "Added" };
    },

    // Inspect the OS clipboard: what EEZ data (if any) it holds, and whether it
    // can be pasted into an optional `into` target. Pure read — parsing the
    // clipboard mints objIDs internally but never attaches them to the tree, so
    // nothing is mutated and no undo entry is created.
    get_clipboard_info(params: any) {
        const store = requireProjectStore();
        const sd: any = getProjectEditorDataFromClipboard(store);

        const hasData = sd != undefined;
        const count = !sd
            ? 0
            : sd.objects
            ? sd.objects.length
            : sd.object
            ? 1
            : 0;

        let canPasteFlag = false;
        if (hasData && params.into) {
            const target = resolveInto(store, params.into);
            if (target) {
                canPasteFlag = canPaste(store, target) != undefined;
            }
        }

        return {
            hasData,
            objectClassName: hasData ? sd.objectClassName : null,
            count,
            canPaste: canPasteFlag
        };
    }
};
