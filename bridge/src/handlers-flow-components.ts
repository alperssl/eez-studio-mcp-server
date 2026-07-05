// Flow-component method handlers: place / edit / remove ActionComponents (and
// read widgets) on a Flow (a Page OR an Action, both `extends Flow`). Mutations
// target flow.components / flow.connectionLines / flow.componentGroups and go
// through the store's undo-aware addObject/updateObject/deleteObject so the GUI,
// undo/redo, validation and codegen stay consistent.
//
// Source recipes: research/source-v7/flow-components.md.

import { createObject, getLabel } from "project-editor/store";
import {
    findClass,
    getDefaultValue,
    getClassInfo,
    getClassesDerivedFrom
} from "project-editor/core/object";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { ComponentGroup } from "project-editor/flow/component-group";
import {
    getComponentGroupName,
    getComponentGroupDisplayName,
    getComponentName
} from "project-editor/flow/components/components-registry";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import { requireProjectStore, resolveObject, resolveFlow } from "mcp-bridge/project-access";

// Build the palette-exact seed for a component class (mirrors
// ComponentsPalette.tsx create path: getDefaultValue + componentDefaultValue +
// {type,left,top,width:0,height:0} + caller props).
function buildComponentSeed(store: any, cls: any, type: string, params: any): any {
    const seed: any = {};
    Object.assign(seed, getDefaultValue(store, cls.classInfo) || {});
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
function portInputs(c: any): any[] {
    return (c.inputs || []).map((i: any) => ({
        name: i.name,
        type: i.type,
        isSeq: !!i.isSequenceInput
    }));
}

// Enumerate a component instance's computed output ports.
function portOutputs(c: any): any[] {
    return (c.outputs || []).map((o: any) => ({
        name: o.name,
        type: o.type,
        isSeq: !!o.isSequenceOutput
    }));
}

function isWidgetComponent(c: any): boolean {
    return (
        c instanceof ProjectEditor.WidgetClass ||
        c instanceof ProjectEditor.LVGLWidgetClass
    );
}

export const flowComponentsHandlers: Record<string, Handler> = {
    // create_flow_component {page?,action?,type,left?,top?,props?} -> {objID}
    create_flow_component(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        const type: string = params.type;
        if (!type) {
            throw new BridgeError("BAD_PARAMS", "type is required.");
        }
        const cls = findClass(type);
        if (!cls) {
            throw new BridgeError(
                "NOT_FOUND",
                `Unknown component type "${type}".`
            );
        }
        const seed = buildComponentSeed(store, cls, type, params);
        const component = createObject(store, seed, cls) as any;
        store.addObject(flow.components, component);
        return { objID: component.objID };
    },

    // list_flow_components {page?,action?} -> {components:[{objID,type,label,left,top,isWidget}]}
    list_flow_components(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        const components: any[] = flow.components || [];
        return {
            components: components.map((c: any) => ({
                objID: c.objID,
                type: c.type,
                label: getLabel(c),
                left: c.left,
                top: c.top,
                isWidget: isWidgetComponent(c)
            }))
        };
    },

    // list_flow_component_types {group?,search?} -> {types:[{name,group,label,inputs,outputs}]}
    list_flow_component_types(params: any) {
        const store = requireProjectStore();
        const projectType = store.project.settings.general.projectType;
        const search =
            typeof params.search === "string"
                ? params.search.toLowerCase()
                : undefined;

        const all = getClassesDerivedFrom(
            store,
            ProjectEditor.ActionComponentClass
        );

        const types: any[] = [];
        for (const ci of all) {
            const cls: any = ci.objectClass;

            // Palette enable gate (same predicate ComponentsPalette applies).
            const enabledFn = cls.classInfo.enabledInComponentPalette;
            if (enabledFn && !enabledFn(projectType, store)) {
                continue;
            }

            const groupName = getComponentGroupName(ci);
            const groupDisplay = getComponentGroupDisplayName(groupName);
            if (params.group && groupDisplay !== params.group) {
                continue;
            }

            const label =
                ci.displayName ||
                cls.classInfo.componentPaletteLabel ||
                getComponentName(ci.name);

            if (
                search &&
                (ci.displayName || ci.name).toLowerCase().indexOf(search) === -1
            ) {
                continue;
            }

            // Ports are instance-computed getters (getInputs/getOutputs read
            // instance fields), so introspect a throwaway proto instance.
            let inputs: string[] = [];
            let outputs: string[] = [];
            try {
                const proto: any = createObject(
                    store,
                    { type: ci.name } as any,
                    cls
                );
                inputs = (proto.inputs || []).map((i: any) => i.name);
                outputs = (proto.outputs || []).map((o: any) => o.name);
            } catch (e) {
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
    get_flow_component(params: any) {
        const store = requireProjectStore();
        const c = resolveObject(store, params.objID);
        const flow = ProjectEditor.getFlow(c);
        const connectionLines: any[] = (flow && flow.connectionLines) || [];

        const props: any = {};
        const properties = getClassInfo(c).properties || [];
        for (const p of properties) {
            if (!p.name || p.hideInPropertyGrid === true || p.computed === true) {
                continue;
            }
            props[p.name] = (c as any)[p.name];
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
                        .filter((l: any) => l.target === c.objID)
                        .map((l: any) => ({
                            from: l.source,
                            output: l.output,
                            input: l.input
                        })),
                    outgoing: connectionLines
                        .filter((l: any) => l.source === c.objID)
                        .map((l: any) => ({
                            output: l.output,
                            to: l.target,
                            input: l.input
                        }))
                }
            }
        };
    },

    // set_component_props {objID,props} -> {objID}
    set_component_props(params: any) {
        const store = requireProjectStore();
        const c = resolveObject(store, params.objID);
        if (!params.props || typeof params.props !== "object") {
            throw new BridgeError("BAD_PARAMS", "props{} is required.");
        }
        store.updateObject(c, params.props);
        return { objID: c.objID };
    },

    // move_flow_component {objID,left,top} -> {objID}
    // ActionComponents auto-size (autoSize="both"); only left/top matter.
    move_flow_component(params: any) {
        const store = requireProjectStore();
        const c = resolveObject(store, params.objID);
        const props: any = {};
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
    delete_flow_component(params: any) {
        const store = requireProjectStore();
        const c = resolveObject(store, params.objID);
        store.deleteObject(c);
        return { deleted: params.objID };
    },

    // set_catch_error {objID,on} -> {objID,catchError}
    // Turning off triggers updateObjectValueHook which auto-deletes @error wires.
    set_catch_error(params: any) {
        const store = requireProjectStore();
        const c = resolveObject(store, params.objID);
        const on = !!params.on;
        store.updateObject(c, { catchError: on });
        return { objID: c.objID, catchError: on };
    },

    // create_component_group {page?,action?,name,componentIDs?} -> {objID}
    create_component_group(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        const ids: string[] = Array.isArray(params.componentIDs)
            ? params.componentIDs
            : [];
        const flowComponents: any[] = flow.components || [];
        for (const id of ids) {
            if (!flowComponents.find((c: any) => c.objID === id)) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    `Component "${id}" is not in this flow.`
                );
            }
        }
        const group = createObject(
            store,
            { description: params.name, components: ids } as any,
            ComponentGroup
        ) as any;
        store.addObject(flow.componentGroups, group);
        return { objID: group.objID };
    }
};
