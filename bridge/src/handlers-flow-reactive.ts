// Reactive LVGL widget flags/states (expression-bindable counterparts of the static
// widgetFlags/states strings) + flow-graph inspection helpers.
//
// - set_reactive_flag / set_reactive_state: plain `updateObject` writes of the value
//   prop AND its `<name>Type` sibling (one undo step), mirroring update_widget.
//   Only HIDDEN/CLICKABLE (flags) and CHECKED/DISABLED (states) have reactive props
//   (LVGLWidget base, Base.tsx:569-582). *Type may only be "literal" | "expression".
// - render_flow: the flow editor is an SVG DOM, NOT an LVGL-WASM canvas, so there is
//   no rasterizer. Return the wire-graph (components + connectionLines) as data.
// - find_component: resolve a build-time {flowIndex.componentIndex} to a live object
//   via the assets map (store.buildAssets() -> flows[fi].components[ci].path ->
//   getObjectFromStringPath -> objID). Build-dependent; degrades to {found:false}.

import { getObjectFromStringPath, getLabel } from "project-editor/store";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    resolveObject,
    resolveFlow
} from "mcp-bridge/project-access";

// Only these two flags have reactive (expression-bindable) counterparts.
const FLAG_PROP: Record<string, string> = {
    HIDDEN: "hiddenFlag",
    CLICKABLE: "clickableFlag"
};

// Only these two states have reactive (expression-bindable) counterparts.
const STATE_PROP: Record<string, string> = {
    CHECKED: "checkedState",
    DISABLED: "disabledState"
};

// The only legal `<name>Type` values (types array in makeLvglExpressionProperty).
const LEGAL_TYPES = ["literal", "expression"];

function normalizeType(type: any): string {
    const t = type ?? "literal";
    if (t !== "literal" && t !== "expression") {
        throw new BridgeError(
            "BAD_PARAMS",
            `type must be one of ${LEGAL_TYPES.join(", ")}, got "${t}".`
        );
    }
    return t;
}

function assertExpressionValue(type: string, value: any): void {
    if (type === "expression" && typeof value !== "string") {
        throw new BridgeError(
            "BAD_PARAMS",
            "expression value must be a string (an EEZ expression)."
        );
    }
}

function safe(fn: () => string): string | undefined {
    try {
        return fn();
    } catch (e) {
        return undefined;
    }
}

export const flowReactiveHandlers: Record<string, Handler> = {
    // Bind (or literal-set) a reactive widget flag: HIDDEN or CLICKABLE.
    // Writes { <prop>: value, <prop>Type: type } in one updateObject = one undo step.
    // type "literal" => value is a boolean; type "expression" => value is a string.
    set_reactive_flag(params: any) {
        const store = requireLvglStore();
        const widget = resolveObject(store, params.objID);

        const prop = FLAG_PROP[params.flag];
        if (!prop) {
            throw new BridgeError(
                "BAD_PARAMS",
                `flag must be HIDDEN or CLICKABLE, got "${params.flag}".`
            );
        }

        const type = normalizeType(params.type);
        assertExpressionValue(type, params.value);

        store.updateObject(widget, {
            [prop]: params.value,
            [prop + "Type"]: type
        } as any);

        return { objID: widget.objID };
    },

    // Bind (or literal-set) a reactive widget state: CHECKED or DISABLED.
    // CHECKED is an "assignable" property — an expression binding must reference a
    // writable lvalue (variable/struct field); the bridge passes it through as-is.
    set_reactive_state(params: any) {
        const store = requireLvglStore();
        const widget = resolveObject(store, params.objID);

        const prop = STATE_PROP[params.state];
        if (!prop) {
            throw new BridgeError(
                "BAD_PARAMS",
                `state must be CHECKED or DISABLED, got "${params.state}".`
            );
        }

        const type = normalizeType(params.type);
        assertExpressionValue(type, params.value);

        store.updateObject(widget, {
            [prop]: params.value,
            [prop + "Type"]: type
        } as any);

        return { objID: widget.objID };
    },

    // The flow editor is an SVG DOM (flow/editor/render.tsx), not an LVGL-WASM 2D
    // canvas, so there is no framebuffer to rasterize. Return the wire-graph as data:
    // component nodes + connection lines (source/output/target/input port wiring).
    render_flow(params: any) {
        const store = requireProjectStore();
        const flow = resolveFlow(store, {
            page: params.page,
            action: params.action
        });

        const components = (flow.components || []).map((c: any) => ({
            objID: c.objID,
            type: c.type,
            left: c.left,
            top: c.top,
            width: c.width,
            height: c.height,
            label: safe(() => getLabel(c))
        }));

        const connectionLines = (flow.connectionLines || []).map((l: any) => ({
            source: l.source,
            output: l.output,
            target: l.target,
            input: l.input
        }));

        return {
            components,
            connectionLines,
            note:
                "flow canvas has no rasterizer; returning the wire-graph as data"
        };
    },

    // Resolve a build-time component index pair "flowIndex.componentIndex" to a live
    // object. Indices are build artifacts, so run an in-memory build and read the
    // assets map's stored .path, then getObjectFromStringPath -> objID. If the build
    // map is unavailable (build errors, stale/out-of-range indices) return found:false.
    async find_component(params: any) {
        const store = requireProjectStore();

        const raw = String(params.componentPath ?? "");
        const m = raw.match(/^(\d+)\.(\d+)$/);
        if (!m) {
            throw new BridgeError(
                "BAD_PARAMS",
                `componentPath must be "flowIndex.componentIndex", got "${raw}".`
            );
        }
        const flowIndex = Number(m[1]);
        const componentIndex = Number(m[2]);

        // buildAssets records errors into Section.OUTPUT (does not throw); may be
        // undefined on failure. GUI_ASSETS_DATA_MAP_JS is a plain object.
        const parts: any = await store.buildAssets();
        const map: any = parts?.GUI_ASSETS_DATA_MAP_JS;
        if (!map) {
            return { found: false, objID: null };
        }

        const flowMap: any = map.flows?.[flowIndex];
        const compMap: any = flowMap?.components?.[componentIndex];
        if (!compMap?.path) {
            return { found: false, objID: null };
        }

        const obj: any = getObjectFromStringPath(store.project, compMap.path);
        if (!obj || !obj.objID) {
            return { found: false, objID: null };
        }

        // Select it in the editor (navigation side-effect only, no undo entry).
        try {
            store.navigationStore.showObjects([obj], true, true, true);
        } catch (e) {
            // Selection is best-effort; resolution already succeeded.
        }

        return { found: true, objID: obj.objID };
    }
};
