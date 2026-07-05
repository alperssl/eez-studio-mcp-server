"use strict";
// Enums, structures and user-widget definitions, mapped onto EEZ's real
// ProjectStore command/undo API. Every mutation goes through
// addObject/insertObject/updateObject/deleteObject so the GUI, undo/redo,
// validation and codegen stay consistent — exactly like handlers.ts.
//
// Live-store targets (all source-verified):
//   enums            -> store.project.variables.enums          (Enum[])
//   enum members     -> enumObject.members                     (EnumMember[])
//   structures       -> store.project.variables.structures     (Structure[])
//   structure fields -> structureObject.fields                 (StructureField[])
//   user widgets     -> store.project.userWidgets              (Page[])
//
// Enum member value model: never write the computed `value`. Use
// specificValue + automaticValue:false for a fixed value, or automaticValue:true
// for an auto value (prev+1, first=0). Deletes leave `enum:Name` / `struct:Name`
// / userWidgetPageName refs dangling (no deleteObjectRefHook in this domain) —
// they surface as CHECK errors, matching EEZ's own delete behavior.
Object.defineProperty(exports, "__esModule", { value: true });
exports.variables2Handlers = void 0;
const store_1 = require("project-editor/store");
const search_1 = require("project-editor/core/search");
const variable_1 = require("project-editor/features/variable/variable");
const value_type_1 = require("project-editor/features/variable/value-type");
const page_1 = require("project-editor/features/page/page");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
exports.variables2Handlers = {
    // --- Enums ---------------------------------------------------------------
    list_enums() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            enums: (0, project_access_1.projectEnums)(store).map((e) => ({
                name: e.name,
                members: (e.members || []).map((m) => ({
                    name: m.name,
                    value: m.value, // computed effective value (auto or specific)
                    automaticValue: m.automaticValue
                }))
            }))
        };
    },
    add_enum(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectEnums)(store), params.name, "enum");
        const members = (params.members || []).map((m) => {
            const useSpecific = m.specificValue !== undefined || m.automaticValue === false;
            return {
                name: m.name,
                automaticValue: !useSpecific,
                specificValue: useSpecific ? m.specificValue : undefined
            };
        });
        const seed = { name: params.name, members };
        const enumObject = (0, store_1.createObject)(store, seed, variable_1.Enum);
        store.addObject(store.project.variables.enums, enumObject);
        return { objID: enumObject.objID, name: enumObject.name };
    },
    add_enum_member(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const enumObject = (0, project_access_1.resolveByName)((0, project_access_1.projectEnums)(store), params.enumName, "enum");
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)(enumObject.members, params.name, "enum member");
        const useSpecific = params.specificValue !== undefined ||
            params.automaticValue === false;
        const seed = {
            name: params.name,
            automaticValue: !useSpecific,
            specificValue: useSpecific ? params.specificValue : undefined
        };
        const member = (0, store_1.createObject)(store, seed, variable_1.EnumMember);
        if (typeof params.index === "number") {
            store.insertObject(enumObject.members, params.index, member);
        }
        else {
            store.addObject(enumObject.members, member);
        }
        return { objID: member.objID };
    },
    update_enum_member(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const enumObject = (0, project_access_1.resolveByName)((0, project_access_1.projectEnums)(store), params.enumName, "enum");
        const member = (0, project_access_1.resolveByName)(enumObject.members, params.memberName, "enum member");
        const props = params.props;
        if (!props || typeof props !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "props{} is required.");
        }
        // Renaming a member rebinds its `EnumName.MemberName` references
        // (replaceObjectReference); revaluing coalesces updateObjectValueHook
        // into the same command as one undo step.
        if ("name" in props && props.name !== member.name) {
            store.undoManager.setCombineCommands(true);
            try {
                (0, search_1.replaceObjectReference)(member, props.name);
                store.updateObject(member, props);
            }
            finally {
                store.undoManager.setCombineCommands(false);
            }
        }
        else {
            store.updateObject(member, props);
        }
        return { objID: member.objID };
    },
    delete_enum(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const enumObject = (0, project_access_1.resolveByName)((0, project_access_1.projectEnums)(store), params.enumName, "enum");
        if (params.memberName) {
            const member = (0, project_access_1.resolveByName)(enumObject.members, params.memberName, "enum member");
            store.deleteObject(member);
            return { deleted: params.memberName };
        }
        store.deleteObject(enumObject);
        return { deleted: params.enumName };
    },
    // --- Structures ----------------------------------------------------------
    list_structures() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            structures: (0, project_access_1.projectStructures)(store).map((s) => ({
                name: s.name,
                fields: (s.fields || []).map((f) => ({
                    name: f.name,
                    type: f.type
                }))
            }))
        };
    },
    add_structure(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectStructures)(store), params.name, "structure");
        const fields = (params.fields || []).map((f) => ({
            name: f.name,
            type: f.type
        }));
        const seed = { name: params.name, fields };
        const structure = (0, store_1.createObject)(store, seed, variable_1.Structure);
        store.addObject(store.project.variables.structures, structure);
        return { objID: structure.objID, name: structure.name };
    },
    add_structure_field(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const structure = (0, project_access_1.resolveByName)((0, project_access_1.projectStructures)(store), params.structureName, "structure");
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        if (!params.type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
        }
        (0, project_access_1.assertNameFree)(structure.fields, params.name, "structure field");
        if (!(0, value_type_1.isValidType)(store.project, params.type)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Invalid type "${params.type}".`);
        }
        const fieldSeed = { name: params.name, type: params.type };
        const field = (0, store_1.createObject)(store, fieldSeed, variable_1.StructureField);
        if (typeof params.index === "number") {
            store.insertObject(structure.fields, params.index, field);
        }
        else {
            store.addObject(structure.fields, field);
        }
        return { objID: field.objID };
    },
    delete_structure(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const structure = (0, project_access_1.resolveByName)((0, project_access_1.projectStructures)(store), params.structureName, "structure");
        if (params.fieldName) {
            const field = (0, project_access_1.resolveByName)(structure.fields, params.fieldName, "structure field");
            store.deleteObject(field);
            return { deleted: params.fieldName };
        }
        store.deleteObject(structure);
        return { deleted: params.structureName };
    },
    // --- User widgets --------------------------------------------------------
    list_user_widgets() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            userWidgets: (0, project_access_1.projectUserWidgets)(store).map((p) => {
                // User widgets have no LVGLScreenWidget root; top-level widgets
                // live directly in page.components.
                const roots = p.components || [];
                return {
                    name: p.name,
                    width: p.width,
                    height: p.height,
                    widgetCount: roots.length
                };
            })
        };
    },
    create_user_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        // Name must be unique across the pages union (screens + user widgets),
        // matching Page.newItem's validators.unique(project.pages, ...).
        (0, project_access_1.assertNameFree)(store.project.pages, params.name, "page or user widget");
        const g = store.project.settings.general;
        const isDashboard = !!store.project.projectTypeTraits
            ?.isDashboard;
        const seed = {
            name: params.name,
            left: 0,
            top: 0,
            width: params.width ?? (isDashboard ? 800 : g.displayWidth ?? 480),
            height: params.height ?? (isDashboard ? 450 : g.displayHeight ?? 272),
            components: [],
            isUsedAsUserWidget: true
        };
        // Page.beforeLoadHook runs inside createObject but skips the
        // LVGLScreenWidget injection for user widgets, so components stays [].
        const page = (0, store_1.createObject)(store, seed, page_1.Page);
        store.addObject(store.project.userWidgets, page);
        return { objID: page.objID, name: page.name };
    },
    delete_user_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolveByName)(store.project.userWidgets, params.name, "user widget");
        store.deleteObject(page);
        return { deleted: params.name };
    }
};
