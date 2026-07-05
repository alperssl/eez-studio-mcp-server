"use strict";
// MCP bridge handlers for INSTRUMENT + DASHBOARD features:
//   manage_scpi                 (project.scpi:  subsystems[]/commands[]/enums[]/members[])
//   manage_instrument_commands  (project.instrumentCommands.commands[], keyed by `command`)
//   set_micropython             (project.micropython.code)
//   manage_shortcuts            (project.shortcuts.shortcuts[], keyed by minted guid() id)
//   list_extension_definitions  (project.extensionDefinitions[] — an ARRAY, read-only)
//   add_extension_definition    (project.extensionDefinitions[])
//
// Every project-data mutation goes through the live ProjectStore command/undo API
// (createObject + addObject/updateObject/deleteObject) so the GUI, undo/redo and
// validation stay consistent — exactly like handlers-settings.ts / handlers-project-entities.ts.
//
// Each of these five features is a Project object-property (project.tsx:1783-1788) that is
// `undefined` until `enable_feature{key}` runs. Read ops throw UNSUPPORTED pointing at
// enable_feature; write ops auto-enable in a single combined undo step (set_readme precedent).
Object.defineProperty(exports, "__esModule", { value: true });
exports.instrumentHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const features_1 = require("project-editor/store/features");
const guid_1 = require("eez-studio-shared/guid");
const scpi_1 = require("project-editor/features/scpi/scpi");
const enum_1 = require("project-editor/features/scpi/enum");
const instrument_commands_1 = require("project-editor/features/instrument-commands/instrument-commands");
const project_shortcuts_1 = require("project-editor/features/shortcuts/project-shortcuts");
const extension_definitions_1 = require("project-editor/features/extension-definitions/extension-definitions");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Local helpers -----------------------------------------------------------
/** Return the live feature sub-object, or throw UNSUPPORTED telling the caller to enable it. */
function requireFeatureObject(store, key) {
    const obj = (0, object_1.getProperty)(store.project, key);
    if (obj == null) {
        throw new protocol_1.BridgeError("UNSUPPORTED", `Feature "${key}" is not enabled. Call enable_feature{key:"${key}"} first.`);
    }
    return obj;
}
/**
 * Auto-enable a feature (identical to enable_feature / set_readme) if absent, then return it.
 * MUST be called inside a setCombineCommands(true)/finally(false) block by the caller so the
 * enable + subsequent mutation collapse into ONE undo step.
 */
function ensureFeatureObject(store, key) {
    const project = store.project;
    let obj = (0, object_1.getProperty)(project, key);
    if (obj == null) {
        const feature = (0, features_1.getProjectFeatures)().find((f) => f.key === key);
        if (!feature) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown feature "${key}".`);
        }
        obj = (0, store_1.createObject)(store, feature.create(), feature.typeClass, key);
        store.updateObject(project, { [key]: obj });
    }
    return obj;
}
// --- SCPI serialization ------------------------------------------------------
function scpiItems(scpi) {
    return {
        subsystems: (scpi.subsystems || []).map((s) => ({
            name: s.name,
            description: s.description,
            helpLink: s.helpLink,
            commands: (s.commands || []).map((c) => ({
                name: c.name,
                description: c.description,
                helpLink: c.helpLink,
                isQuery: c.isQuery,
                sendsBackDataBlock: c.sendsBackDataBlock
            }))
        })),
        enums: (scpi.enums || []).map((e) => ({
            name: e.name,
            members: (e.members || []).map((m) => ({
                name: m.name,
                value: m.value
            }))
        }))
    };
}
function listShortcuts(sc) {
    return (sc.shortcuts || []).map((s) => ({
        id: s.id,
        name: s.name,
        action: s.action
            ? { type: s.action.type, data: s.action.data }
            : undefined,
        keybinding: s.keybinding,
        showInToolbar: s.showInToolbar,
        toolbarButtonColor: s.toolbarButtonColor,
        requiresConfirmation: s.requiresConfirmation
    }));
}
function listInstrumentCommands(ic) {
    return (ic.commands || []).map((c) => ({
        command: c.command,
        description: c.description,
        helpLink: c.helpLink
    }));
}
// --- Handlers ----------------------------------------------------------------
exports.instrumentHandlers = {
    // --- SCPI ----------------------------------------------------------------
    // Op-dispatch CRUD over project.scpi (subsystems[]/enums[], subsystem.commands[],
    // enum.members[]). Reads throw UNSUPPORTED if the feature is off; writes auto-enable.
    // Enum RENAME is rejected (ScpiParameterType.enumeration references enum names).
    manage_scpi(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const op = params.op;
        if (!op) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "op is required.");
        }
        // Read-only op: no undo, guard only.
        if (op === "list") {
            const scpi = requireFeatureObject(store, "scpi");
            return { ok: true, items: scpiItems(scpi) };
        }
        store.undoManager.setCombineCommands(true);
        try {
            const scpi = ensureFeatureObject(store, "scpi");
            switch (op) {
                case "add_subsystem": {
                    if (!params.subsystem) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "subsystem (name) is required.");
                    }
                    (0, project_access_1.assertNameFree)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    const sub = (0, store_1.createObject)(store, { name: params.subsystem, commands: [] }, scpi_1.ScpiSubsystem);
                    store.addObject(scpi.subsystems, sub);
                    break;
                }
                case "update_subsystem": {
                    const sub = (0, project_access_1.resolveByName)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    store.updateObject(sub, params.fields || {});
                    break;
                }
                case "delete_subsystem": {
                    const sub = (0, project_access_1.resolveByName)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    store.deleteObject(sub);
                    break;
                }
                case "add_command": {
                    const sub = (0, project_access_1.resolveByName)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    if (!params.command) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "command (name) is required.");
                    }
                    (0, project_access_1.assertNameFree)(sub.commands, params.command, "SCPI command");
                    const seed = { name: params.command };
                    if (params.fields?.description) {
                        seed.description = params.fields.description;
                    }
                    if (params.fields?.helpLink) {
                        seed.helpLink = params.fields.helpLink;
                    }
                    const cmd = (0, store_1.createObject)(store, seed, scpi_1.ScpiCommand);
                    store.addObject(sub.commands, cmd);
                    break;
                }
                case "update_command": {
                    const sub = (0, project_access_1.resolveByName)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    const cmd = (0, project_access_1.resolveByName)(sub.commands, params.command, "SCPI command");
                    store.updateObject(cmd, params.fields || {});
                    break;
                }
                case "delete_command": {
                    const sub = (0, project_access_1.resolveByName)(scpi.subsystems, params.subsystem, "SCPI subsystem");
                    const cmd = (0, project_access_1.resolveByName)(sub.commands, params.command, "SCPI command");
                    store.deleteObject(cmd);
                    break;
                }
                case "add_enum": {
                    if (!params.enumName) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "enumName is required.");
                    }
                    (0, project_access_1.assertNameFree)(scpi.enums, params.enumName, "SCPI enum");
                    const en = (0, store_1.createObject)(store, { name: params.enumName, members: [] }, enum_1.ScpiEnum);
                    store.addObject(scpi.enums, en);
                    break;
                }
                case "update_enum": {
                    const en = (0, project_access_1.resolveByName)(scpi.enums, params.enumName, "SCPI enum");
                    // Renaming a SCPI enum dangles ScpiParameterType.enumeration references
                    // (referencedObjectCollectionPath "scpi/enums") — reject it.
                    const fields = params.fields || {};
                    if (fields.name !== undefined && fields.name !== en.name) {
                        throw new protocol_1.BridgeError("UNSUPPORTED", "Renaming a SCPI enum is not supported (it is referenced by parameter/response types).");
                    }
                    store.updateObject(en, fields);
                    break;
                }
                case "delete_enum": {
                    const en = (0, project_access_1.resolveByName)(scpi.enums, params.enumName, "SCPI enum");
                    store.deleteObject(en);
                    break;
                }
                case "add_enum_member": {
                    const en = (0, project_access_1.resolveByName)(scpi.enums, params.enumName, "SCPI enum");
                    // `member` may be a bare name string (matches the mcp-server
                    // schema) or an object { name, value? }.
                    const memberName = typeof params.member === "string"
                        ? params.member
                        : params.member?.name;
                    const memberValue = typeof params.member === "object"
                        ? params.member?.value
                        : params.fields?.value;
                    if (!memberName) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "member (name) is required.");
                    }
                    // Member-name uniqueness is a `check`, not a `unique:true` flag —
                    // pre-check for a clean error.
                    if ((en.members || []).some((m) => m.name === memberName)) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", `Enum member "${memberName}" already exists.`);
                    }
                    const mem = (0, store_1.createObject)(store, {
                        name: memberName,
                        value: memberValue ?? ""
                    }, enum_1.ScpiEnumMember);
                    store.addObject(en.members, mem);
                    break;
                }
                case "delete_enum_member": {
                    const en = (0, project_access_1.resolveByName)(scpi.enums, params.enumName, "SCPI enum");
                    const delMemberName = typeof params.member === "string"
                        ? params.member
                        : params.member?.name;
                    const mem = (0, project_access_1.resolveByName)(en.members, delMemberName, "SCPI enum member");
                    store.deleteObject(mem);
                    break;
                }
                default:
                    throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown manage_scpi op "${op}".`);
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { ok: true, items: scpiItems(store.project.scpi) };
    },
    // --- Instrument commands -------------------------------------------------
    // CRUD over project.instrumentCommands.commands[], keyed by `command` (NOT name —
    // resolveByName won't match; use a manual .find). Reads guard; writes auto-enable.
    manage_instrument_commands(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const op = params.op;
        if (!op) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "op is required.");
        }
        if (op === "list") {
            const ic = requireFeatureObject(store, "instrumentCommands");
            return { ok: true, commands: listInstrumentCommands(ic) };
        }
        store.undoManager.setCombineCommands(true);
        try {
            const ic = ensureFeatureObject(store, "instrumentCommands");
            switch (op) {
                case "add": {
                    if (!params.command) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "command is required.");
                    }
                    if ((ic.commands || []).some((c) => c.command === params.command)) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", `Instrument command "${params.command}" already exists.`);
                    }
                    const seed = { command: params.command };
                    if (params.description !== undefined) {
                        seed.description = params.description;
                    }
                    if (params.helpLink !== undefined) {
                        seed.helpLink = params.helpLink;
                    }
                    const cmd = (0, store_1.createObject)(store, seed, instrument_commands_1.InstrumentCommand);
                    store.addObject(ic.commands, cmd);
                    break;
                }
                case "update": {
                    const cmd = (ic.commands || []).find((c) => c.command === params.command);
                    if (!cmd) {
                        throw new protocol_1.BridgeError("NOT_FOUND", `No instrument command "${params.command}".`);
                    }
                    const patch = {};
                    if (params.description !== undefined) {
                        patch.description = params.description;
                    }
                    if (params.helpLink !== undefined) {
                        patch.helpLink = params.helpLink;
                    }
                    store.updateObject(cmd, patch);
                    break;
                }
                case "delete": {
                    const cmd = (ic.commands || []).find((c) => c.command === params.command);
                    if (!cmd) {
                        throw new protocol_1.BridgeError("NOT_FOUND", `No instrument command "${params.command}".`);
                    }
                    store.deleteObject(cmd);
                    break;
                }
                default:
                    throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown manage_instrument_commands op "${op}".`);
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return {
            ok: true,
            commands: listInstrumentCommands(store.project.instrumentCommands)
        };
    },
    // --- MicroPython ---------------------------------------------------------
    // Set project.micropython.code (the prop is `code`, NOT `script`). Auto-enable the
    // feature then write, grouped into ONE undo step (set_readme precedent).
    set_micropython(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        if (typeof params.code !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "code (string) is required.");
        }
        store.undoManager.setCombineCommands(true);
        try {
            const micropython = ensureFeatureObject(store, "micropython");
            store.updateObject(micropython, { code: params.code });
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { code: project.micropython.code };
    },
    // --- Shortcuts -----------------------------------------------------------
    // CRUD over project.shortcuts.shortcuts[]. Shortcut.id is a minted guid() (unique:true)
    // and lookups for update/delete are BY id, not name. `action` is a nested {type,data}.
    manage_shortcuts(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const op = params.op;
        if (!op) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "op is required.");
        }
        if (op === "list") {
            const sc = requireFeatureObject(store, "shortcuts");
            return { ok: true, shortcuts: listShortcuts(sc) };
        }
        store.undoManager.setCombineCommands(true);
        try {
            const sc = ensureFeatureObject(store, "shortcuts");
            switch (op) {
                case "add": {
                    if (!params.name) {
                        throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
                    }
                    (0, project_access_1.assertNameFree)(sc.shortcuts, params.name, "shortcut");
                    const action = typeof params.action === "string"
                        ? { type: "commands", data: params.action }
                        : {
                            type: params.action?.type ?? "commands",
                            data: params.action?.data ?? ""
                        };
                    const seed = {
                        id: (0, guid_1.guid)(),
                        name: params.name,
                        action,
                        keybinding: params.keybinding ?? "",
                        showInToolbar: params.showInToolbar ?? true,
                        toolbarButtonColor: params.toolbarButtonColor ?? "#333333",
                        requiresConfirmation: params.requiresConfirmation ?? false
                    };
                    const shortcut = (0, store_1.createObject)(store, seed, project_shortcuts_1.Shortcut);
                    store.addObject(sc.shortcuts, shortcut);
                    break;
                }
                case "update": {
                    const shortcut = (sc.shortcuts || []).find((s) => s.id === params.id);
                    if (!shortcut) {
                        throw new protocol_1.BridgeError("NOT_FOUND", `No shortcut with id "${params.id}".`);
                    }
                    const patch = {};
                    const keys = [
                        "name",
                        "keybinding",
                        "showInToolbar",
                        "toolbarButtonColor",
                        "requiresConfirmation"
                    ];
                    for (const k of keys) {
                        if (params[k] !== undefined) {
                            patch[k] = params[k];
                        }
                    }
                    if (params.action !== undefined) {
                        patch.action =
                            typeof params.action === "string"
                                ? {
                                    type: shortcut.action?.type ?? "commands",
                                    data: params.action
                                }
                                : {
                                    type: params.action.type,
                                    data: params.action.data
                                };
                    }
                    store.updateObject(shortcut, patch);
                    break;
                }
                case "delete": {
                    const shortcut = (sc.shortcuts || []).find((s) => s.id === params.id);
                    if (!shortcut) {
                        throw new protocol_1.BridgeError("NOT_FOUND", `No shortcut with id "${params.id}".`);
                    }
                    store.deleteObject(shortcut);
                    break;
                }
                default:
                    throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown manage_shortcuts op "${op}".`);
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return {
            ok: true,
            shortcuts: listShortcuts(store.project.shortcuts)
        };
    },
    // --- Extension definitions -----------------------------------------------
    // Read the project.extensionDefinitions[] ARRAY. Throws UNSUPPORTED if the feature
    // is off (the property is `undefined`, not an empty array, until enabled).
    list_extension_definitions() {
        const store = (0, project_access_1.requireProjectStore)();
        const list = store.project.extensionDefinitions;
        if (list == null) {
            throw new protocol_1.BridgeError("UNSUPPORTED", `Feature "extensionDefinitions" is not enabled. Call enable_feature{key:"extensionDefinitions"} first.`);
        }
        return {
            extensionDefinitions: list.map((e) => ({
                objID: e.objID,
                name: e.name,
                description: e.description,
                doNotBuild: e.doNotBuild,
                extensionName: e.extensionName,
                buildConfiguration: e.buildConfiguration,
                idfGuid: e.idfGuid,
                idfRevisionNumber: e.idfRevisionNumber
            }))
        };
    },
    // Add an ExtensionDefinition into the project.extensionDefinitions[] ARRAY. Auto-enables
    // the (array) feature if absent, grouped into ONE undo step. name is unique.
    add_extension_definition(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        store.undoManager.setCombineCommands(true);
        try {
            ensureFeatureObject(store, "extensionDefinitions");
            if ((project.extensionDefinitions || []).some((e) => e.name === params.name)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `An extension definition named "${params.name}" already exists.`);
            }
            const seed = { name: params.name, ...(params.props || {}) };
            const ext = (0, store_1.createObject)(store, seed, extension_definitions_1.ExtensionDefinition);
            store.addObject(project.extensionDefinitions, ext);
            return { objID: ext.objID, name: ext.name };
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
    }
};
