"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowVarsHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const search_1 = require("project-editor/core/search");
const value_type_1 = require("project-editor/features/variable/value-type");
const variable_1 = require("project-editor/features/variable/variable");
const user_property_1 = require("project-editor/flow/user-property");
const actions_1 = require("project-editor/flow/components/actions");
const guid_1 = require("eez-studio-shared/guid");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Helpers ---------------------------------------------------------------
/** Whether a resolved flow is an Action (vs a Page). */
function isActionFlow(flow) {
    return !!(flow && flow.constructor && flow.constructor.name === "Action");
}
/** Flow-wide name scope: user properties + local variables share one namespace
 *  (uniqueForVariableAndUserProperty, variable.tsx). */
function flowNameTaken(flow, name, exclude) {
    const all = [
        ...(flow.userProperties || []),
        ...(flow.localVariables || [])
    ];
    return all.some(x => x && x !== exclude && x.name === name);
}
/** Validate a required ValueType string, throwing BAD_PARAMS on failure. */
function assertValidType(store, type) {
    if (!type) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
    }
    if (!(0, value_type_1.isValidType)(store.project, type)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Invalid type "${type}".`);
    }
}
/** PAGE input/output: create a UserProperty (assignable marks output-like). */
function addUserProperty(store, flow, name, type, assignable) {
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
    }
    assertValidType(store, type);
    if (flowNameTaken(flow, name)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `A user property or local variable named "${name}" already exists.`);
    }
    const seed = { id: (0, guid_1.guid)(), name, type, assignable };
    const up = (0, store_1.createObject)(store, seed, user_property_1.UserProperty);
    store.addObject(flow.userProperties, up);
    return up;
}
/** ACTION input/output: create an Input/OutputActionComponent as a real component
 *  on action.components. Seeded like create_widget (getDefaultValue + type/geometry). */
function addActionIO(store, action, params, dir) {
    if (!params.name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
    }
    assertValidType(store, params.type);
    const existing = (dir === "input" ? action.inputComponents : action.outputComponents) ||
        [];
    if (existing.some((c) => c.name === params.name)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `An ${dir} named "${params.name}" already exists on this action.`);
    }
    const cls = dir === "input" ? actions_1.InputActionComponent : actions_1.OutputActionComponent;
    const typeName = dir === "input" ? "InputActionComponent" : "OutputActionComponent";
    const seed = {};
    Object.assign(seed, (0, object_1.getDefaultValue)(store, cls.classInfo) || {});
    seed.type = typeName;
    seed.name = params.name;
    if (dir === "input") {
        seed.inputType = params.type;
    }
    else {
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
    const component = (0, store_1.createObject)(store, seed, cls);
    store.addObject(action.components, component);
    return component;
}
// --- Handlers --------------------------------------------------------------
exports.flowVarsHandlers = {
    // Read flow.localVariables (Variable[], same class as globals).
    list_flow_variables(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        return {
            variables: (flow.localVariables || []).map((v) => ({
                name: v.name,
                type: v.type
            }))
        };
    },
    // createObject(Variable) -> addObject(flow.localVariables). Name is flow-wide
    // unique across user properties + local variables. defaultValue is a source
    // expression STRING (e.g. "0", "true", "\"hi\"").
    add_flow_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        assertValidType(store, params.type);
        if (flowNameTaken(flow, params.name)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `A user property or local variable named "${params.name}" already exists.`);
        }
        const seed = { name: params.name, type: params.type };
        if (params.defaultValue !== undefined) {
            seed.defaultValue = params.defaultValue;
        }
        const variable = (0, store_1.createObject)(store, seed, variable_1.Variable);
        store.addObject(flow.localVariables, variable);
        return { name: variable.name, objID: variable.objID };
    },
    // updateObject(variable, props). Rename is NOT reference-safe on its own, so a
    // rename is done as replaceObjectReference + updateObject inside one combined
    // undo step. Non-rename prop updates are a single updateObject.
    update_flow_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        const variable = (0, project_access_1.resolveByName)(flow.localVariables, params.name, "local variable");
        const props = params.props;
        if (!props || typeof props !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "props{} is required.");
        }
        if ("type" in props && props.type && !(0, value_type_1.isValidType)(store.project, props.type)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Invalid type "${props.type}".`);
        }
        const isRename = "name" in props && props.name && props.name !== variable.name;
        if (isRename) {
            if (flowNameTaken(flow, props.name, variable)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `Name "${props.name}" already in use.`);
            }
            const um = store.undoManager;
            um.setCombineCommands(true);
            try {
                (0, search_1.replaceObjectReference)(variable, props.name);
                store.updateObject(variable, props);
            }
            finally {
                um.setCombineCommands(false);
            }
        }
        else {
            store.updateObject(variable, props);
        }
        return { name: variable.name, objID: variable.objID };
    },
    // deleteObject(variable). Variable has no deleteObjectRefHook, so inbound
    // expression references are left dangling (surface later as CHECK errors) —
    // identical to the bridge's existing delete_variable behavior.
    delete_flow_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        const variable = (0, project_access_1.resolveByName)(flow.localVariables, params.name, "local variable");
        store.deleteObject(variable);
        return { deleted: params.name };
    },
    // PAGE -> UserProperty[] (assignable split). ACTION -> Input/OutputActionComponent.
    list_flow_interface(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        if (isActionFlow(flow)) {
            return {
                inputs: (flow.inputComponents || []).map((c) => ({
                    name: c.name,
                    type: c.inputType,
                    objID: c.objID
                })),
                outputs: (flow.outputComponents || []).map((c) => ({
                    name: c.name,
                    type: c.outputType,
                    objID: c.objID
                }))
            };
        }
        // Page / user widget: UserProperty[]. assignable=false -> input,
        // assignable=true -> output-like (writable-back).
        const ups = flow.userProperties || [];
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
    add_flow_input(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        if (isActionFlow(flow)) {
            const c = addActionIO(store, flow, params, "input");
            return { name: c.name, objID: c.objID };
        }
        const up = addUserProperty(store, flow, params.name, params.type, params.assignable ?? false);
        return { name: up.name, id: up.id, objID: up.objID };
    },
    // PAGE -> UserProperty with assignable=true (output-like). ACTION -> OutputActionComponent.
    add_flow_output(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
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
        const store = (0, project_access_1.requireProjectStore)();
        const actions = (0, project_access_1.projectActions)(store);
        return {
            actions: actions.map((a) => {
                const isFlow = a.implementationType === "flow";
                return {
                    name: a.name,
                    implementationType: a.implementationType,
                    inputs: isFlow
                        ? (a.inputComponents || []).map((c) => ({
                            name: c.name,
                            type: c.inputType
                        }))
                        : [],
                    outputs: isFlow
                        ? (a.outputComponents || []).map((c) => ({
                            name: c.name,
                            type: c.outputType
                        }))
                        : []
                };
            })
        };
    }
};
