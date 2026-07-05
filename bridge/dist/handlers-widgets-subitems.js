"use strict";
// LVGL widget SUB-ITEM handlers: array children of a widget that are plain
// EezObjects (NOT LVGLWidgets) and therefore cannot be created via create_widget —
// button-matrix buttons, meter indicators, meter scales, scale sections, spangroup
// spans. All mutations go through the ProjectStore command API so the GUI, undo/redo,
// validation and codegen stay consistent (exactly like handlers.ts).
//
// Non-exported sub-item classes (LVGLMatrixButton, LVGLMeterScale) are resolved via
// the parent widget's array PropertyInfo.typeClass rather than imported. The uniform
// typeClass route is used for every add-tool so nothing needs a direct class import.
Object.defineProperty(exports, "__esModule", { value: true });
exports.widgetsSubitemsHandlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- helpers ---------------------------------------------------------------
/** The registered class name of an EEZ object (e.g. "LVGLButtonMatrixWidget"). */
function className(obj) {
    return object_1.eezClassToClassNameMap.get((0, object_1.getClass)(obj)) ?? "";
}
/** Resolve the constructor of an array property's element type off the parent. */
function arrayTypeClass(parent, arrayProp) {
    const info = (0, object_1.findPropertyByNameInClassInfo)((0, store_1.getClassInfo)(parent), arrayProp);
    if (!info || !info.typeClass) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Widget has no "${arrayProp}" sub-item array.`);
    }
    return info.typeClass;
}
/** Clamp a requested insert index into [0, length]. */
function clampIndex(index, length) {
    return Math.max(0, Math.min(index, length));
}
/** Read the project's configured LVGL version (e.g. "8.4.0"). */
function lvglVersion(store) {
    return store.project?.settings?.general?.lvglVersion ?? "";
}
/**
 * Assert the resolved widget is of an expected registered class. Sub-item tools
 * target a specific widget kind; a mismatched objID must fail clearly rather than
 * splice into an unrelated array (or find no array at all).
 */
function assertWidgetClass(widget, expected) {
    if (className(widget) !== expected) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Expected a ${expected}, got ${className(widget) || "unknown object"}.`);
    }
}
/** Guard a version-specific widget kind; throw UNSUPPORTED on the wrong LVGL major. */
function assertVersionPrefix(store, prefix, feature) {
    const version = lvglVersion(store);
    if (!version.startsWith(prefix)) {
        throw new protocol_1.BridgeError("UNSUPPORTED", `${feature} requires LVGL ${prefix}x (project is ${version || "unknown"}).`);
    }
}
const BUTTON_MATRIX = "LVGLButtonMatrixWidget";
const METER = "LVGLMeterWidget";
const SCALE = "LVGLScaleWidget";
const SPAN_GROUP = "LVGLSpanWidget";
// The four registered meter-indicator classes, keyed by the `type` enum value.
const INDICATOR_CLASS_NAME = {
    NEEDLE_IMG: "LVGLMeterIndicatorNeedleImg",
    NEEDLE_LINE: "LVGLMeterIndicatorNeedleLine",
    SCALE_LINES: "LVGLMeterIndicatorScaleLines",
    ARC: "LVGLMeterIndicatorArc"
};
/**
 * Resolve the concrete meter-indicator class for a `type`. The abstract base
 * (`indicators` array typeClass) defines `classInfo.getClass(store, object)` that
 * dispatches on `object.type` and returns the concrete registered class — this is
 * exactly what EEZ's own "New indicator" handler uses. Verified signature:
 * Meter.tsx:66 `getClass(projectStore, object)` reads `object.type`.
 */
function indicatorClassForType(store, baseClass, type) {
    const name = INDICATOR_CLASS_NAME[type];
    if (!name) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown meter-indicator type "${type}". ` +
            `Expected one of ${Object.keys(INDICATOR_CLASS_NAME).join(", ")}.`);
    }
    // The abstract base's classInfo.getClass(store, {type}) dispatches on the string
    // `type` and returns the concrete registered class (Meter.tsx:65-76). Return it
    // directly — ClassInfo has no `.name` field, so do NOT try to re-verify by name.
    const getClassFn = baseClass?.classInfo?.getClass;
    if (typeof getClassFn === "function") {
        const concrete = getClassFn(store, { type });
        if (concrete) {
            return concrete;
        }
    }
    // Should not happen for a valid Meter widget; surface a clear error.
    throw new protocol_1.BridgeError("BAD_PARAMS", `Could not resolve indicator class for type "${type}".`);
}
// --- ButtonMatrix.buttons[] fields -----------------------------------------
const MATRIX_CTRL_FLAGS = [
    "ctrlHidden",
    "ctrlNoRepeat",
    "ctrlDisabled",
    "ctrlCheckable",
    "ctrlChecked",
    "ctrlClickTrig",
    "ctrlPopover",
    "ctrlRecolor",
    "ctrlCustom1",
    "ctrlCustom2"
];
/** Turn a { flagName: bool } ctrl map into validated boolean seed fields. */
function applyCtrlFlags(ctrl) {
    const out = {};
    if (!ctrl || typeof ctrl !== "object") {
        return out;
    }
    for (const key of Object.keys(ctrl)) {
        if (!MATRIX_CTRL_FLAGS.includes(key)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown button-matrix ctrl flag "${key}".`);
        }
        out[key] = !!ctrl[key];
    }
    return out;
}
/** Validate a button-matrix width is an integer in 1..7 (EEZ's own bound). */
function validateMatrixWidth(width) {
    if (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > 7) {
        throw new protocol_1.BridgeError("BAD_PARAMS", "Button-matrix width must be an integer between 1 and 7.");
    }
    return width;
}
exports.widgetsSubitemsHandlers = {
    // --- ButtonMatrix buttons ------------------------------------------------
    add_matrix_button(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, BUTTON_MATRIX);
        const ButtonClass = arrayTypeClass(widget, "buttons");
        let seed;
        if (params.newLine) {
            // A line-break separator: text/width/ctrl are hidden for newLine rows.
            seed = { newLine: true };
        }
        else {
            const width = validateMatrixWidth(params.width ?? 1);
            seed = {
                newLine: false,
                text: params.text ?? "Btn",
                width,
                ...applyCtrlFlags(params.ctrl)
            };
        }
        const btn = (0, store_1.createObject)(store, seed, ButtonClass);
        const buttons = widget.buttons;
        if (typeof params.index === "number") {
            store.insertObject(buttons, clampIndex(params.index, buttons.length), btn);
        }
        else {
            store.addObject(buttons, btn);
        }
        return { objID: widget.objID, buttonIndex: buttons.indexOf(btn) };
    },
    update_matrix_button(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, BUTTON_MATRIX);
        if (typeof params.index !== "number") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "index (number) is required.");
        }
        const btn = widget.buttons[params.index];
        if (!btn) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No button at index ${params.index}.`);
        }
        const props = params.props;
        if (!props || typeof props !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "props{} is required.");
        }
        // Validate the fields the boundary cares about; unknown props are dropped
        // by updateObject's property filter anyway.
        if (props.width !== undefined) {
            validateMatrixWidth(props.width);
        }
        for (const key of Object.keys(props)) {
            if (key.startsWith("ctrl") && !MATRIX_CTRL_FLAGS.includes(key)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown button-matrix ctrl flag "${key}".`);
            }
        }
        store.updateObject(btn, props);
        return { objID: widget.objID, index: params.index };
    },
    // --- Meter indicators (LVGL 8.x) ----------------------------------------
    add_meter_indicator(params) {
        const store = (0, project_access_1.requireLvglStore)();
        assertVersionPrefix(store, "8.", "Meter indicators");
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, METER);
        const scaleIndex = params.scaleIndex ?? 0;
        const scale = widget.scales?.[scaleIndex];
        if (!scale) {
            throw new protocol_1.BridgeError("NOT_FOUND", `Meter has no scale at index ${scaleIndex}.`);
        }
        const type = params.type;
        if (!type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
        }
        const baseClass = arrayTypeClass(scale, "indicators");
        const TypeClass = indicatorClassForType(store, baseClass, type);
        // Seed = { type } merged with the concrete class defaultValue, then caller
        // props. `type` MUST be present for the getClass round-trip dispatch.
        const seed = Object.assign({ type }, TypeClass.classInfo?.defaultValue || {}, params.props || {});
        const ind = (0, store_1.createObject)(store, seed, TypeClass);
        const indicators = scale.indicators;
        if (typeof params.index === "number") {
            store.insertObject(indicators, clampIndex(params.index, indicators.length), ind);
        }
        else {
            store.addObject(indicators, ind);
        }
        return { objID: widget.objID, indicatorIndex: indicators.indexOf(ind) };
    },
    // --- Meter scales (LVGL 8.x) --------------------------------------------
    add_meter_scale(params) {
        const store = (0, project_access_1.requireLvglStore)();
        assertVersionPrefix(store, "8.", "Meter scales");
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, METER);
        const ScaleClass = arrayTypeClass(widget, "scales");
        // The scale defaultValue seeds ONE NEEDLE_LINE indicator; caller props can
        // override (e.g. { indicators: [] } for an empty scale).
        const seed = Object.assign({}, ScaleClass.classInfo?.defaultValue || {}, params.props || {});
        const scale = (0, store_1.createObject)(store, seed, ScaleClass);
        const scales = widget.scales;
        if (typeof params.index === "number") {
            store.insertObject(scales, clampIndex(params.index, scales.length), scale);
        }
        else {
            store.addObject(scales, scale);
        }
        return { objID: widget.objID, scaleIndex: scales.indexOf(scale) };
    },
    // --- Scale sections (LVGL 9.x) ------------------------------------------
    add_scale_section(params) {
        const store = (0, project_access_1.requireLvglStore)();
        assertVersionPrefix(store, "9.", "Scale sections");
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, SCALE);
        const SectionClass = arrayTypeClass(widget, "sections");
        const seed = Object.assign({}, SectionClass.classInfo?.defaultValue || {}, params.props || {});
        const section = (0, store_1.createObject)(store, seed, SectionClass);
        const sections = widget.sections;
        if (typeof params.index === "number") {
            store.insertObject(sections, clampIndex(params.index, sections.length), section);
        }
        else {
            store.addObject(sections, section);
        }
        return { objID: widget.objID, sectionIndex: sections.indexOf(section) };
    },
    // --- Spangroup spans (all LVGL versions) --------------------------------
    add_span(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertWidgetClass(widget, SPAN_GROUP);
        const SpanClass = arrayTypeClass(widget, "spans");
        const seed = Object.assign({}, SpanClass.classInfo?.defaultValue || {}, params.text != null ? { text: params.text, textType: "literal" } : {}, params.props || {});
        const span = (0, store_1.createObject)(store, seed, SpanClass);
        const spans = widget.spans;
        if (typeof params.index === "number") {
            store.insertObject(spans, clampIndex(params.index, spans.length), span);
        }
        else {
            store.addObject(spans, span);
        }
        return { objID: widget.objID, spanIndex: spans.indexOf(span) };
    },
    // --- Generic sub-item deletion ------------------------------------------
    delete_subitem(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const obj = (0, project_access_1.resolveObject)(store, params.objID);
        // Preferred path: objID resolves to the sub-item itself → delete directly.
        // A sub-item is an array element that is NOT one of the parent widget kinds.
        const objClass = className(obj);
        const isParentWidget = objClass === BUTTON_MATRIX ||
            objClass === METER ||
            objClass === SCALE ||
            objClass === SPAN_GROUP;
        if (!isParentWidget) {
            // The objID is the sub-item's own id — splice it out with one undo step.
            // A sub-item is an array element, so getParent(obj) is its containing
            // array; capture its index before deletion for the return shape.
            const container = (0, object_1.getParent)(obj);
            const index = Array.isArray(container) ? container.indexOf(obj) : -1;
            store.deleteObject(obj);
            return { deleted: true, objID: params.objID, index };
        }
        // Fallback path: objID is the PARENT widget → need kind + index.
        const kind = params.kind;
        if (!kind) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "kind is required when objID is the parent widget.");
        }
        if (typeof params.index !== "number") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "index (number) is required.");
        }
        const arr = subitemArrayByKind(obj, kind, params.scaleIndex ?? 0);
        const item = arr[params.index];
        if (!item) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No ${kind} at index ${params.index}.`);
        }
        store.deleteObject(item);
        return { deleted: true, objID: obj.objID, index: params.index };
    }
};
// --- delete_subitem support ------------------------------------------------
/** Select the sub-item array for a parent widget + kind (fallback delete path). */
function subitemArrayByKind(parent, kind, scaleIndex) {
    switch (kind) {
        case "button":
            assertWidgetClass(parent, BUTTON_MATRIX);
            return parent.buttons;
        case "indicator": {
            assertWidgetClass(parent, METER);
            const scale = parent.scales?.[scaleIndex];
            if (!scale) {
                throw new protocol_1.BridgeError("NOT_FOUND", `Meter has no scale at index ${scaleIndex}.`);
            }
            return scale.indicators;
        }
        case "scale":
            assertWidgetClass(parent, METER);
            return parent.scales;
        case "section":
            assertWidgetClass(parent, SCALE);
            return parent.sections;
        case "span":
            assertWidgetClass(parent, SPAN_GROUP);
            return parent.spans;
        default:
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown sub-item kind "${kind}". ` +
                "Expected button, indicator, scale, section or span.");
    }
}
