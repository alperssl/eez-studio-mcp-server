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

import { createObject } from "project-editor/store";
import { replaceObjectReference } from "project-editor/core/search";
import {
    Enum,
    EnumMember,
    Structure,
    StructureField
} from "project-editor/features/variable/variable";
import { isValidType } from "project-editor/features/variable/value-type";
import { Page } from "project-editor/features/page/page";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveByName,
    assertNameFree,
    projectEnums,
    projectStructures,
    projectUserWidgets
} from "mcp-bridge/project-access";

export const variables2Handlers: Record<string, Handler> = {
    // --- Enums ---------------------------------------------------------------

    list_enums() {
        const store = requireProjectStore();
        return {
            enums: projectEnums(store).map((e: any) => ({
                name: e.name,
                members: (e.members || []).map((m: any) => ({
                    name: m.name,
                    value: m.value, // computed effective value (auto or specific)
                    automaticValue: m.automaticValue
                }))
            }))
        };
    },

    add_enum(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectEnums(store), params.name, "enum");

        const members = (params.members || []).map((m: any) => {
            const useSpecific =
                m.specificValue !== undefined || m.automaticValue === false;
            return {
                name: m.name,
                automaticValue: !useSpecific,
                specificValue: useSpecific ? m.specificValue : undefined
            };
        });
        const seed: any = { name: params.name, members };
        const enumObject: any = createObject(store, seed, Enum);
        store.addObject(store.project.variables.enums, enumObject);
        return { objID: enumObject.objID, name: enumObject.name };
    },

    add_enum_member(params: any) {
        const store = requireProjectStore();
        const enumObject = resolveByName(
            projectEnums(store),
            params.enumName,
            "enum"
        );
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(enumObject.members, params.name, "enum member");

        const useSpecific =
            params.specificValue !== undefined ||
            params.automaticValue === false;
        const seed: any = {
            name: params.name,
            automaticValue: !useSpecific,
            specificValue: useSpecific ? params.specificValue : undefined
        };
        const member: any = createObject(store, seed, EnumMember);
        if (typeof params.index === "number") {
            store.insertObject(enumObject.members, params.index, member);
        } else {
            store.addObject(enumObject.members, member);
        }
        return { objID: member.objID };
    },

    update_enum_member(params: any) {
        const store = requireProjectStore();
        const enumObject = resolveByName(
            projectEnums(store),
            params.enumName,
            "enum"
        );
        const member = resolveByName(
            enumObject.members,
            params.memberName,
            "enum member"
        );
        const props: any = params.props;
        if (!props || typeof props !== "object") {
            throw new BridgeError("BAD_PARAMS", "props{} is required.");
        }
        // Renaming a member rebinds its `EnumName.MemberName` references
        // (replaceObjectReference); revaluing coalesces updateObjectValueHook
        // into the same command as one undo step.
        if ("name" in props && props.name !== member.name) {
            store.undoManager.setCombineCommands(true);
            try {
                replaceObjectReference(member, props.name);
                store.updateObject(member, props);
            } finally {
                store.undoManager.setCombineCommands(false);
            }
        } else {
            store.updateObject(member, props);
        }
        return { objID: member.objID };
    },

    delete_enum(params: any) {
        const store = requireProjectStore();
        const enumObject = resolveByName(
            projectEnums(store),
            params.enumName,
            "enum"
        );
        if (params.memberName) {
            const member = resolveByName(
                enumObject.members,
                params.memberName,
                "enum member"
            );
            store.deleteObject(member);
            return { deleted: params.memberName };
        }
        store.deleteObject(enumObject);
        return { deleted: params.enumName };
    },

    // --- Structures ----------------------------------------------------------

    list_structures() {
        const store = requireProjectStore();
        return {
            structures: projectStructures(store).map((s: any) => ({
                name: s.name,
                fields: (s.fields || []).map((f: any) => ({
                    name: f.name,
                    type: f.type
                }))
            }))
        };
    },

    add_structure(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectStructures(store), params.name, "structure");

        const fields = (params.fields || []).map((f: any) => ({
            name: f.name,
            type: f.type
        }));
        const seed: any = { name: params.name, fields };
        const structure: any = createObject(store, seed, Structure);
        store.addObject(store.project.variables.structures, structure);
        return { objID: structure.objID, name: structure.name };
    },

    add_structure_field(params: any) {
        const store = requireProjectStore();
        const structure = resolveByName(
            projectStructures(store),
            params.structureName,
            "structure"
        );
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        if (!params.type) {
            throw new BridgeError("BAD_PARAMS", "type is required.");
        }
        assertNameFree(structure.fields, params.name, "structure field");
        if (!isValidType(store.project, params.type)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid type "${params.type}".`
            );
        }
        const fieldSeed: any = { name: params.name, type: params.type };
        const field: any = createObject(store, fieldSeed, StructureField);
        if (typeof params.index === "number") {
            store.insertObject(structure.fields, params.index, field);
        } else {
            store.addObject(structure.fields, field);
        }
        return { objID: field.objID };
    },

    delete_structure(params: any) {
        const store = requireProjectStore();
        const structure = resolveByName(
            projectStructures(store),
            params.structureName,
            "structure"
        );
        if (params.fieldName) {
            const field = resolveByName(
                structure.fields,
                params.fieldName,
                "structure field"
            );
            store.deleteObject(field);
            return { deleted: params.fieldName };
        }
        store.deleteObject(structure);
        return { deleted: params.structureName };
    },

    // --- User widgets --------------------------------------------------------

    list_user_widgets() {
        const store = requireProjectStore();
        return {
            userWidgets: projectUserWidgets(store).map((p: any) => {
                // User widgets have no LVGLScreenWidget root; top-level widgets
                // live directly in page.components.
                const roots: any[] = p.components || [];
                return {
                    name: p.name,
                    width: p.width,
                    height: p.height,
                    widgetCount: roots.length
                };
            })
        };
    },

    create_user_widget(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        // Name must be unique across the pages union (screens + user widgets),
        // matching Page.newItem's validators.unique(project.pages, ...).
        assertNameFree(
            store.project.pages,
            params.name,
            "page or user widget"
        );

        const g = store.project.settings.general;
        const isDashboard: boolean = !!store.project.projectTypeTraits
            ?.isDashboard;
        const seed: any = {
            name: params.name,
            left: 0,
            top: 0,
            width: params.width ?? (isDashboard ? 800 : g.displayWidth ?? 480),
            height:
                params.height ?? (isDashboard ? 450 : g.displayHeight ?? 272),
            components: [],
            isUsedAsUserWidget: true
        };
        // Page.beforeLoadHook runs inside createObject but skips the
        // LVGLScreenWidget injection for user widgets, so components stays [].
        const page: any = createObject(store, seed, Page);
        store.addObject(store.project.userWidgets, page);
        return { objID: page.objID, name: page.name };
    },

    delete_user_widget(params: any) {
        const store = requireProjectStore();
        const page = resolveByName(
            store.project.userWidgets,
            params.name,
            "user widget"
        );
        store.deleteObject(page);
        return { deleted: params.name };
    }
};
