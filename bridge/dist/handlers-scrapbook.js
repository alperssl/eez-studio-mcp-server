"use strict";
// Scrapbook handlers — the scrapbook is a GLOBAL app-level singleton backed by
// SQLite (project-editor/store/scrapbook.tsx:766), NOT part of any ProjectStore
// and NOT on the project undo stack. See research/source-v4/scrapbook.md.
//
// Domain rules baked in here:
//   * list_scrapbook_items is a clean read of model.store.project.items, optionally
//     switching the loaded file first via model.openScrapbookFile (async SQLite load,
//     no dialog).
//   * insert_scrapbook_item goes through model.insertItemIntoProject, which is
//     async/fire-and-forget and ALREADY produces ONE combined undo step on the ACTIVE
//     project (doPaste → setCombineCommands). We must NOT wrap it in our own combine.
//     Completion is observed via an objID set-diff on project._objectsMap with a
//     bounded timeout. A name conflict can surface a resolve-conflicts modal for which
//     there is no headless resolver — we bound-wait and soft-return rather than hang.
//   * save_selection_to_scrapbook rides the OS-clipboard + pasteModel reactive rebuild
//     + pasteIntoNewItem dependency scan. Its inserts use the scrapbook's OWN
//     ScrapbookUndoManager, never the project undo stack. Every async hop is guarded by
//     a bounded wait so the bridge can never block on UI.
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapbookHandlers = void 0;
const tslib_1 = require("tslib");
const fs_1 = tslib_1.__importDefault(require("fs"));
const mobx_1 = require("mobx");
const clipboard_1 = require("project-editor/store/clipboard");
const scrapbook_1 = require("project-editor/store/scrapbook");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// Bounded-wait budget for the async, potentially UI-adjacent mutating flows.
const WAIT_TIMEOUT_MS = 4000;
/** Snapshot of every live objID in the destination project (project.tsx:_objectsMap). */
function snapshotObjIDs(store) {
    return new Set(store.project._objectsMap.keys());
}
/** Resolve after `predicate()` is truthy, or after `timeoutMs` — never rejects. */
function whenOrTimeout(predicate, timeoutMs) {
    if (predicate()) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        (0, mobx_1.when)(predicate).then(() => finish(true), () => finish(false));
    });
}
exports.scrapbookHandlers = {
    // --- Read: list items in the loaded (or requested) scrapbook file ---------
    // Pure read against the in-memory ScrapbookStore. If `file` is given and differs
    // from the loaded one, switch the globally-active scrapbook file first (this is a
    // SQLite load, not a dialog). Returns the currently loaded file, the known files,
    // and the items.
    async list_scrapbook_items(params) {
        if (params.file) {
            if (typeof params.file !== "string") {
                throw new protocol_1.BridgeError("BAD_PARAMS", "file must be an absolute path string.");
            }
            if (!fs_1.default.existsSync(params.file)) {
                throw new protocol_1.BridgeError("NOT_FOUND", `Scrapbook file not found: ${params.file}`);
            }
            if (params.file !== scrapbook_1.model.selectedFile) {
                await scrapbook_1.model.openScrapbookFile(params.file);
            }
        }
        return {
            file: scrapbook_1.model.selectedFile,
            files: (scrapbook_1.model.files || []).slice(),
            items: (scrapbook_1.model.store.project.items || []).map((it) => ({
                id: it.id,
                name: it.name,
                description: it.description ?? ""
            }))
        };
    },
    // --- Mutation: insert a scrapbook item into the active project ------------
    // Inserts item.eezProject (fragment + dependencies) into the active project via
    // model.insertItemIntoProject. That call is async/fire-and-forget and ALREADY wraps
    // its paste in ONE combined undo step on the active project's undo manager — we do
    // NOT add our own setCombineCommands. Newly created objIDs are captured by diffing
    // project._objectsMap before/after, waiting up to WAIT_TIMEOUT_MS for the paste to
    // land. A destination name-clash can pop a resolve-conflicts modal with no headless
    // resolver; on timeout we return a soft result rather than hang.
    async insert_scrapbook_item(params) {
        if (!params.itemId) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "itemId is required.");
        }
        const dest = (0, project_access_1.requireProjectStore)(); // === model.destinationProjectStore
        const item = (scrapbook_1.model.store.project.items || []).find((i) => i.id === params.itemId);
        if (!item) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No scrapbook item "${params.itemId}".`);
        }
        const before = snapshotObjIDs(dest);
        // Fire the insert. Async; may (rarely) show the resolve-conflicts modal when
        // fragment asset names collide with the destination project — no headless
        // resolver exists, so we only bound-wait for growth.
        scrapbook_1.model.insertItemIntoProject(item, dest);
        const grew = await whenOrTimeout(() => snapshotObjIDs(dest).size > before.size, WAIT_TIMEOUT_MS);
        const after = snapshotObjIDs(dest);
        const insertedObjIDs = [...after].filter(id => !before.has(id));
        if (!grew && insertedObjIDs.length === 0) {
            return {
                insertedObjIDs: [],
                note: "insert issued but no new objects observed within timeout; a " +
                    "name conflict may require the Scrapbook panel to resolve."
            };
        }
        return { insertedObjIDs };
    },
    // --- Mutation: save current selection as a new scrapbook item -------------
    // Rides the OS-clipboard + pasteModel reactive rebuild + pasteIntoNewItem
    // dependency scan (there is no direct "serialize selection → item" API). The
    // scrapbook insert uses ScrapbookUndoManager, NOT the project undo stack — so this
    // is never wrapped in store.undoManager. Every async hop is bounded; on any hop
    // timing out we surface a clear UNSUPPORTED-style error pointing at the panel
    // rather than hanging. Name/description (if given) are applied post-create via
    // store.setItemName / store.setItemDescription (the create path always makes
    // "Item N" with an empty description).
    async save_selection_to_scrapbook(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const selected = (store.navigationStore?.selectedPanel?.selectedObjects || []).filter((o) => o && o.objID);
        if (selected.length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Nothing is selected to save to scrapbook.");
        }
        // 1. Put the selection onto the EEZ clipboard (the scrapbook reads from it).
        //    NOTE: this clobbers the user's current EEZ clipboard contents.
        const text = store.objectsToClipboardData(selected);
        (0, clipboard_1.copyProjectEditorDataToClipboard)(text);
        // 2. Wait for pasteModel to (re)build sourceProjectStore from the clipboard.
        const haveSource = await whenOrTimeout(() => clipboard_1.pasteModel.sourceProjectStore != undefined, WAIT_TIMEOUT_MS);
        if (!haveSource || !clipboard_1.pasteModel.sourceProjectStore) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Clipboard round-trip for the scrapbook did not complete " +
                "headlessly; use the Scrapbook panel to save the selection.");
        }
        // 3. Snapshot existing item ids to identify the new one.
        const beforeIds = new Set((scrapbook_1.model.store.project.items || []).map((i) => i.id));
        // 4. Kick the async scrapbook "paste into new item" flow. Destination is a
        //    fresh EMPTY project store, so no resolve-conflicts modal is expected.
        scrapbook_1.model.pasteIntoNewItem(clipboard_1.pasteModel.sourceProjectStore);
        // 5. Wait for the new item to be inserted.
        const inserted = await whenOrTimeout(() => (scrapbook_1.model.store.project.items || []).some((i) => !beforeIds.has(i.id)), WAIT_TIMEOUT_MS);
        if (!inserted) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Saving the selection to the scrapbook did not complete " +
                "headlessly (dependency-resolution flow is UI-driven); " +
                "use the Scrapbook panel.");
        }
        const item = (scrapbook_1.model.store.project.items || []).find((i) => !beforeIds.has(i.id));
        // 6. Apply optional name/description overrides (scrapbook-undo tracked; also
        //    UPDATE the SQLite row). The create path defaults to "Item N" + "".
        if (item && typeof params.name === "string" && params.name) {
            scrapbook_1.model.store.setItemName(item, params.name);
        }
        if (item &&
            typeof params.description === "string" &&
            params.description) {
            scrapbook_1.model.store.setItemDescription(item, params.description);
        }
        return { itemId: item ? item.id : null };
    }
};
