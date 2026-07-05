"use strict";
// Project-level asset collections (reusable styles, user actions, theme colors,
// global variables) mapped onto EEZ's real ProjectStore command/undo API.
// Every mutation goes through addObject/updateObject/deleteObject so the GUI,
// undo/redo, validation and codegen stay consistent — exactly like handlers.ts.
// Collections here are name-keyed and referenced by name (useStyle,
// EventHandler.action, themed-color name, variable name), so these tools resolve
// by name via resolveByName/assertNameFree + the project* getters.
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectEntitiesHandlers = void 0;
const store_1 = require("project-editor/store");
const style_catalog_1 = require("project-editor/lvgl/style-catalog");
const style_1 = require("project-editor/lvgl/style");
const action_1 = require("project-editor/features/action/action");
const theme_1 = require("project-editor/features/style/theme");
const variable_1 = require("project-editor/features/variable/variable");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
const DEFAULT_PART = "MAIN";
const DEFAULT_STATE = "DEFAULT";
/**
 * Apply one or more style-property cells onto a reusable style's inner
 * LVGLStylesDefinition, as a single undo step. Mirrors the local-style set_style
 * handler and LVGLStylesDefinitionProperty's addPropertyToDefinition usage.
 */
function applyStyleValues(store, style, part, state, values) {
    for (const prop of Object.keys(values)) {
        if (!style_catalog_1.lvglPropertiesMap.get(prop)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown style property "${prop}".`);
        }
    }
    const def = style.definition; // LVGLStylesDefinition
    store.undoManager.setCombineCommands(true);
    try {
        for (const prop of Object.keys(values)) {
            const propInfo = style_catalog_1.lvglPropertiesMap.get(prop);
            const newInner = def.addPropertyToDefinition(propInfo, part, state, values[prop]);
            store.updateObject(def, { definition: newInner });
        }
    }
    finally {
        store.undoManager.setCombineCommands(false);
    }
}
exports.projectEntitiesHandlers = {
    // --- Actions -------------------------------------------------------------
    create_action(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectActions)(store), params.name, "action");
        const hasFlow = !!store.projectTypeTraits?.hasFlowSupport;
        const implementationType = params.implementationType ?? (hasFlow ? "flow" : "native");
        const seed = { name: params.name, implementationType };
        // For flow projects an Action carries the Flow child arrays; for LVGL
        // no-flow they are omitted (the action is native/implemented in C).
        if (hasFlow) {
            seed.components = [];
            seed.connectionLines = [];
            seed.localVariables = [];
        }
        const action = (0, store_1.createObject)(store, seed, action_1.Action);
        store.addObject(store.project.actions, action);
        return { name: action.name };
    },
    delete_action(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const action = (0, project_access_1.resolveByName)((0, project_access_1.projectActions)(store), params.name, "action");
        store.deleteObject(action);
        return { deleted: params.name };
    },
    // --- Reusable LVGL styles ------------------------------------------------
    create_style(params) {
        const store = (0, project_access_1.requireLvglStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectStyles)(store), params.name, "style");
        const seed = {
            name: params.name,
            forWidgetType: params.forWidgetType ?? "LVGLPanelWidget",
            childStyles: [],
            definition: {} // loaded into an LVGLStylesDefinition with {} inner
        };
        const style = (0, store_1.createObject)(store, seed, style_1.LVGLStyle);
        store.addObject(store.project.lvglStyles.styles, style);
        // Optional initial cells: { values } applied at MAIN/DEFAULT in the same
        // undo step is not possible across two commands cleanly, so apply after
        // add (still correct; add is the anchor). Wrap in a combine.
        if (params.values && typeof params.values === "object") {
            applyStyleValues(store, style, params.part ?? DEFAULT_PART, params.state ?? DEFAULT_STATE, params.values);
        }
        return { name: style.name };
    },
    update_style(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const style = (0, project_access_1.resolveByName)((0, project_access_1.projectStyles)(store), params.name, "style");
        if (!params.values || typeof params.values !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "values{} is required.");
        }
        applyStyleValues(store, style, params.part ?? DEFAULT_PART, params.state ?? DEFAULT_STATE, params.values);
        return { name: style.name };
    },
    delete_style(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const style = (0, project_access_1.resolveByName)((0, project_access_1.projectStyles)(store), params.name, "style");
        store.deleteObject(style);
        return { deleted: params.name };
    },
    // --- Theme colors --------------------------------------------------------
    list_colors() {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        const themes = project.themes || [];
        // Value reported for the first theme (the palette's canonical value),
        // matching the { name, value } protocol shape.
        const firstTheme = themes[0];
        return {
            colors: (0, project_access_1.projectColors)(store).map((c) => ({
                name: c.name,
                value: firstTheme
                    ? project.getThemeColor(firstTheme.objID, c.objID)
                    : "#000000"
            }))
        };
    },
    add_color(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectColors)(store), params.name, "color");
        store.undoManager.setCombineCommands(true);
        try {
            const colorSeed = { name: params.name };
            const color = (0, store_1.createObject)(store, colorSeed, theme_1.Color);
            const added = store.addObject(project.colors, color);
            // Seed the new color slot in every theme (default black or value).
            const value = params.value ?? "#000000";
            for (const theme of project.themes || []) {
                project.setThemeColor(theme.objID, added.objID, value);
            }
            return { name: added.name };
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
    },
    update_color(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        const color = (0, project_access_1.resolveByName)((0, project_access_1.projectColors)(store), params.name, "color");
        if (typeof params.value !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "value (string) is required.");
        }
        const idx = (project.colors || []).indexOf(color);
        const themes = project.themes || [];
        if (themes.length === 0 || idx < 0) {
            throw new protocol_1.BridgeError("NOT_FOUND", "No theme to set the color on.");
        }
        // Set the value in every theme via the undo-safe updateObject(theme,{colors})
        // path (ColorItem.onChange precedent), as one undo step.
        store.undoManager.setCombineCommands(true);
        try {
            for (const theme of themes) {
                const colors = theme.colors.slice();
                colors[idx] = params.value;
                store.updateObject(theme, { colors });
            }
            return { name: color.name };
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
    },
    delete_color(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const color = (0, project_access_1.resolveByName)((0, project_access_1.projectColors)(store), params.name, "color");
        store.deleteObject(color);
        return { deleted: params.name };
    },
    // --- Global variables ----------------------------------------------------
    list_variables() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            variables: (0, project_access_1.projectVariables)(store).map((v) => ({
                name: v.name,
                type: v.type,
                defaultValue: v.defaultValue
            }))
        };
    },
    add_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        if (!params.type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectVariables)(store), params.name, "variable");
        const seed = {
            name: params.name,
            type: params.type,
            persistent: false,
            native: false
        };
        if (params.defaultValue !== undefined) {
            seed.defaultValue = params.defaultValue;
        }
        const variable = (0, store_1.createObject)(store, seed, variable_1.Variable);
        store.addObject(store.project.variables.globalVariables, variable);
        return { name: variable.name };
    },
    update_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const variable = (0, project_access_1.resolveByName)((0, project_access_1.projectVariables)(store), params.name, "variable");
        const props = params.props;
        if (!props || typeof props !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "props{} is required.");
        }
        // Renaming a variable requires updating every by-name reference
        // (replaceObjectReference) to avoid dangling bindings — not supported here.
        if ("name" in props && props.name !== variable.name) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Renaming a variable is not supported (by-name references would dangle; needs replaceObjectReference).");
        }
        store.updateObject(variable, props);
        return { name: variable.name };
    },
    delete_variable(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const variable = (0, project_access_1.resolveByName)((0, project_access_1.projectVariables)(store), params.name, "variable");
        store.deleteObject(variable);
        return { deleted: params.name };
    }
};
