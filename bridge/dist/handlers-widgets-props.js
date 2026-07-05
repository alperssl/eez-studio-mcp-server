"use strict";
// Wave-2 LVGL widget-property handlers: flags, states, layout, scroll and
// grid-cell placement. All five edit an EXISTING widget resolved by objID.
//
// Widget-prop tools (set_flag/set_state/set_scroll) write plain string/enum props
// via updateObject(widget, {...}); layout/grid-cell tools write LOCAL-STYLE cells
// on widget.localStyles.definition[MAIN][DEFAULT] via a single
// updateObject(widget.localStyles, {definition}) — mirroring set_style in
// handlers.ts. Each tool issues exactly ONE updateObject == one undo step, so no
// setCombineCommands is needed. None of these touch cross-object references.
//
// Source-verified against studio/packages/project-editor/lvgl/*: flags/states pipe
// mechanics (Base.tsx:345-524), scroll enum id sets (Base.tsx:771-886), layout/grid
// style-cell names (style-catalog.tsx:539-937), set_style template (handlers.ts:260-296).
Object.defineProperty(exports, "__esModule", { value: true });
exports.widgetsPropsHandlers = void 0;
const style_catalog_1 = require("project-editor/lvgl/style-catalog");
const lvgl_versions_1 = require("project-editor/lvgl/lvgl-versions");
const lvgl_constants_1 = require("project-editor/lvgl/lvgl-constants");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
const STYLE_PART = "MAIN";
const STYLE_STATE = "DEFAULT";
// set_state may only carry the reactive-free base state tokens; CHECKED/DISABLED
// live on checkedState/disabledState props, EDITED/SCROLLED/USER* are style-cell
// states not `states`-string entries (report §2).
const VALID_STATE_TOKENS = ["FOCUSED", "FOCUS_KEY", "PRESSED", "HOVERED"];
// layout / flex / grid-align enum token sets (style-catalog.tsx:539-937).
const VALID_LAYOUTS = ["NONE", "FLEX", "GRID"];
const VALID_FLEX_FLOW = [
    "ROW",
    "COLUMN",
    "ROW_WRAP",
    "ROW_REVERSE",
    "ROW_WRAP_REVERSE",
    "COLUMN_WRAP",
    "COLUMN_REVERSE",
    "COLUMN_WRAP_REVERSE"
];
const VALID_FLEX_MAIN_PLACE = [
    "START",
    "END",
    "CENTER",
    "SPACE_EVENLY",
    "SPACE_AROUND",
    "SPACE_BETWEEN"
];
const VALID_FLEX_CROSS_PLACE = ["START", "END", "CENTER"];
const VALID_FLEX_TRACK_PLACE = VALID_FLEX_MAIN_PLACE;
const VALID_GRID_ALIGN = [
    "START",
    "CENTER",
    "END",
    "STRETCH",
    "SPACE_EVENLY",
    "SPACE_AROUND",
    "SPACE_BETWEEN"
];
// set_scroll widget-enum id sets — LOWERCASE ids (Base.tsx:771-886).
const VALID_SCROLLBAR_MODE = ["off", "on", "active", "auto"];
const VALID_SCROLL_DIRECTION = [
    "none",
    "top",
    "left",
    "bottom",
    "right",
    "hor",
    "ver",
    "all"
];
const VALID_SCROLL_SNAP = ["none", "start", "end", "center"];
/** Reject a value that is not in an allowed token/id set. */
function assertOneOf(value, allowed, label) {
    if (typeof value !== "string" || allowed.indexOf(value) === -1) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Invalid ${label} "${value}". Expected one of: ${allowed.join(", ")}.`);
    }
}
/** Guard every style-cell name against lvglPropertiesMap, exactly like set_style. */
function assertStyleProp(name) {
    if (!style_catalog_1.lvglPropertiesMap.get(name)) {
        throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown style property "${name}".`);
    }
}
/**
 * Toggle one pipe-delimited token on a widget string prop (widgetFlags/states),
 * writing the rebuilt string in a single updateObject. Mirrors the UI checkbox
 * add/remove logic (Base.tsx:345-524) with the trim-guard + dedupe + drop-empty
 * so no stray empty token survives.
 */
function togglePipeToken(store, widget, prop, token, on) {
    const raw = widget[prop] || "";
    const current = raw.trim() !== "" ? raw.split("|") : [];
    const arr = [];
    for (const t of current) {
        const trimmed = t.trim();
        if (trimmed !== "" && arr.indexOf(trimmed) === -1) {
            arr.push(trimmed);
        }
    }
    const idx = arr.indexOf(token);
    if (on && idx === -1) {
        arr.push(token);
    }
    else if (!on && idx !== -1) {
        arr.splice(idx, 1);
    }
    store.updateObject(widget, { [prop]: arr.join("|") });
    return widget[prop];
}
/**
 * Open a fresh, immutably-spread MAIN/DEFAULT style cell from the widget's local
 * styles so callers can write layout/grid props and commit with one updateObject.
 * Returns { ls, def, cell } — cell is def[MAIN][DEFAULT], safe to mutate before commit.
 */
function openLocalStyleCell(widget) {
    const ls = widget.localStyles;
    const def = { ...(ls.definition || {}) };
    def[STYLE_PART] = { ...(def[STYLE_PART] || {}) };
    def[STYLE_PART][STYLE_STATE] = { ...(def[STYLE_PART][STYLE_STATE] || {}) };
    return { ls, def, cell: def[STYLE_PART][STYLE_STATE] };
}
exports.widgetsPropsHandlers = {
    // --- set_flag ------------------------------------------------------------
    // widgetFlags pipe-string; reject reactive flags (HIDDEN/CLICKABLE) and any
    // flag not available for this widget's LVGL version (getLvglFlagCodes).
    set_flag(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const flag = params.flag;
        if (!flag || typeof flag !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "flag (string) is required.");
        }
        if (typeof params.on !== "boolean") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "on (boolean) is required.");
        }
        if (lvgl_constants_1.LVGL_REACTIVE_FLAGS.indexOf(flag) !== -1) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Flag "${flag}" is reactive and is not stored in widgetFlags; set it via update_widget {hiddenFlag|clickableFlag}.`);
        }
        const codes = (0, lvgl_versions_1.getLvglFlagCodes)(widget);
        if (Object.keys(codes).indexOf(flag) === -1) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Flag "${flag}" is not available for this widget/LVGL version.`);
        }
        const widgetFlags = togglePipeToken(store, widget, "widgetFlags", flag, params.on);
        return { objID: widget.objID, widgetFlags };
    },
    // --- set_state -----------------------------------------------------------
    // states pipe-string; accept ONLY FOCUSED/FOCUS_KEY/PRESSED/HOVERED.
    set_state(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        if (typeof params.on !== "boolean") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "on (boolean) is required.");
        }
        assertOneOf(params.state, VALID_STATE_TOKENS, "state");
        const states = togglePipeToken(store, widget, "states", params.state, params.on);
        return { objID: widget.objID, states };
    },
    // --- set_layout ----------------------------------------------------------
    // Local-style cells (MAIN/DEFAULT): layout + flex_* / grid_*_dsc_array, one
    // updateObject(localStyles). GRID auto-adds empty descriptor arrays if omitted.
    set_layout(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        assertOneOf(params.layout, VALID_LAYOUTS, "layout");
        const { ls, def, cell } = openLocalStyleCell(widget);
        assertStyleProp("layout");
        cell.layout = params.layout;
        if (params.layout === "FLEX") {
            if (params.flexFlow !== undefined) {
                assertOneOf(params.flexFlow, VALID_FLEX_FLOW, "flexFlow");
                assertStyleProp("flex_flow");
                cell.flex_flow = params.flexFlow;
            }
            if (params.flexMainPlace !== undefined) {
                assertOneOf(params.flexMainPlace, VALID_FLEX_MAIN_PLACE, "flexMainPlace");
                assertStyleProp("flex_main_place");
                cell.flex_main_place = params.flexMainPlace;
            }
            if (params.flexCrossPlace !== undefined) {
                assertOneOf(params.flexCrossPlace, VALID_FLEX_CROSS_PLACE, "flexCrossPlace");
                assertStyleProp("flex_cross_place");
                cell.flex_cross_place = params.flexCrossPlace;
            }
            if (params.flexTrackPlace !== undefined) {
                assertOneOf(params.flexTrackPlace, VALID_FLEX_TRACK_PLACE, "flexTrackPlace");
                assertStyleProp("flex_track_place");
                cell.flex_track_place = params.flexTrackPlace;
            }
        }
        if (params.layout === "GRID") {
            assertStyleProp("grid_column_dsc_array");
            assertStyleProp("grid_row_dsc_array");
            cell.grid_column_dsc_array =
                params.gridColumns ?? cell.grid_column_dsc_array ?? "";
            cell.grid_row_dsc_array =
                params.gridRows ?? cell.grid_row_dsc_array ?? "";
        }
        store.updateObject(ls, { definition: def });
        return { objID: widget.objID };
    },
    // --- set_scroll ----------------------------------------------------------
    // WIDGET enum props (NOT style cells): flagScrollbarMode/flagScrollDirection/
    // scrollSnapX/scrollSnapY. Enum ids are LOWERCASE. One updateObject(widget).
    set_scroll(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const props = {};
        if (params.scrollbarMode !== undefined) {
            assertOneOf(params.scrollbarMode, VALID_SCROLLBAR_MODE, "scrollbarMode");
            props.flagScrollbarMode = params.scrollbarMode;
        }
        if (params.scrollDirection !== undefined) {
            assertOneOf(params.scrollDirection, VALID_SCROLL_DIRECTION, "scrollDirection");
            props.flagScrollDirection = params.scrollDirection;
        }
        if (params.scrollSnapX !== undefined) {
            assertOneOf(params.scrollSnapX, VALID_SCROLL_SNAP, "scrollSnapX");
            props.scrollSnapX = params.scrollSnapX;
        }
        if (params.scrollSnapY !== undefined) {
            assertOneOf(params.scrollSnapY, VALID_SCROLL_SNAP, "scrollSnapY");
            props.scrollSnapY = params.scrollSnapY;
        }
        if (Object.keys(props).length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "At least one of scrollbarMode/scrollDirection/scrollSnapX/scrollSnapY is required.");
        }
        store.updateObject(widget, props);
        return { objID: widget.objID };
    },
    // --- set_grid_cell -------------------------------------------------------
    // Local-style cells on the CHILD widget (MAIN/DEFAULT): grid_cell_* props.
    // Positions/spans are numbers; aligns are token strings. One updateObject.
    set_grid_cell(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const { ls, def, cell } = openLocalStyleCell(widget);
        let wrote = false;
        if (params.colPos !== undefined) {
            assertStyleProp("grid_cell_column_pos");
            cell.grid_cell_column_pos = params.colPos;
            wrote = true;
        }
        if (params.colSpan !== undefined) {
            if (!Number.isInteger(params.colSpan) || params.colSpan < 1) {
                throw new protocol_1.BridgeError("BAD_PARAMS", "colSpan must be an integer >= 1.");
            }
            assertStyleProp("grid_cell_column_span");
            cell.grid_cell_column_span = params.colSpan;
            wrote = true;
        }
        if (params.xAlign !== undefined) {
            assertOneOf(params.xAlign, VALID_GRID_ALIGN, "xAlign");
            assertStyleProp("grid_cell_x_align");
            cell.grid_cell_x_align = params.xAlign;
            wrote = true;
        }
        if (params.rowPos !== undefined) {
            assertStyleProp("grid_cell_row_pos");
            cell.grid_cell_row_pos = params.rowPos;
            wrote = true;
        }
        if (params.rowSpan !== undefined) {
            if (!Number.isInteger(params.rowSpan) || params.rowSpan < 1) {
                throw new protocol_1.BridgeError("BAD_PARAMS", "rowSpan must be an integer >= 1.");
            }
            assertStyleProp("grid_cell_row_span");
            cell.grid_cell_row_span = params.rowSpan;
            wrote = true;
        }
        if (params.yAlign !== undefined) {
            assertOneOf(params.yAlign, VALID_GRID_ALIGN, "yAlign");
            assertStyleProp("grid_cell_y_align");
            cell.grid_cell_y_align = params.yAlign;
            wrote = true;
        }
        if (!wrote) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "At least one grid-cell property (colPos/colSpan/xAlign/rowPos/rowSpan/yAlign) is required.");
        }
        store.updateObject(ls, { definition: def });
        return { objID: widget.objID };
    }
};
