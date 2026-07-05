"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowConnectionsHandlers = void 0;
const store_1 = require("project-editor/store");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const connection_line_1 = require("project-editor/flow/connection-line");
const component_1 = require("project-editor/flow/component");
const helper_1 = require("project-editor/flow/helper");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
/** Resolve a component by objID and confirm it exposes flow port getters. */
function resolveComponent(store, objID) {
    const comp = (0, project_access_1.resolveObject)(store, objID);
    if (!Array.isArray(comp.inputs) || !Array.isArray(comp.outputs)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Object "${objID}" is not a flow component.`);
    }
    return comp;
}
exports.flowConnectionsHandlers = {
    // --- Connections --------------------------------------------------------
    connect_components(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.output || !params.input) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "source, output, target and input are all required.");
        }
        const src = resolveComponent(store, params.source);
        const tgt = resolveComponent(store, params.target);
        const flow = project_editor_interface_1.ProjectEditor.getFlow(src);
        const tgtFlow = project_editor_interface_1.ProjectEditor.getFlow(tgt);
        if (!flow || flow !== tgtFlow) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Source and target must live in the same flow (page or action).");
        }
        // Validate ports against the merged getters (include @seqin/@seqout).
        if (!src.outputs.find((o) => o.name === params.output)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `No output "${params.output}" on source component.`);
        }
        if (!tgt.inputs.find((i) => i.name === params.input)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `No input "${params.input}" on target component.`);
        }
        // Reject exact duplicate wire (EEZ warns on dupes).
        const lines = flow.connectionLines || [];
        const dup = lines.find((l) => l.source === src.objID &&
            l.output === params.output &&
            l.target === tgt.objID &&
            l.input === params.input);
        if (dup) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "An identical connection already exists.");
        }
        const seed = {
            source: src.objID,
            output: params.output,
            target: tgt.objID,
            input: params.input
        };
        const line = (0, store_1.createObject)(store, seed, connection_line_1.ConnectionLine);
        store.addObject(flow.connectionLines, line);
        return { objID: line.objID };
    },
    disconnect_components(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (params.objID) {
            const line = (0, project_access_1.resolveObject)(store, params.objID);
            store.deleteObject(line);
            return { deleted: params.objID };
        }
        if (!params.source || !params.target || !params.output || !params.input) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Provide objID, or source+output+target+input to match a connection.");
        }
        const src = resolveComponent(store, params.source);
        const tgt = resolveComponent(store, params.target);
        const flow = project_editor_interface_1.ProjectEditor.getFlow(src);
        const lines = (flow && flow.connectionLines) || [];
        const line = lines.find((l) => l.source === src.objID &&
            l.output === params.output &&
            l.target === tgt.objID &&
            l.input === params.input);
        if (!line) {
            throw new protocol_1.BridgeError("NOT_FOUND", "No matching connection.");
        }
        store.deleteObject(line);
        return { deleted: line.objID };
    },
    list_flow_connections(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const flow = (0, project_access_1.resolveFlow)(store, params);
        const lines = flow.connectionLines || [];
        const connections = lines.map((l) => {
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
                outputLabel: (0, helper_1.getOutputDisplayName)(srcComp, l.output),
                inputLabel: (0, helper_1.getInputDisplayName)(tgtComp, l.input)
            };
        });
        return { connections };
    },
    update_flow_connection(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const line = (0, project_access_1.resolveObject)(store, params.objID);
        const props = {};
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
    add_component_input(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name || !params.type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name and type are required.");
        }
        const comp = resolveComponent(store, params.objID);
        if (!Array.isArray(comp.customInputs)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Component does not support custom inputs.");
        }
        if (comp.inputs.find((i) => i.name === params.name)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Input "${params.name}" already exists.`);
        }
        const ci = (0, store_1.createObject)(store, { name: params.name, type: params.type }, component_1.CustomInput);
        store.addObject(comp.customInputs, ci);
        return { objID: comp.objID, input: params.name };
    },
    add_component_output(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name || !params.type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name and type are required.");
        }
        const comp = resolveComponent(store, params.objID);
        if (!Array.isArray(comp.customOutputs)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Component does not support custom outputs.");
        }
        if (comp.outputs.find((o) => o.name === params.name)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Output "${params.name}" already exists.`);
        }
        const co = (0, store_1.createObject)(store, { name: params.name, type: params.type }, component_1.CustomOutput);
        store.addObject(comp.customOutputs, co);
        return { objID: comp.objID, output: params.name };
    },
    delete_component_port(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (params.direction !== "input" && params.direction !== "output") {
            throw new protocol_1.BridgeError("BAD_PARAMS", 'direction must be "input" or "output".');
        }
        const comp = (0, project_access_1.resolveObject)(store, params.objID);
        const arr = params.direction === "output"
            ? comp.customOutputs || []
            : comp.customInputs || [];
        const portObj = arr.find((p) => p.name === params.port);
        if (!portObj) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No custom ${params.direction} port "${params.port}".`);
        }
        // Deleting a CustomInput/Output fires deleteObjectRefHook which removes
        // every wire attached to that port; combine so it is ONE undo step.
        const um = store.undoManager;
        um.setCombineCommands(true);
        try {
            store.deleteObject(portObj);
        }
        finally {
            um.setCombineCommands(false);
        }
        return { objID: comp.objID, deleted: params.port };
    },
    // --- Flow-type widget event handler ------------------------------------
    bind_flow_event(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.event) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "event is required.");
        }
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        if (!Array.isArray(widget.eventHandlers)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Object is not a widget with event handlers.");
        }
        // Idempotent: if a flow-type handler for this event already exists,
        // return its already-connectable output port name.
        const existing = widget.eventHandlers.find((h) => h.eventName === params.event && h.handlerType === "flow");
        if (existing) {
            return { objID: widget.objID, output: params.event };
        }
        const eh = (0, store_1.createObject)(store, {
            eventName: params.event,
            handlerType: "flow",
            userData: params.userData ?? 0
        }, component_1.EventHandler);
        store.addObject(widget.eventHandlers, eh);
        return { objID: widget.objID, output: params.event };
    }
};
/** getLabel can throw for partially-resolved objects; guard it. */
function safeLabel(obj) {
    try {
        return (0, store_1.getLabel)(obj);
    }
    catch (e) {
        return null;
    }
}
