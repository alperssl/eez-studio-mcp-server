// Flow-scoped LOCAL VARIABLES + PUBLIC INTERFACE (inputs/outputs) bridge methods.
//
// A Flow is a Page (screen or user-widget) OR an Action; both extend Flow and
// inherit `localVariables` (Variable[]), `userProperties` (UserProperty[]) and
// `components` (Component[]). Every mutation here is a real flow edit and therefore
// a ProjectStore command (one undo step), exactly like handlers.ts.
//
// Page-vs-Action asymmetry for the public interface (source-verified):
//   PAGE   public IO = UserProperty[] in flow.userProperties (assignable=false -> input,
//          assignable=true -> output-like/writable-back).
//   ACTION public IO = Input/OutputActionComponent instances in action.components,
//          surfaced via flow.inputComponents / flow.outputComponents.
//
// See research/source-v7/flow-vars-interface.md for the exact file:line citations.

import { createObject } from "project-editor/store";
import { getDefaultValue } from "project-editor/core/object";
import { replaceObjectReference } from "project-editor/core/search";
import { isValidType } from "project-editor/features/variable/value-type";
import { Variable } from "project-editor/features/variable/variable";
import { UserProperty } from "project-editor/flow/user-property";
import {
    InputActionComponent,
    OutputActionComponent
} from "project-editor/flow/components/actions";
import { guid } from "eez-studio-shared/guid";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveFlow,
    resolveByName,
    projectActions,
    ProjectStoreLike
} from "mcp-bridge/project-access";

// --- Helpers ---------------------------------------------------------------

/** Whether a resolved flow is an Action (vs a Page). */
function isActionFlow(flow: any): boolean {
    return !!(flow && flow.constructor && flow.constructor.name === "Action");
}

/** Flow-wide name scope: user properties + local variables share one namespace
 *  (uniqueForVariableAndUserProperty, variable.tsx). */
function flowNameTaken(flow: any, name: string, exclude?: any): boolean {
    const all: any[] = [
        ...((flow.userProperties as any[]) || []),
        ...((flow.localVariables as any[]) || [])
    ];
    return all.some(x => x && x !== exclude && x.name === name);
}

/** Validate a required ValueType string, throwing BAD_PARAMS on failure. */
function assertValidType(store: ProjectStoreLike, type: string): void {
    if (!type) {
        throw new BridgeError("BAD_PARAMS", "type is required.");
    }
    if (!isValidType(store.project, type as any)) {
        throw new BridgeError("BAD_PARAMS", `Invalid type "${type}".`);
    }
}

/** PAGE input/output: create a UserProperty (assignable marks output-like). */
function addUserProperty(
    store: ProjectStoreLike,
    flow: any,
    name: string,
    type: string,
    assignable: boolean
): any {
    if (!name) {
        throw new BridgeError("BAD_PARAMS", "name is required.");
    }
    assertValidType(store, type);
    if (flowNameTaken(flow, name)) {
        throw new BridgeError(
            "BAD_PARAMS",
            `A user property or local variable named "${name}" already exists.`
        );
    }
    const seed: any = { id: guid(), name, type, assignable };
    const up: any = createObject(store, seed, UserProperty);
    store.addObject(flow.userProperties, up);
    return up;
}

/** ACTION input/output: create an Input/OutputActionComponent as a real component
 *  on action.components. Seeded like create_widget (getDefaultValue + type/geometry). */
function addActionIO(
    store: ProjectStoreLike,
    action: any,
    params: any,
    dir: "input" | "output"
): any {
    if (!params.name) {
        throw new BridgeError("BAD_PARAMS", "name is required.");
    }
    assertValidType(store, params.type);

    const existing: any[] =
        (dir === "input" ? action.inputComponents : action.outputComponents) ||
        [];
    if (existing.some((c: any) => c.name === params.name)) {
        throw new BridgeError(
            "BAD_PARAMS",
            `An ${dir} named "${params.name}" already exists on this action.`
        );
    }

    const cls: any =
        dir === "input" ? InputActionComponent : OutputActionComponent;
    const typeName =
        dir === "input" ? "InputActionComponent" : "OutputActionComponent";

    const seed: any = {};
    Object.assign(seed, getDefaultValue(store, cls.classInfo) || {});
    seed.type = typeName;
    seed.name = params.name;
    if (dir === "input") {
        seed.inputType = params.type;
    } else {
        seed.outputType = params.type;
    }
    // Stagger vertically so inputComponents/outputComponents ordering (sorted by
    // `top`) is deterministic across additions.
    if (seed.left === undefined) {
        seed.left = 0;
    }
    if (seed.top === undefined) {
        seed.top = existing.length * 60;
    }
    if (seed.width === undefined) {
        seed.width = 0;
    }
    if (seed.height === undefined) {
        seed.height = 0;
    }

    const component: any = createObject(store, seed, cls);
    store.addObject(action.components, component);
    return component;
}

// --- Handlers --------------------------------------------------------------

export const flowVarsHandlers: Record<string, Handler> = {
    // Read flow.localVariables (Variable[], same class as globals).
    list_flow_variables(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        return {
            variables: ((flow.localVariables as any[]) || []).map((v: any) => ({
                name: v.name,
                type: v.type
            }))
        };
    },

    // createObject(Variable) -> addObject(flow.localVariables). Name is flow-wide
    // unique across user properties + local variables. defaultValue is a source
    // expression STRING (e.g. "0", "true", "\"hi\"").
    add_flow_variable(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertValidType(store, params.type);
        if (flowNameTaken(flow, params.name)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `A user property or local variable named "${params.name}" already exists.`
            );
        }

        const seed: any = { name: params.name, type: params.type };
        if (params.defaultValue !== undefined) {
            seed.defaultValue = params.defaultValue;
        }
        const variable: any = createObject(store, seed, Variable);
        store.addObject(flow.localVariables, variable);
        return { name: variable.name, objID: variable.objID };
    },

    // updateObject(variable, props). Rename is NOT reference-safe on its own, so a
    // rename is done as replaceObjectReference + updateObject inside one combined
    // undo step. Non-rename prop updates are a single updateObject.
    update_flow_variable(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        const variable = resolveByName(
            flow.localVariables,
            params.name,
            "local variable"
        );
        const props = params.props;
        if (!props || typeof props !== "object") {
            throw new BridgeError("BAD_PARAMS", "props{} is required.");
        }
        if ("type" in props && props.type && !isValidType(store.project, props.type as any)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Invalid type "${props.type}".`
            );
        }

        const isRename =
            "name" in props && props.name && props.name !== variable.name;
        if (isRename) {
            if (flowNameTaken(flow, props.name, variable)) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    `Name "${props.name}" already in use.`
                );
            }
            const um = store.undoManager;
            um.setCombineCommands(true);
            try {
                replaceObjectReference(variable, props.name);
                store.updateObject(variable, props);
            } finally {
                um.setCombineCommands(false);
            }
        } else {
            store.updateObject(variable, props);
        }
        return { name: variable.name, objID: variable.objID };
    },

    // deleteObject(variable). Variable has no deleteObjectRefHook, so inbound
    // expression references are left dangling (surface later as CHECK errors) —
    // identical to the bridge's existing delete_variable behavior.
    delete_flow_variable(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        const variable = resolveByName(
            flow.localVariables,
            params.name,
            "local variable"
        );
        store.deleteObject(variable);
        return { deleted: params.name };
    },

    // PAGE -> UserProperty[] (assignable split). ACTION -> Input/OutputActionComponent.
    list_flow_interface(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);

        if (isActionFlow(flow)) {
            return {
                inputs: ((flow.inputComponents as any[]) || []).map((c: any) => ({
                    name: c.name,
                    type: c.inputType,
                    objID: c.objID
                })),
                outputs: ((flow.outputComponents as any[]) || []).map((c: any) => ({
                    name: c.name,
                    type: c.outputType,
                    objID: c.objID
                }))
            };
        }

        // Page / user widget: UserProperty[]. assignable=false -> input,
        // assignable=true -> output-like (writable-back).
        const ups: any[] = (flow.userProperties as any[]) || [];
        return {
            inputs: ups
                .filter(p => !p.assignable)
                .map(p => ({ name: p.name, type: p.type, assignable: false })),
            outputs: ups
                .filter(p => p.assignable)
                .map(p => ({ name: p.name, type: p.type, assignable: true }))
        };
    },

    // PAGE -> UserProperty (assignable defaults false). ACTION -> InputActionComponent.
    add_flow_input(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        if (isActionFlow(flow)) {
            const c = addActionIO(store, flow, params, "input");
            return { name: c.name, objID: c.objID };
        }
        const up = addUserProperty(
            store,
            flow,
            params.name,
            params.type,
            params.assignable ?? false
        );
        return { name: up.name, id: up.id, objID: up.objID };
    },

    // PAGE -> UserProperty with assignable=true (output-like). ACTION -> OutputActionComponent.
    add_flow_output(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        if (isActionFlow(flow)) {
            const c = addActionIO(store, flow, params, "output");
            return { name: c.name, objID: c.objID };
        }
        const up = addUserProperty(store, flow, params.name, params.type, true);
        return { name: up.name, id: up.id, objID: up.objID };
    },

    // All actions with their implementationType; for flow-implemented actions,
    // IO comes from the inherited inputComponents/outputComponents getters.
    list_action_flows() {
        const store = requireProjectStore();
        const actions: any[] = projectActions(store);
        return {
            actions: actions.map((a: any) => {
                const isFlow = a.implementationType === "flow";
                return {
                    name: a.name,
                    implementationType: a.implementationType,
                    inputs: isFlow
                        ? ((a.inputComponents as any[]) || []).map((c: any) => ({
                              name: c.name,
                              type: c.inputType
                          }))
                        : [],
                    outputs: isFlow
                        ? ((a.outputComponents as any[]) || []).map((c: any) => ({
                              name: c.name,
                              type: c.outputType
                          }))
                        : []
                };
            })
        };
    }
};
