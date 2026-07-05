"use strict";
// i18n / TEXTS (localization) bridge handlers. Every mutation goes through the live
// ProjectStore command/undo API (addObject/updateObject/deleteObject), mirroring
// handlers-assets.ts, so the GUI, undo/redo, validation and codegen stay consistent.
//
// The "Texts" project feature is OPTIONAL: project.texts is undefined until enabled.
// requireTexts() guards every handler and throws UNSUPPORTED when it is off.
//
// Cell (Translation) objects are module-private in EEZ and NOT registerClass'd, so we
// never createObject(..., Translation). Instead:
//   - add_language relies on Texts.languages.interceptAddObject to fan an empty cell
//     into every resource,
//   - add_text_resource / import_texts seed translations:[{languageID,text}] as plain
//     JS inside the TextResource seed (createObject recurses the Array property).
Object.defineProperty(exports, "__esModule", { value: true });
exports.i18nHandlers = void 0;
const store_1 = require("project-editor/store");
const texts_1 = require("project-editor/features/texts");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Local feature-gated accessors (project.texts is optional; do NOT edit project-access.ts) ---
/** Throw a clean UNSUPPORTED error if the Texts feature is not enabled. */
function requireTexts(store) {
    const texts = store.project.texts;
    if (!texts) {
        throw new protocol_1.BridgeError("UNSUPPORTED", "Texts feature is not enabled; call enable_feature{key:'texts'} first.");
    }
    return texts;
}
/** CSV-escape a cell value (quote if it contains comma, quote, CR or LF). */
function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}
/** Parse a CSV string into rows of string cells (RFC-4180-ish, handles quotes/CRLF). */
function parseCsv(data) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = data.length;
    while (i < n) {
        const ch = data[i];
        if (inQuotes) {
            if (ch === '"') {
                if (data[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === ",") {
            row.push(field);
            field = "";
            i++;
            continue;
        }
        if (ch === "\r") {
            i++;
            continue;
        }
        if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            i++;
            continue;
        }
        field += ch;
        i++;
    }
    // flush trailing field/row (unless the file ended on a bare newline)
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
/** Parse import payload (csv/json/xliff) into a normalized {languages, rows} table. */
async function parseImport(format, data) {
    const fmt = String(format || "").toLowerCase();
    if (fmt === "json") {
        const obj = typeof data === "string" ? JSON.parse(data) : data;
        const languages = Array.isArray(obj.languages)
            ? obj.languages.map((l) => String(l))
            : [];
        const rawRows = Array.isArray(obj.resources)
            ? obj.resources
            : Array.isArray(obj.rows)
                ? obj.rows
                : [];
        const rows = rawRows.map((r) => {
            const resourceID = String(r.resourceID);
            const cells = {};
            for (const key of Object.keys(r)) {
                if (key === "resourceID")
                    continue;
                cells[key] = r[key] == null ? "" : String(r[key]);
            }
            return { resourceID, cells };
        });
        return { languages, rows };
    }
    if (fmt === "csv") {
        const text = typeof data === "string" ? data : String(data);
        const grid = parseCsv(text);
        if (grid.length === 0) {
            return { languages: [], rows: [] };
        }
        const header = grid[0];
        const languages = header.slice(1); // first column is resourceID
        const rows = grid.slice(1).map(cols => {
            const resourceID = cols[0] ?? "";
            const cells = {};
            languages.forEach((lang, idx) => {
                cells[lang] = cols[idx + 1] ?? "";
            });
            return { resourceID, cells };
        });
        return { languages, rows };
    }
    if (fmt === "xliff") {
        const xliff = require("xliff");
        const text = typeof data === "string" ? data : String(data);
        let js;
        try {
            js = await xliff.xliff2js(text);
        }
        catch (e) {
            js = await xliff.xliff12ToJs(text);
        }
        // xliff2js shape: { sourceLanguage, targetLanguage, resources: { <ns>: { <id>: {source,target} } } }
        const target = js.targetLanguage || js.trgLang || "";
        const source = js.sourceLanguage || js.srcLang || "";
        const languages = [];
        if (source)
            languages.push(source);
        if (target && target !== source)
            languages.push(target);
        const rows = [];
        const namespaces = js.resources || {};
        for (const ns of Object.keys(namespaces)) {
            const units = namespaces[ns] || {};
            for (const id of Object.keys(units)) {
                const unit = units[id] || {};
                const cells = {};
                if (source && unit.source != null) {
                    cells[source] = String(unit.source);
                }
                if (target && unit.target != null) {
                    cells[target] = String(unit.target);
                }
                rows.push({ resourceID: id, cells });
            }
        }
        return { languages, rows };
    }
    throw new protocol_1.BridgeError("BAD_PARAMS", `Unsupported import format "${format}". Use csv, json or xliff.`);
}
exports.i18nHandlers = {
    // NOTE: enabling the Texts feature is handled by the general `enable_feature`
    // tool in handlers-settings.ts (call it with key:"texts" first). requireTexts()
    // below guards every i18n tool until that feature exists.
    // Read-only: list languages with per-language translated-cell coverage.
    list_languages() {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const total = texts.resources.length;
        return {
            languages: texts.languages.map((l) => ({
                languageID: l.languageID,
                translated: l.translated,
                total
            }))
        };
    },
    // Add a language. Texts.languages.interceptAddObject auto-fans an empty translation
    // cell into every existing resource (one undo step).
    add_language(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (!params.languageID) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "languageID is required.");
        }
        if (texts.languages.some((l) => l.languageID === params.languageID)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `A language "${params.languageID}" already exists.`);
        }
        const language = (0, store_1.createObject)(store, { languageID: params.languageID }, texts_1.Language);
        store.addObject(texts.languages, language);
        return { languageID: language.languageID };
    },
    // Read-only: list text resources (optionally filtered to one languageID column).
    list_text_resources(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const totalLangs = texts.languages.length;
        return {
            resources: texts.resources.map((r) => {
                const cells = (r.translations || []).filter((t) => !params.languageID ||
                    t.languageID === params.languageID);
                return {
                    resourceID: r.resourceID,
                    translations: cells.map((t) => ({
                        languageID: t.languageID,
                        text: t.text
                    })),
                    translated: r.translated,
                    total: totalLangs
                };
            })
        };
    },
    // Add a text resource. No interceptAddObject on resources, so we seed one
    // {languageID, text:""} per current language ourselves (mirrors TextResource.newItem).
    add_text_resource(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (!params.resourceID) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "resourceID is required.");
        }
        if (texts.resources.some((r) => r.resourceID === params.resourceID)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `A text resource "${params.resourceID}" already exists.`);
        }
        const translations = texts.languages.map((l) => ({
            languageID: l.languageID,
            text: ""
        }));
        const resource = (0, store_1.createObject)(store, { resourceID: params.resourceID, translations }, texts_1.TextResource);
        store.addObject(texts.resources, resource);
        return { resourceID: resource.resourceID };
    },
    // The core authoring op: set one (resource,language) cell's text.
    set_translation(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (params.text === undefined) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "text is required.");
        }
        const resource = texts.resources.find((r) => r.resourceID === params.resourceID);
        if (!resource) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No text resource "${params.resourceID}".`);
        }
        const cell = (resource.translations || []).find((t) => t.languageID === params.languageID);
        if (!cell) {
            throw new protocol_1.BridgeError("NOT_FOUND", `Language "${params.languageID}" has no cell in resource "${params.resourceID}". Add the language first.`);
        }
        store.updateObject(cell, { text: params.text });
        return {
            resourceID: params.resourceID,
            languageID: params.languageID,
            text: params.text
        };
    },
    // Bind a widget's text to a translated resource: textType=translated-literal, text=resourceID.
    set_widget_text_resource(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        if (widget.textType === undefined || widget.text === undefined) {
            throw new protocol_1.BridgeError("UNSUPPORTED", `Widget ${widget.type} has no text property to bind.`);
        }
        const resource = texts.resources.find((r) => r.resourceID === params.resourceID);
        if (!resource) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No text resource "${params.resourceID}".`);
        }
        store.updateObject(widget, {
            textType: "translated-literal",
            text: params.resourceID
        });
        return {
            objID: widget.objID,
            text: widget.text,
            textType: widget.textType
        };
    },
    // Delete a language. Language.deleteObjectRefHook cascades removal of every matching
    // translation cell (one undo step).
    delete_language(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const language = texts.languages.find((l) => l.languageID === params.languageID);
        if (!language) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No language "${params.languageID}".`);
        }
        store.deleteObject(language);
        return { ok: true };
    },
    // Rename a language. Language.updateObjectValueHook rewrites languageID in every cell.
    rename_language(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (!params.newLanguageID) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "newLanguageID is required.");
        }
        const language = texts.languages.find((l) => l.languageID === params.languageID);
        if (!language) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No language "${params.languageID}".`);
        }
        if (texts.languages.some((l) => l.languageID === params.newLanguageID)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `A language "${params.newLanguageID}" already exists.`);
        }
        store.updateObject(language, { languageID: params.newLanguageID });
        return { languageID: params.newLanguageID };
    },
    // Rename a text resource (PARTIAL): renames the key, then scans _objectsMap for
    // translated-literal widgets bound to the old ID and rewrites their text msgid.
    // EEZ keeps no reverse index for the plain-string binding, so this scan is the only
    // reliable route. Whole thing is one combined undo step.
    rename_text_resource(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (!params.newResourceID) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "newResourceID is required.");
        }
        const resource = texts.resources.find((r) => r.resourceID === params.resourceID);
        if (!resource) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No text resource "${params.resourceID}".`);
        }
        if (texts.resources.some((r) => r.resourceID === params.newResourceID)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `A text resource "${params.newResourceID}" already exists.`);
        }
        store.undoManager.setCombineCommands(true);
        try {
            store.updateObject(resource, {
                resourceID: params.newResourceID
            });
            for (const obj of store.project._objectsMap.values()) {
                const w = obj;
                if (w &&
                    w.textType === "translated-literal" &&
                    w.text === params.resourceID) {
                    store.updateObject(w, { text: params.newResourceID });
                }
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { resourceID: params.newResourceID };
    },
    // Delete a text resource; it cascades its own translation cells. Widget bindings to
    // this resourceID dangle (matches EEZ's own delete behavior).
    delete_text_resource(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const resource = texts.resources.find((r) => r.resourceID === params.resourceID);
        if (!resource) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No text resource "${params.resourceID}".`);
        }
        store.deleteObject(resource);
        return { ok: true };
    },
    // Bulk import csv/json/xliff. Order: add languages first (fan-out gives new resources
    // their columns), then resources (seeded against the full language list), then set
    // cells. All in one combined undo step. mode "merge" (default) only touches provided
    // cells; "replace" additionally blanks unprovided cells for imported resources.
    async import_texts(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        if (params.data === undefined || params.data === null) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "data is required.");
        }
        const mode = params.mode === "replace" ? "replace" : "merge";
        const table = await parseImport(params.format, params.data);
        let languagesAdded = 0;
        let resourcesAdded = 0;
        let translationsSet = 0;
        store.undoManager.setCombineCommands(true);
        try {
            // 1) ensure languages (interceptAddObject fans a cell into every resource)
            for (const lang of table.languages) {
                if (!lang)
                    continue;
                if (!texts.languages.some((l) => l.languageID === lang)) {
                    store.addObject(texts.languages, (0, store_1.createObject)(store, { languageID: lang }, texts_1.Language));
                    languagesAdded++;
                }
            }
            // 2) ensure resources (seed one cell per CURRENT language)
            for (const row of table.rows) {
                let resource = texts.resources.find((r) => r.resourceID === row.resourceID);
                if (!resource) {
                    const translations = texts.languages.map((l) => ({
                        languageID: l.languageID,
                        text: ""
                    }));
                    resource = (0, store_1.createObject)(store, { resourceID: row.resourceID, translations }, texts_1.TextResource);
                    store.addObject(texts.resources, resource);
                    resourcesAdded++;
                }
                // 3) set cells
                for (const cell of resource.translations || []) {
                    const has = Object.prototype.hasOwnProperty.call(row.cells, cell.languageID);
                    if (has) {
                        store.updateObject(cell, {
                            text: row.cells[cell.languageID]
                        });
                        translationsSet++;
                    }
                    else if (mode === "replace") {
                        if (cell.text !== "") {
                            store.updateObject(cell, { text: "" });
                            translationsSet++;
                        }
                    }
                }
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { languagesAdded, resourcesAdded, translationsSet };
    },
    // Read-only export to csv/json/xliff of the full resources x languages table.
    async export_texts(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const texts = requireTexts(store);
        const fmt = String(params.format || "").toLowerCase();
        const langs = texts.languages.map((l) => l.languageID);
        const rows = texts.resources.map((r) => {
            const cells = {};
            for (const t of r.translations || []) {
                cells[t.languageID] = t.text;
            }
            return { resourceID: r.resourceID, cells };
        });
        if (fmt === "json") {
            const resources = rows.map((row) => ({
                resourceID: row.resourceID,
                ...row.cells
            }));
            return {
                data: JSON.stringify({ languages: langs, resources }, null, 2)
            };
        }
        if (fmt === "csv") {
            const header = ["resourceID", ...langs];
            const body = rows.map((row) => [
                csvEscape(row.resourceID),
                ...langs.map((l) => csvEscape(row.cells[l] ?? ""))
            ].join(","));
            return { data: [header.join(","), ...body].join("\n") };
        }
        if (fmt === "xliff") {
            const xliff = require("xliff");
            const source = langs[0] || "en";
            const target = langs[1] || source;
            const units = {};
            for (const row of rows) {
                units[row.resourceID] = {
                    source: row.cells[source] ?? "",
                    target: row.cells[target] ?? ""
                };
            }
            const js = {
                sourceLanguage: source,
                targetLanguage: target,
                resources: { texts: units }
            };
            const data = await xliff.js2xliff(js);
            return { data };
        }
        throw new protocol_1.BridgeError("BAD_PARAMS", `Unsupported export format "${params.format}". Use csv, json or xliff.`);
    }
};
