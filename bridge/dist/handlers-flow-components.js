"use strict";
// Flow-component method handlers: place / edit / remove ActionComponents (and
// read widgets) on a Flow (a Page OR an Action, both `extends Flow`). Mutations
// target flow.components / flow.connectionLines / flow.componentGroups and go
// through the store's undo-aware addObject/updateObject/deleteObject so the GUI,
// undo/redo, validation and codegen stay consistent.
//
// Source recipes: research/source-v7/flow-components.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowComponentsHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const component_group_1 = require("project-editor/flow/component-group");
const components_registry_1 = require("project-editor/flow/components/components-registry");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// Build the palette-exact seed for a component class (mirrors
// ComponentsPalette.tsx create path: getDefaultValue + componentDefaultValue +
// {type,left,top,width:0,height:0} + caller props).
function buildComponentSeed(store, cls, type, params) {
    const seed = {};
    Object.assign(seed, (0, object_1.getDefaultValue)(store, cls.classInfo) || {});
    if (cls.classInfo.componentDefaultValue) {
        Object.assign(seed, cls.classInfo.componentDefaultValue(store) || {});
    }
    seed.type = type;
    seed.left = typeof params.left === "number" ? params.left : 0;
    seed.top = typeof params.top === "number" ? params.top : 0;
    if (seed.width === undefined) {
        seed.width = 0;
    }
    if (seed.height === undefined) {
        seed.height = 0;
    }
    if (params.props && typeof params.props === "object") {
        Object.assign(seed, params.props);
    }
    return seed;
}
// Enumerate a component instance's computed input ports.
function portInputs(c) {
    return (c.inputs || []).map((i) => ({
        name: i.name,
        type: i.type,
        isSeq: !!i.isSequenceInput
    }));
}
// Enumerate a component instance's computed output ports.
function portOutputs(c) {
    return (c.outputs || []).map((o) => ({
        name: o.name,
        type: o.type,
        isSeq: !!o.isSequenceOutput
    }));
}
function isWidgetComponent(c) {
    return (c instanceof project_editor_interface_1.ProjectEditor.WidgetClass ||
        c instanceof project_editor_interface_1.ProjectEditor.LVGLWidgetClass);
}
exports.flowComponentsHandlers = {
    // create_flow_component {page?,action?,type,left?,top?,props?} -> {objID}
    create_flow_component(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        const type = params.type;
        if (!type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
        }
        const cls = (0, object_1.findClass)(type);
        if (!cls) {
            throw new protocol_1.BridgeError("NOT_FOUND", `Unknown component type "${type}".`);
        }
        const seed = buildComponentSeed(store, cls, type, params);
        const component = (0, store_1.createObject)(store, seed, cls);
        store.addObject(flow.components, component);
        return { objID: component.objID };
    },
    // list_flow_components {page?,action?} -> {components:[{objID,type,label,left,top,isWidget}]}
    list_flow_components(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        const components = flow.components || [];
        return {
            components: components.map((c) => ({
                objID: c.objID,
                type: c.type,
                label: (0, store_1.getLabel)(c),
                left: c.left,
                top: c.top,
                isWidget: isWidgetComponent(c)
            }))
        };
    },
    // list_flow_component_types {group?,search?} -> {types:[{name,group,label,inputs,outputs}]}
    list_flow_component_types(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const projectType = store.project.settings.general.projectType;
        const search = typeof params.search === "string"
            ? params.search.toLowerCase()
            : undefined;
        const all = (0, object_1.getClassesDerivedFrom)(store, project_editor_interface_1.ProjectEditor.ActionComponentClass);
        const types = [];
        for (const ci of all) {
            const cls = ci.objectClass;
            // Palette enable gate (same predicate ComponentsPalette applies).
            const enabledFn = cls.classInfo.enabledInComponentPalette;
            if (enabledFn && !enabledFn(projectType, store)) {
                continue;
            }
            const groupName = (0, components_registry_1.getComponentGroupName)(ci);
            const groupDisplay = (0, components_registry_1.getComponentGroupDisplayName)(groupName);
            if (params.group && groupDisplay !== params.group) {
                continue;
            }
            const label = ci.displayName ||
                cls.classInfo.componentPaletteLabel ||
                (0, components_registry_1.getComponentName)(ci.name);
            if (search &&
                (ci.displayName || ci.name).toLowerCase().indexOf(search) === -1) {
                continue;
            }
            // Ports are instance-computed getters (getInputs/getOutputs read
            // instance fields), so introspect a throwaway proto instance.
            let inputs = [];
            let outputs = [];
            try {
                const proto = (0, store_1.createObject)(store, { type: ci.name }, cls);
                inputs = (proto.inputs || []).map((i) => i.name);
                outputs = (proto.outputs || []).map((o) => o.name);
            }
            catch (e) {
                // Some classes cannot be instantiated bare; leave ports empty.
            }
            types.push({
                name: ci.name,
                group: groupDisplay,
                label,
                inputs,
                outputs
            });
        }
        return { types };
    },
    // get_flow_component {objID} -> {component:{objID,type,props,inputs,outputs,left,top,connections}}
    get_flow_component(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const c = (0, project_access_1.resolveObject)(store, params.objID);
        const flow = project_editor_interface_1.ProjectEditor.getFlow(c);
        const connectionLines = (flow && flow.connectionLines) || [];
        const props = {};
        const properties = (0, object_1.getClassInfo)(c).properties || [];
        for (const p of properties) {
            if (!p.name || p.hideInPropertyGrid === true || p.computed === true) {
                continue;
            }
            props[p.name] = c[p.name];
        }
        return {
            component: {
                objID: c.objID,
                type: c.type,
                left: c.left,
                top: c.top,
                inputs: portInputs(c),
                outputs: portOutputs(c),
                props,
                connections: {
                    incoming: connectionLines
                        .filter((l) => l.target === c.objID)
                        .map((l) => ({
                        from: l.source,
                        output: l.output,
                        input: l.input
                    })),
                    outgoing: connectionLines
                        .filter((l) => l.source === c.objID)
                        .map((l) => ({
                        output: l.output,
                        to: l.target,
                        input: l.input
                    }))
                }
            }
        };
    },
    // set_component_props {objID,props} -> {objID}
    set_component_props(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const c = (0, project_access_1.resolveObject)(store, params.objID);
        if (!params.props || typeof params.props !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "props{} is required.");
        }
        store.updateObject(c, params.props);
        return { objID: c.objID };
    },
    // move_flow_component {objID,left,top} -> {objID}
    // ActionComponents auto-size (autoSize="both"); only left/top matter.
    move_flow_component(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const c = (0, project_access_1.resolveObject)(store, params.objID);
        const props = {};
        if (typeof params.left === "number") {
            props.left = params.left;
        }
        if (typeof params.top === "number") {
            props.top = params.top;
        }
        store.updateObject(c, props);
        return { objID: c.objID };
    },
    // delete_flow_component {objID} -> {deleted}
    // deleteObjectRefHook cascades: attached connection lines + group membership
    // are removed in the same undo step. No manual cleanup required.
    delete_flow_component(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const c = (0, project_access_1.resolveObject)(store, params.objID);
        store.deleteObject(c);
        return { deleted: params.objID };
    },
    // set_catch_error {objID,on} -> {objID,catchError}
    // Turning off triggers updateObjectValueHook which auto-deletes @error wires.
    set_catch_error(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const c = (0, project_access_1.resolveObject)(store, params.objID);
        const on = !!params.on;
        store.updateObject(c, { catchError: on });
        return { objID: c.objID, catchError: on };
    },
    // create_component_group {page?,action?,name,componentIDs?} -> {objID}
    create_component_group(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        const ids = Array.isArray(params.componentIDs)
            ? params.componentIDs
            : [];
        const flowComponents = flow.components || [];
        for (const id of ids) {
            if (!flowComponents.find((c) => c.objID === id)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `Component "${id}" is not in this flow.`);
            }
        }
        const group = (0, store_1.createObject)(store, { description: params.name, components: ids }, component_group_1.ComponentGroup);
        store.addObject(flow.componentGroups, group);
        return { objID: group.objID };
    }
};
