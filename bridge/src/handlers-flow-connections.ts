// Flow-graph mutation handlers: wire connections between components, custom
// component ports, and flow-type widget event handlers. All edits go through
// store.addObject / deleteObject / updateObject and are therefore real undo
// commands. Ops that trigger ref-hook cascades (delete_component_port) are
// wrapped in setCombineCommands so they collapse into ONE undo step.
//
// Identity model (see research/source-v7/flow-connections-ports.md):
//   ConnectionLine.source / .target = component objID strings.
//   ConnectionLine.output / .input  = port name strings.
//   Exec (sequence) wires use output:"@seqout", input:"@seqin".
//   Port existence is validated against the MERGED getters component.inputs /
//   component.outputs (NOT the raw customInputs/customOutputs arrays).

import { createObject, getLabel } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { ConnectionLine } from "project-editor/flow/connection-line";
import {
    CustomInput,
    CustomOutput,
    EventHandler
} from "project-editor/flow/component";
import {
    getInputDisplayName,
    getOutputDisplayName
} from "project-editor/flow/helper";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    resolveObject,
    resolveFlow,
    ProjectStoreLike
} from "mcp-bridge/project-access";

/** Resolve a component by objID and confirm it exposes flow port getters. */
function resolveComponent(store: ProjectStoreLike, objID: string): any {
    const comp = resolveObject(store, objID);
    if (!Array.isArray(comp.inputs) || !Array.isArray(comp.outputs)) {
        throw new BridgeError(
            "BAD_PARAMS",
            `Object "${objID}" is not a flow component.`
        );
    }
    return comp;
}

export const flowConnectionsHandlers: Record<string, Handler> = {
    // --- Connections --------------------------------------------------------

    connect_components(params: any) {
        const store = requireProjectStore();
        if (!params.output || !params.input) {
            throw new BridgeError(
                "BAD_PARAMS",
                "source, output, target and input are all required."
            );
        }
        const src = resolveComponent(store, params.source);
        const tgt = resolveComponent(store, params.target);

        const flow = ProjectEditor.getFlow(src);
        const tgtFlow = ProjectEditor.getFlow(tgt);
        if (!flow || flow !== tgtFlow) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Source and target must live in the same flow (page or action)."
            );
        }

        // Validate ports against the merged getters (include @seqin/@seqout).
        if (!src.outputs.find((o: any) => o.name === params.output)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `No output "${params.output}" on source component.`
            );
        }
        if (!tgt.inputs.find((i: any) => i.name === params.input)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `No input "${params.input}" on target component.`
            );
        }

        // Reject exact duplicate wire (EEZ warns on dupes).
        const lines: any[] = flow.connectionLines || [];
        const dup = lines.find(
            (l: any) =>
                l.source === src.objID &&
                l.output === params.output &&
                l.target === tgt.objID &&
                l.input === params.input
        );
        if (dup) {
            throw new BridgeError(
                "BAD_PARAMS",
                "An identical connection already exists."
            );
        }

        const seed: any = {
            source: src.objID,
            output: params.output,
            target: tgt.objID,
            input: params.input
        };
        const line = createObject(store, seed, ConnectionLine) as any;
        store.addObject(flow.connectionLines, line);
        return { objID: line.objID };
    },

    disconnect_components(params: any) {
        const store = requireProjectStore();

        if (params.objID) {
            const line = resolveObject(store, params.objID);
            store.deleteObject(line);
            return { deleted: params.objID };
        }

        if (!params.source || !params.target || !params.output || !params.input) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Provide objID, or source+output+target+input to match a connection."
            );
        }
        const src = resolveComponent(store, params.source);
        const tgt = resolveComponent(store, params.target);
        const flow = ProjectEditor.getFlow(src);
        const lines: any[] = (flow && flow.connectionLines) || [];
        const line = lines.find(
            (l: any) =>
                l.source === src.objID &&
                l.output === params.output &&
                l.target === tgt.objID &&
                l.input === params.input
        );
        if (!line) {
            throw new BridgeError("NOT_FOUND", "No matching connection.");
        }
        store.deleteObject(line);
        return { deleted: line.objID };
    },

    list_flow_connections(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, params);
        const lines: any[] = flow.connectionLines || [];
        const connections = lines.map((l: any) => {
            const srcComp = l.sourceComponent;
            const tgtComp = l.targetComponent;
            return {
                objID: l.objID,
                source: l.source,
                output: l.output,
                target: l.target,
                input: l.input,
                disabled: !!l.disabled,
                label: safeLabel(l),
                sourceLabel: srcComp ? safeLabel(srcComp) : null,
                targetLabel: tgtComp ? safeLabel(tgtComp) : null,
                outputLabel: getOutputDisplayName(srcComp, l.output),
                inputLabel: getInputDisplayName(tgtComp, l.input)
            };
        });
        return { connections };
    },

    update_flow_connection(params: any) {
        const store = requireProjectStore();
        const line = resolveObject(store, params.objID);
        const props: any = {};
        if (typeof params.disabled === "boolean") {
            props.disabled = params.disabled;
        }
        if (typeof params.description === "string") {
            props.description = params.description;
        }
        store.updateObject(line, props);
        return { objID: line.objID };
    },

    // --- Component ports ----------------------------------------------------

    add_component_input(params: any) {
        const store = requireProjectStore();
        if (!params.name || !params.type) {
            throw new BridgeError("BAD_PARAMS", "name and type are required.");
        }
        const comp = resolveComponent(store, params.objID);
        if (!Array.isArray(comp.customInputs)) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Component does not support custom inputs."
            );
        }
        if (comp.inputs.find((i: any) => i.name === params.name)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Input "${params.name}" already exists.`
            );
        }
        const ci = createObject(
            store,
            { name: params.name, type: params.type } as any,
            CustomInput
        ) as any;
        store.addObject(comp.customInputs, ci);
        return { objID: comp.objID, input: params.name };
    },

    add_component_output(params: any) {
        const store = requireProjectStore();
        if (!params.name || !params.type) {
            throw new BridgeError("BAD_PARAMS", "name and type are required.");
        }
        const comp = resolveComponent(store, params.objID);
        if (!Array.isArray(comp.customOutputs)) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Component does not support custom outputs."
            );
        }
        if (comp.outputs.find((o: any) => o.name === params.name)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Output "${params.name}" already exists.`
            );
        }
        const co = createObject(
            store,
            { name: params.name, type: params.type } as any,
            CustomOutput
        ) as any;
        store.addObject(comp.customOutputs, co);
        return { objID: comp.objID, output: params.name };
    },

    delete_component_port(params: any) {
        const store = requireProjectStore();
        if (params.direction !== "input" && params.direction !== "output") {
            throw new BridgeError(
                "BAD_PARAMS",
                'direction must be "input" or "output".'
            );
        }
        const comp = resolveObject(store, params.objID);
        const arr: any[] =
            params.direction === "output"
                ? comp.customOutputs || []
                : comp.customInputs || [];
        const portObj = arr.find((p: any) => p.name === params.port);
        if (!portObj) {
            throw new BridgeError(
                "NOT_FOUND",
                `No custom ${params.direction} port "${params.port}".`
            );
        }
        // Deleting a CustomInput/Output fires deleteObjectRefHook which removes
        // every wire attached to that port; combine so it is ONE undo step.
        const um = store.undoManager;
        um.setCombineCommands(true);
        try {
            store.deleteObject(portObj);
        } finally {
            um.setCombineCommands(false);
        }
        return { objID: comp.objID, deleted: params.port };
    },

    // --- Flow-type widget event handler ------------------------------------

    bind_flow_event(params: any) {
        const store = requireProjectStore();
        if (!params.event) {
            throw new BridgeError("BAD_PARAMS", "event is required.");
        }
        const widget = resolveObject(store, params.objID);
        if (!Array.isArray(widget.eventHandlers)) {
            throw new BridgeError(
                "BAD_PARAMS",
                "Object is not a widget with event handlers."
            );
        }
        // Idempotent: if a flow-type handler for this event already exists,
        // return its already-connectable output port name.
        const existing = widget.eventHandlers.find(
            (h: any) =>
                h.eventName === params.event && h.handlerType === "flow"
        );
        if (existing) {
            return { objID: widget.objID, output: params.event };
        }
        const eh = createObject(
            store,
            {
                eventName: params.event,
                handlerType: "flow",
                userData: params.userData ?? 0
            } as any,
            EventHandler
        ) as any;
        store.addObject(widget.eventHandlers, eh);
        return { objID: widget.objID, output: params.event };
    }
};

/** getLabel can throw for partially-resolved objects; guard it. */
function safeLabel(obj: any): string | null {
    try {
        return getLabel(obj);
    } catch (e) {
        return null;
    }
}
