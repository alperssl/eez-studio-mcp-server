"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.clipboardHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const util_1 = require("project-editor/core/util");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Helpers ---------------------------------------------------------------
/** Serialize one or more objects to EEZ clipboard text, mirroring the GUI:
 *  single object -> objectToClipboardData (writes object/objectParentPath);
 *  multiple -> store.objectsToClipboardData (fires classInfo hooks, falls back
 *  to the free objectsToClipboardData). The paste engine branches on which
 *  field is present, so this single-vs-multi split keeps the data pasteable. */
function serializeObjects(store, objects) {
    return objects.length === 1
        ? (0, store_1.objectToClipboardData)(store, objects[0])
        : store.objectsToClipboardData(objects);
}
/** Resolve the reference object a paste is resolved against, from an `into`
 *  target ({objID?} or {page?}). EEZ walks up from this reference to find the
 *  nearest container that can hold the pasted class, so passing a page's screen
 *  widget (or the page itself) lets findPastePlaceInside locate its children
 *  array. Returns undefined when neither is given. */
function resolveInto(store, into) {
    if (!into) {
        return undefined;
    }
    if (into.objID) {
        return (0, project_access_1.resolveObject)(store, into.objID);
    }
    if (into.page) {
        const page = (0, project_access_1.resolvePage)(store, into.page);
        return page.lvglScreenWidget ?? page;
    }
    return undefined;
}
/** Require and validate a non-empty objIDs array from params. */
function requireObjIDs(params) {
    const objIDs = params.objIDs;
    if (!Array.isArray(objIDs) || objIDs.length === 0) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "objIDs[] is required.");
    }
    return objIDs;
}
// --- Handlers --------------------------------------------------------------
exports.clipboardHandlers = {
    // Serialize the given objects with EEZ's own serializer and write them to the
    // OS (Electron) clipboard. Read-only w.r.t. the project — no undo entry.
    copy_objects(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const objIDs = requireObjIDs(params);
        const objects = objIDs.map(id => (0, project_access_1.resolveObject)(store, id));
        const text = serializeObjects(store, objects);
        (0, store_1.copyProjectEditorDataToClipboard)(text);
        return {
            copied: objects.length,
            // objectClassName is the FIRST object's class on multi-copy, matching
            // clipboard.ts objectsToClipboardData.
            objectClassName: (0, object_1.getClass)(objects[0]).name
        };
    },
    // Copy + delete in ONE undo step. Serialize BEFORE deleting (deletion detaches
    // objects from the tree), then delete via store.deleteObjects (single undo
    // command, NO confirmation dialog — unlike the GUI deleteItems helper, which
    // can pop a modal for referenced objects and would hang a headless bridge
    // call), and finally write the clipboard outside the undo txn.
    cut_objects(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const objIDs = requireObjIDs(params);
        const objects = objIDs.map(id => (0, project_access_1.resolveObject)(store, id));
        // Serialize first — must happen while objects are still attached.
        const text = serializeObjects(store, objects);
        // Single delete command == one undo entry (do NOT setCombineCommands).
        store.deleteObjects(objects);
        (0, store_1.copyProjectEditorDataToClipboard)(text);
        return { cut: objects.length, undoLabel: "Deleted" };
    },
    // Paste whatever is on the OS clipboard relative to the `into` reference.
    // EEZ's pasteItem engine mints FRESH objIDs (createObject(..., true)) and
    // resolves the actual container by walking up from the reference. A normal
    // paste is one addObject/addObjects/insertObject == one undo entry, so no
    // setCombineCommands is needed. pasteItem swallows errors and returns
    // undefined on failure, so we pre-flight with checkClipboard for an explicit
    // error and treat an undefined result as a failure.
    paste_objects(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const reference = resolveInto(store, params.into);
        if (!reference) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "into.objID or into.page is required.");
        }
        // Pre-flight: is there pasteable data AND a valid place under `reference`?
        const check = (0, store_1.checkClipboard)(store, reference);
        if (!check) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Clipboard has no data that can be pasted into the target.");
        }
        const newObj = (0, store_1.pasteItem)(reference);
        if (!newObj) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Nothing was pasted.");
        }
        // Fire class-specific onAfterPaste hooks (matches the GUI paste path).
        (0, util_1.onAfterPaste)(newObj, reference);
        const objIDs = Array.isArray(newObj)
            ? newObj.map((o) => o.objID)
            : [newObj.objID];
        return { objIDs, undoLabel: "Added" };
    },
    // Inspect the OS clipboard: what EEZ data (if any) it holds, and whether it
    // can be pasted into an optional `into` target. Pure read — parsing the
    // clipboard mints objIDs internally but never attaches them to the tree, so
    // nothing is mutated and no undo entry is created.
    get_clipboard_info(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const sd = (0, store_1.getProjectEditorDataFromClipboard)(store);
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
                canPasteFlag = (0, store_1.canPaste)(store, target) != undefined;
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
