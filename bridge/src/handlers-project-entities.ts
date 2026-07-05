// Project-level asset collections (reusable styles, user actions, theme colors,
// global variables) mapped onto EEZ's real ProjectStore command/undo API.
// Every mutation goes through addObject/updateObject/deleteObject so the GUI,
// undo/redo, validation and codegen stay consistent — exactly like handlers.ts.
// Collections here are name-keyed and referenced by name (useStyle,
// EventHandler.action, themed-color name, variable name), so these tools resolve
// by name via resolveByName/assertNameFree + the project* getters.

import { createObject } from "project-editor/store";
import { lvglPropertiesMap } from "project-editor/lvgl/style-catalog";
import { LVGLStyle } from "project-editor/lvgl/style";
import { Action } from "project-editor/features/action/action";
import { Color } from "project-editor/features/style/theme";
import { Variable } from "project-editor/features/variable/variable";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    resolveByName,
    assertNameFree,
    projectStyles,
    projectActions,
    projectColors,
    projectVariables
} from "mcp-bridge/project-access";

const DEFAULT_PART = "MAIN";
const DEFAULT_STATE = "DEFAULT";

/**
 * Apply one or more style-property cells onto a reusable style's inner
 * LVGLStylesDefinition, as a single undo step. Mirrors the local-style set_style
 * handler and LVGLStylesDefinitionProperty's addPropertyToDefinition usage.
 */
function applyStyleValues(
    store: any,
    style: any,
    part: string,
    state: string,
    values: Record<string, any>
): void {
    for (const prop of Object.keys(values)) {
        if (!lvglPropertiesMap.get(prop)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown style property "${prop}".`
            );
        }
    }
    const def: any = style.definition; // LVGLStylesDefinition
    store.undoManager.setCombineCommands(true);
    try {
        for (const prop of Object.keys(values)) {
            const propInfo: any = lvglPropertiesMap.get(prop);
            const newInner = def.addPropertyToDefinition(
                propInfo,
                part,
                state,
                values[prop]
            );
            store.updateObject(def, { definition: newInner });
        }
    } finally {
        store.undoManager.setCombineCommands(false);
    }
}

export const projectEntitiesHandlers: Record<string, Handler> = {
    // --- Actions -------------------------------------------------------------

    create_action(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectActions(store), params.name, "action");

        const hasFlow: boolean = !!store.projectTypeTraits?.hasFlowSupport;
        const implementationType: string =
            params.implementationType ?? (hasFlow ? "flow" : "native");
        const seed: any = { name: params.name, implementationType };
        // For flow projects an Action carries the Flow child arrays; for LVGL
        // no-flow they are omitted (the action is native/implemented in C).
        if (hasFlow) {
            seed.components = [];
            seed.connectionLines = [];
            seed.localVariables = [];
        }
        const action: any = createObject(store, seed, Action);
        store.addObject(store.project.actions, action);
        return { name: action.name };
    },

    delete_action(params: any) {
        const store = requireProjectStore();
        const action = resolveByName(
            projectActions(store),
            params.name,
            "action"
        );
        store.deleteObject(action);
        return { deleted: params.name };
    },

    // --- Reusable LVGL styles ------------------------------------------------

    create_style(params: any) {
        const store = requireLvglStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectStyles(store), params.name, "style");

        const seed: any = {
            name: params.name,
            forWidgetType: params.forWidgetType ?? "LVGLPanelWidget",
            childStyles: [],
            definition: {} // loaded into an LVGLStylesDefinition with {} inner
        };
        const style: any = createObject(store, seed, LVGLStyle);
        store.addObject(store.project.lvglStyles.styles, style);

        // Optional initial cells: { values } applied at MAIN/DEFAULT in the same
        // undo step is not possible across two commands cleanly, so apply after
        // add (still correct; add is the anchor). Wrap in a combine.
        if (params.values && typeof params.values === "object") {
            applyStyleValues(
                store,
                style,
                params.part ?? DEFAULT_PART,
                params.state ?? DEFAULT_STATE,
                params.values
            );
        }
        return { name: style.name };
    },

    update_style(params: any) {
        const store = requireProjectStore();
        const style = resolveByName(
            projectStyles(store),
            params.name,
            "style"
        );
        if (!params.values || typeof params.values !== "object") {
            throw new BridgeError("BAD_PARAMS", "values{} is required.");
        }
        applyStyleValues(
            store,
            style,
            params.part ?? DEFAULT_PART,
            params.state ?? DEFAULT_STATE,
            params.values
        );
        return { name: style.name };
    },

    delete_style(params: any) {
        const store = requireProjectStore();
        const style = resolveByName(
            projectStyles(store),
            params.name,
            "style"
        );
        store.deleteObject(style);
        return { deleted: params.name };
    },

    // --- Theme colors --------------------------------------------------------

    list_colors() {
        const store = requireProjectStore();
        const project = store.project;
        const themes: any[] = project.themes || [];
        // Value reported for the first theme (the palette's canonical value),
        // matching the { name, value } protocol shape.
        const firstTheme = themes[0];
        return {
            colors: projectColors(store).map((c: any) => ({
                name: c.name,
                value: firstTheme
                    ? project.getThemeColor(firstTheme.objID, c.objID)
                    : "#000000"
            }))
        };
    },

    add_color(params: any) {
        const store = requireProjectStore();
        const project = store.project;
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectColors(store), params.name, "color");

        store.undoManager.setCombineCommands(true);
        try {
            const colorSeed: any = { name: params.name };
            const color: any = createObject(store, colorSeed, Color);
            const added: any = store.addObject(project.colors, color);
            // Seed the new color slot in every theme (default black or value).
            const value: string = params.value ?? "#000000";
            for (const theme of project.themes || []) {
                project.setThemeColor(theme.objID, added.objID, value);
            }
            return { name: added.name };
        } finally {
            store.undoManager.setCombineCommands(false);
        }
    },

    update_color(params: any) {
        const store = requireProjectStore();
        const project = store.project;
        const color = resolveByName(
            projectColors(store),
            params.name,
            "color"
        );
        if (typeof params.value !== "string") {
            throw new BridgeError("BAD_PARAMS", "value (string) is required.");
        }
        const idx: number = (project.colors || []).indexOf(color);
        const themes: any[] = project.themes || [];
        if (themes.length === 0 || idx < 0) {
            throw new BridgeError("NOT_FOUND", "No theme to set the color on.");
        }
        // Set the value in every theme via the undo-safe updateObject(theme,{colors})
        // path (ColorItem.onChange precedent), as one undo step.
        store.undoManager.setCombineCommands(true);
        try {
            for (const theme of themes) {
                const colors: any[] = theme.colors.slice();
                colors[idx] = params.value;
                store.updateObject(theme, { colors });
            }
            return { name: color.name };
        } finally {
            store.undoManager.setCombineCommands(false);
        }
    },

    delete_color(params: any) {
        const store = requireProjectStore();
        const color = resolveByName(
            projectColors(store),
            params.name,
            "color"
        );
        store.deleteObject(color);
        return { deleted: params.name };
    },

    // --- Global variables ----------------------------------------------------

    list_variables() {
        const store = requireProjectStore();
        return {
            variables: projectVariables(store).map((v: any) => ({
                name: v.name,
                type: v.type,
                defaultValue: v.defaultValue
            }))
        };
    },

    add_variable(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        if (!params.type) {
            throw new BridgeError("BAD_PARAMS", "type is required.");
        }
        assertNameFree(projectVariables(store), params.name, "variable");

        const seed: any = {
            name: params.name,
            type: params.type,
            persistent: false,
            native: false
        };
        if (params.defaultValue !== undefined) {
            seed.defaultValue = params.defaultValue;
        }
        const variable: any = createObject(store, seed, Variable);
        store.addObject(store.project.variables.globalVariables, variable);
        return { name: variable.name };
    },

    update_variable(params: any) {
        const store = requireProjectStore();
        const variable = resolveByName(
            projectVariables(store),
            params.name,
            "variable"
        );
        const props: any = params.props;
        if (!props || typeof props !== "object") {
            throw new BridgeError("BAD_PARAMS", "props{} is required.");
        }
        // Renaming a variable requires updating every by-name reference
        // (replaceObjectReference) to avoid dangling bindings — not supported here.
        if ("name" in props && props.name !== variable.name) {
            throw new BridgeError(
                "UNSUPPORTED",
                "Renaming a variable is not supported (by-name references would dangle; needs replaceObjectReference)."
            );
        }
        store.updateObject(variable, props);
        return { name: variable.name };
    },

    delete_variable(params: any) {
        const store = requireProjectStore();
        const variable = resolveByName(
            projectVariables(store),
            params.name,
            "variable"
        );
        store.deleteObject(variable);
        return { deleted: params.name };
    }
};
