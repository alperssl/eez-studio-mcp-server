"use strict";
// Full-project SEARCH + REFERENCE-GRAPH handlers, mapped onto EEZ's real
// core/search.ts generators driven HEADLESSLY (withPause=false, no Search UI
// panel / CurrentSearch / outputSectionsStore). See research/source-v4/search-refs.md.
//
// Correctness points that drive this module:
//   1. The search generators yield transient EezValueObject wrappers, NOT model
//      objects. A value-object's own objID is ephemeral (getChildId counter) and is
//      NOT in _objectsMap. The stable identity of a hit is its PARENT: return
//      getParent(vo).objID, path via getObjectPathAsString(parent), label via
//      objectToString(vo), propertyName via vo.propertyInfo.name.
//   2. search_project / find_references / is_referenced / resolve_path are pure
//      READS — no undo. Only replace_in_project mutates, and it wraps every write
//      in ONE setCombineCommands(true)…finally(false) group (one undo step).
//   3. Run the generators synchronously by iterating them in a for-of loop — exactly
//      what EEZ's own isReferenced/replaceObjectReference do internally.
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const search_1 = require("project-editor/core/search");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// Bridge-side cap so a broad pattern can't stream an unbounded result set back.
const DEFAULT_SEARCH_LIMIT = 500;
/**
 * Map a search-hit EezValueObject to a stable result row. The value object is a
 * synthetic wrapper — its parent is the real tree node that carries the stable
 * objID/path (report §1). `objID` may be undefined for array/computed owners;
 * `path` is always present and is the primary key.
 */
function resultRow(valueObject) {
    const owner = (0, object_1.getParent)(valueObject);
    return {
        objID: owner ? owner.objID : undefined,
        path: owner ? (0, store_1.getObjectPathAsString)(owner) : undefined,
        label: (0, store_1.objectToString)(valueObject),
        propertyName: valueObject.propertyInfo
            ? valueObject.propertyInfo.name
            : undefined,
        match: valueObject.value != undefined ? valueObject.value.toString() : ""
    };
}
/**
 * Splice every occurrence of `pattern` in `str` with `replacement`.
 * findAllOccurrences lowercases `str` internally when !matchCase but does NOT
 * lowercase `pattern`, so we lowercase the pattern here for a case-insensitive
 * match. Lowercasing preserves length, so the returned start/end indices are
 * valid against the ORIGINAL `str` — splice against the original (report §4).
 */
function replaceAllOccurrences(str, pattern, replacement, matchCase, matchWholeWord) {
    const searchPattern = matchCase ? pattern : pattern.toLowerCase();
    const occ = (0, search_1.findAllOccurrences)(str, searchPattern, matchCase, matchWholeWord);
    if (occ.length === 0) {
        return str;
    }
    let out = "";
    let prev = 0;
    for (const { start, end } of occ) {
        out += str.substring(prev, start) + replacement;
        prev = end;
    }
    return out + str.substring(prev);
}
/** Resolve the { objID?, path? } target of a reference query to a real object. */
function resolveTarget(store, params) {
    return (0, project_access_1.resolveObjectOrPath)(store, {
        objID: params.objID,
        path: params.path
    });
}
exports.searchHandlers = {
    // --- Full-project pattern search (READ — no undo) -----------------------
    search_project(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.pattern) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "pattern is required.");
        }
        const limit = typeof params.limit === "number" && params.limit > 0
            ? params.limit
            : DEFAULT_SEARCH_LIMIT;
        const searchParams = {
            type: "pattern",
            pattern: params.pattern,
            matchCase: !!params.matchCase,
            matchWholeWord: !!params.matchWholeWord,
            replace: undefined // find-only; widest match set (search.ts:224)
        };
        const results = [];
        let truncated = false;
        // withPause=false => synchronous generator, never yields the null sentinel.
        for (const valueObject of (0, search_1.searchForPattern)(store.project, searchParams, false)) {
            if (!valueObject) {
                continue;
            }
            if (results.length >= limit) {
                truncated = true;
                break;
            }
            results.push(resultRow(valueObject));
        }
        return { results, count: results.length, truncated };
    },
    // --- Inbound references to an object (READ — no undo) -------------------
    find_references(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const target = resolveTarget(store, params);
        const root = (0, object_1.getRootObject)(target);
        const references = [];
        for (const valueObject of (0, search_1.searchForReference)(root, { type: "object", object: target }, false)) {
            if (!valueObject) {
                continue;
            }
            const owner = (0, object_1.getParent)(valueObject);
            references.push({
                objID: owner ? owner.objID : undefined,
                path: owner ? (0, store_1.getObjectPathAsString)(owner) : undefined,
                label: (0, store_1.objectToString)(valueObject),
                propertyName: valueObject.propertyInfo
                    ? valueObject.propertyInfo.name
                    : undefined
            });
        }
        return { references, count: references.length };
    },
    // --- Fast boolean reference check (READ — no undo) ---------------------
    is_referenced(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const target = resolveTarget(store, params);
        // EEZ's own short-circuiting synchronous check (search.ts:923).
        return { referenced: (0, search_1.isReferenced)(target) };
    },
    // --- Project-wide find & replace (MUTATES — ONE undo step) -------------
    replace_in_project(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.pattern) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "pattern is required.");
        }
        if (params.replacement == undefined) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "replacement is required.");
        }
        const matchCase = !!params.matchCase;
        const matchWholeWord = !!params.matchWholeWord;
        // Optional scope: `target` narrows the search root to a resolved subtree
        // (objID or path). Omitted => whole project.
        let root = store.project;
        if (params.target) {
            if (typeof params.target === "string") {
                const scoped = (0, store_1.getObjectFromStringPath)(store.project, params.target);
                if (!scoped) {
                    throw new protocol_1.BridgeError("NOT_FOUND", `No object at target path "${params.target}".`);
                }
                root = scoped;
            }
            else if (params.target.objID || params.target.path) {
                root = (0, project_access_1.resolveObjectOrPath)(store, params.target);
            }
        }
        const searchParams = {
            type: "pattern",
            pattern: params.pattern,
            matchCase,
            matchWholeWord,
            replace: params.replacement // enables canReplace() writable-only filter
        };
        // Collect first — never mutate mid-iteration; the visitor reads the live
        // tree and rewriting property strings mid-walk risks re-match/skip (§4).
        const hits = [];
        for (const valueObject of (0, search_1.searchForPattern)(root, searchParams, false)) {
            if (valueObject) {
                hits.push(valueObject);
            }
        }
        let replacedCount = 0;
        const undoLabel = `Replace "${params.pattern}" → "${params.replacement}"`;
        store.undoManager.setCombineCommands(true);
        try {
            for (const valueObject of hits) {
                const owner = (0, object_1.getParent)(valueObject);
                const key = valueObject.propertyInfo
                    ? valueObject.propertyInfo.name
                    : undefined;
                if (!owner || !key) {
                    continue;
                }
                const oldValue = valueObject.value;
                if (typeof oldValue !== "string") {
                    continue; // string props only in this impl (§4 gotcha 2)
                }
                const newValue = replaceAllOccurrences(oldValue, params.pattern, params.replacement, matchCase, matchWholeWord);
                if (newValue !== oldValue) {
                    store.updateObject(owner, { [key]: newValue });
                    replacedCount++;
                }
            }
        }
        finally {
            store.undoManager.setCombineCommands(false); // ALWAYS restore
        }
        return { replacedCount, undoLabel };
    },
    // --- Path <-> objID round-trip + class/label (READ — no undo) ----------
    resolve_path(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const obj = resolveTarget(store, params);
        return {
            objID: obj.objID, // may be undefined for array/value hosts (§6)
            path: (0, store_1.getObjectPathAsString)(obj),
            class: (0, store_1.getClass)(obj).name, // JS ctor name = registered class name
            label: (0, store_1.getLabel)(obj)
        };
    }
};
