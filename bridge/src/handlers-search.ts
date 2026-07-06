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

import {
    getObjectFromStringPath,
    getObjectPathAsString,
    objectToString,
    getLabel,
    getClass
} from "project-editor/store";
import { getParent, getRootObject } from "project-editor/core/object";
import {
    searchForPattern,
    searchForReference,
    isReferenced,
    findAllOccurrences
} from "project-editor/core/search";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveObjectOrPath,
    ProjectStoreLike
} from "mcp-bridge/project-access";

// Bridge-side cap so a broad pattern can't stream an unbounded result set back.
const DEFAULT_SEARCH_LIMIT = 500;

/**
 * Map a search-hit EezValueObject to a stable result row. The value object is a
 * synthetic wrapper — its parent is the real tree node that carries the stable
 * objID/path (report §1). `objID` may be undefined for array/computed owners;
 * `path` is always present and is the primary key.
 */
function resultRow(valueObject: any): any {
    const owner: any = getParent(valueObject);
    return {
        objID: owner ? owner.objID : undefined,
        path: owner ? getObjectPathAsString(owner) : undefined,
        label: objectToString(valueObject),
        propertyName: valueObject.propertyInfo
            ? valueObject.propertyInfo.name
            : undefined,
        match:
            valueObject.value != undefined ? valueObject.value.toString() : ""
    };
}

/**
 * Splice every occurrence of `pattern` in `str` with `replacement`.
 * findAllOccurrences lowercases `str` internally when !matchCase but does NOT
 * lowercase `pattern`, so we lowercase the pattern here for a case-insensitive
 * match. Lowercasing preserves length, so the returned start/end indices are
 * valid against the ORIGINAL `str` — splice against the original (report §4).
 */
function replaceAllOccurrences(
    str: string,
    pattern: string,
    replacement: string,
    matchCase: boolean,
    matchWholeWord: boolean
): string {
    const searchPattern = matchCase ? pattern : pattern.toLowerCase();
    const occ = findAllOccurrences(
        str,
        searchPattern,
        matchCase,
        matchWholeWord
    );
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
function resolveTarget(
    store: ProjectStoreLike,
    params: any
): any {
    return resolveObjectOrPath(store, {
        objID: params.objID,
        path: params.path
    });
}

/**
 * Stable "location" key for a search hit: owner path + property name. A location is
 * uniformly replaceable-or-not, so this keys the replace-scope comparison used to flag
 * matches that replace_in_project cannot write (report §"scope asymmetry").
 */
function locKey(valueObject: any): string {
    const owner: any = getParent(valueObject);
    const path = owner ? getObjectPathAsString(owner) : "?";
    const prop = valueObject.propertyInfo ? valueObject.propertyInfo.name : "?";
    return path + "::" + prop;
}

export const searchHandlers: Record<string, Handler> = {
    // --- Full-project pattern search (READ — no undo) -----------------------

    search_project(params: any) {
        const store = requireProjectStore();
        if (!params.pattern) {
            throw new BridgeError("BAD_PARAMS", "pattern is required.");
        }
        const limit =
            typeof params.limit === "number" && params.limit > 0
                ? params.limit
                : DEFAULT_SEARCH_LIMIT;

        const searchParams = {
            type: "pattern" as const,
            pattern: params.pattern,
            matchCase: !!params.matchCase,
            matchWholeWord: !!params.matchWholeWord,
            replace: undefined // find-only; widest match set (search.ts:224)
        };

        const results: any[] = [];
        let truncated = false;
        // withPause=false => synchronous generator, never yields the null sentinel.
        for (const valueObject of searchForPattern(
            store.project,
            searchParams,
            false
        )) {
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

    find_references(params: any) {
        const store = requireProjectStore();
        const target = resolveTarget(store, params);
        const root = getRootObject(target);

        const references: any[] = [];
        for (const valueObject of searchForReference(
            root,
            { type: "object", object: target },
            false
        )) {
            if (!valueObject) {
                continue;
            }
            const owner: any = getParent(valueObject);
            references.push({
                objID: owner ? owner.objID : undefined,
                path: owner ? getObjectPathAsString(owner) : undefined,
                label: objectToString(valueObject),
                propertyName: valueObject.propertyInfo
                    ? valueObject.propertyInfo.name
                    : undefined
            });
        }
        return { references, count: references.length };
    },

    // --- Fast boolean reference check (READ — no undo) ---------------------

    is_referenced(params: any) {
        const store = requireProjectStore();
        const target = resolveTarget(store, params);
        // EEZ's own short-circuiting synchronous check (search.ts:923).
        return { referenced: isReferenced(target) };
    },

    // --- Project-wide find & replace (MUTATES — ONE undo step) -------------

    replace_in_project(params: any) {
        const store = requireProjectStore();
        if (!params.pattern) {
            throw new BridgeError("BAD_PARAMS", "pattern is required.");
        }
        if (params.replacement == undefined) {
            throw new BridgeError("BAD_PARAMS", "replacement is required.");
        }

        const matchCase = !!params.matchCase;
        const matchWholeWord = !!params.matchWholeWord;

        // Optional scope: `target` narrows the search root to a resolved subtree
        // (objID or path). Omitted => whole project.
        let root: any = store.project;
        if (params.target) {
            if (typeof params.target === "string") {
                const scoped = getObjectFromStringPath(
                    store.project,
                    params.target
                );
                if (!scoped) {
                    throw new BridgeError(
                        "NOT_FOUND",
                        `No object at target path "${params.target}".`
                    );
                }
                root = scoped;
            } else if (params.target.objID || params.target.path) {
                root = resolveObjectOrPath(store, params.target);
            }
        }

        const searchParams = {
            type: "pattern" as const,
            pattern: params.pattern,
            matchCase,
            matchWholeWord,
            replace: params.replacement // enables canReplace() writable-only filter
        };

        // Collect first — never mutate mid-iteration; the visitor reads the live
        // tree and rewriting property strings mid-walk risks re-match/skip (§4).
        const hits: any[] = [];
        for (const valueObject of searchForPattern(root, searchParams, false)) {
            if (valueObject) {
                hits.push(valueObject);
            }
        }
        // Locations replace CAN write (EEZ's canReplace writable-only filter is active
        // because searchParams.replace is set). Compared below against the widest match.
        const replaceableLocs = new Set<string>(hits.map(locKey));

        let replacedCount = 0;
        const undoLabel = `Replace "${params.pattern}" → "${params.replacement}"`;
        store.undoManager.setCombineCommands(true);
        try {
            for (const valueObject of hits) {
                const owner: any = getParent(valueObject);
                const key: string | undefined = valueObject.propertyInfo
                    ? valueObject.propertyInfo.name
                    : undefined;
                if (!owner || !key) {
                    continue;
                }
                const oldValue = valueObject.value;
                if (typeof oldValue !== "string") {
                    continue; // string props only in this impl (§4 gotcha 2)
                }
                const newValue = replaceAllOccurrences(
                    oldValue,
                    params.pattern,
                    params.replacement,
                    matchCase,
                    matchWholeWord
                );
                if (newValue !== oldValue) {
                    store.updateObject(owner, { [key]: newValue });
                    replacedCount++;
                }
            }
        } finally {
            store.undoManager.setCombineCommands(false); // ALWAYS restore
        }

        // Scope signal: some string properties match textually (search_project finds
        // them) but are NOT writable via EEZ's search-replace — e.g. build-file code
        // templates. Run the widest find-only pass and report matched locations replace
        // cannot touch, so the asymmetry with search_project is not silent.
        const searchOnlyParams = { ...searchParams, replace: undefined };
        const skippedByLoc = new Map<string, any>();
        const SKIP_CAP = 200;
        for (const valueObject of searchForPattern(
            root,
            searchOnlyParams,
            false
        )) {
            if (!valueObject) {
                continue;
            }
            const key = locKey(valueObject);
            if (replaceableLocs.has(key) || skippedByLoc.has(key)) {
                continue;
            }
            if (skippedByLoc.size >= SKIP_CAP) {
                break;
            }
            const owner: any = getParent(valueObject);
            skippedByLoc.set(key, {
                objID: owner ? owner.objID : undefined,
                path: owner ? getObjectPathAsString(owner) : undefined,
                propertyName: valueObject.propertyInfo
                    ? valueObject.propertyInfo.name
                    : undefined,
                label: objectToString(valueObject)
            });
        }
        const skipped = Array.from(skippedByLoc.values());

        const result: any = { replacedCount, undoLabel };
        if (skipped.length > 0) {
            result.skipped = skipped;
            result.skippedCount = skipped.length;
            const buildTemplate = skipped.some(
                (s: any) =>
                    s.path &&
                    /\/settings\/build\/files\//.test(s.path) &&
                    s.propertyName === "template"
            );
            result.note =
                "Some matches are in properties replace_in_project cannot write " +
                "(EEZ's search-replace covers identifiers/references, not free text)." +
                (buildTemplate
                    ? " For build-file code templates use set_build_file_template or patch_build_file_template."
                    : "");
        }
        return result;
    },

    // --- Path <-> objID round-trip + class/label (READ — no undo) ----------

    resolve_path(params: any) {
        const store = requireProjectStore();
        const obj = resolveTarget(store, params);
        return {
            objID: obj.objID, // may be undefined for array/value hosts (§6)
            path: getObjectPathAsString(obj),
            class: getClass(obj).name, // JS ctor name = registered class name
            label: getLabel(obj)
        };
    }
};
