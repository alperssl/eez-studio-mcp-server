"use strict";
// LVGL focus-group and project-theme handlers, mapped onto EEZ's real
// ProjectStore command/undo API. Groups are LVGL-only (requireLvglStore); themes
// exist in every project type (requireProjectStore). Two correctness points drive
// this module (see research/source-v3/groups-themes.md):
//   1. A widget references its focus group by NAME STRING (widget.group, "" clears),
//      not by objID — so rename must rewrite those strings via replaceObjectReference
//      and delete leaves them dangling (matching EEZ's own delete behavior). The two
//      simulator-default strings on lvglGroups are plain strings (NOT object refs),
//      so replaceObjectReference never touches them — fix them manually.
//   2. Per-theme color VALUES are undo-tracked only through updateObject(theme,{colors})
//      (the `set colors` setter → setThemeColor); calling setThemeColor directly is not
//      recorded on the undo stack. set_active_theme is UI navigation state, not a
//      document command, so it is NOT wrapped in an undo combine.
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupsThemesHandlers = void 0;
const store_1 = require("project-editor/store");
const groups_1 = require("project-editor/lvgl/groups");
const theme_1 = require("project-editor/features/style/theme");
const search_1 = require("project-editor/core/search");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
exports.groupsThemesHandlers = {
    // --- LVGL focus groups ---------------------------------------------------
    list_groups() {
        const store = (0, project_access_1.requireLvglStore)();
        const g = store.project.lvglGroups;
        const enc = g.defaultGroupForEncoderInSimulator || "";
        const kbd = g.defaultGroupForKeyboardInSimulator || "";
        return {
            groups: (g.groups || []).map((x) => ({
                name: x.name,
                isEncoderDefault: x.name === enc,
                isKeyboardDefault: x.name === kbd
            })),
            defaultGroupForEncoderInSimulator: enc,
            defaultGroupForKeyboardInSimulator: kbd
        };
    },
    create_group(params) {
        const store = (0, project_access_1.requireLvglStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectGroups)(store), params.name, "group");
        const groupSeed = { name: params.name };
        const group = (0, store_1.createObject)(store, groupSeed, groups_1.LVGLGroup);
        store.addObject(store.project.lvglGroups.groups, group);
        return { name: group.name };
    },
    assign_widget_group(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        // widget.group is stored as the group NAME; "" clears. A non-empty name
        // must exist, else widget.check() would flag a missing group.
        if (params.group) {
            if (!(0, project_access_1.projectGroups)(store).some((x) => x.name === params.group)) {
                throw new protocol_1.BridgeError("NOT_FOUND", `No group named "${params.group}".`);
            }
        }
        const props = { group: params.group ?? "" };
        if (params.groupIndex !== undefined) {
            props.groupIndex = params.groupIndex;
        }
        store.updateObject(widget, props);
        return {
            objID: params.objID,
            group: widget.group,
            groupIndex: widget.groupIndex
        };
    },
    set_group_tab_order(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        if (params.groupIndex === undefined) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "groupIndex is required.");
        }
        store.updateObject(widget, { groupIndex: params.groupIndex });
        return { objID: params.objID, groupIndex: widget.groupIndex };
    },
    rename_group(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const group = (0, project_access_1.resolveByName)((0, project_access_1.projectGroups)(store), params.name, "group");
        if (!params.newName) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "newName is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectGroups)(store), params.newName, "group");
        const g = store.project.lvglGroups;
        store.undoManager.setCombineCommands(true);
        try {
            // Rebind widget.group name strings (referencedObjectCollectionPath
            // "lvglGroups/groups"), then rename the group object itself.
            (0, search_1.replaceObjectReference)(group, params.newName);
            store.updateObject(group, { name: params.newName });
            // The two simulator-default strings are plain strings, not object
            // references — replaceObjectReference won't touch them, so fix here.
            if (g.defaultGroupForEncoderInSimulator === params.name) {
                store.updateObject(g, {
                    defaultGroupForEncoderInSimulator: params.newName
                });
            }
            if (g.defaultGroupForKeyboardInSimulator === params.name) {
                store.updateObject(g, {
                    defaultGroupForKeyboardInSimulator: params.newName
                });
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { name: params.newName };
    },
    delete_group(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const group = (0, project_access_1.resolveByName)((0, project_access_1.projectGroups)(store), params.name, "group");
        const g = store.project.lvglGroups;
        store.undoManager.setCombineCommands(true);
        try {
            store.deleteObject(group);
            // Clear simulator defaults that pointed at the deleted group. Widget
            // .group name strings are left dangling (matches EEZ's own delete).
            if (g.defaultGroupForEncoderInSimulator === params.name) {
                store.updateObject(g, {
                    defaultGroupForEncoderInSimulator: ""
                });
            }
            if (g.defaultGroupForKeyboardInSimulator === params.name) {
                store.updateObject(g, {
                    defaultGroupForKeyboardInSimulator: ""
                });
            }
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { deleted: params.name };
    },
    set_group_defaults(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const g = store.project.lvglGroups;
        const props = {};
        if (params.encoderGroup !== undefined) {
            if (params.encoderGroup &&
                !(0, project_access_1.projectGroups)(store).some((x) => x.name === params.encoderGroup)) {
                throw new protocol_1.BridgeError("NOT_FOUND", `No group named "${params.encoderGroup}".`);
            }
            props.defaultGroupForEncoderInSimulator = params.encoderGroup;
        }
        if (params.keyboardGroup !== undefined) {
            if (params.keyboardGroup &&
                !(0, project_access_1.projectGroups)(store).some((x) => x.name === params.keyboardGroup)) {
                throw new protocol_1.BridgeError("NOT_FOUND", `No group named "${params.keyboardGroup}".`);
            }
            props.defaultGroupForKeyboardInSimulator = params.keyboardGroup;
        }
        if (Object.keys(props).length) {
            store.updateObject(g, props);
        }
        return {
            encoderGroup: g.defaultGroupForEncoderInSimulator || "",
            keyboardGroup: g.defaultGroupForKeyboardInSimulator || ""
        };
    },
    // --- Project themes ------------------------------------------------------
    list_themes() {
        const store = (0, project_access_1.requireProjectStore)();
        const themes = (0, project_access_1.projectThemes)(store);
        const sel = store.navigationStore?.selectedThemeObject.get();
        const active = sel || themes[0];
        return {
            themes: themes.map((t) => ({
                name: t.name,
                active: t === active
            }))
        };
    },
    create_theme(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (!params.name) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "name is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectThemes)(store), params.name, "theme");
        const project = store.project;
        store.undoManager.setCombineCommands(true);
        try {
            const themeSeed = { name: params.name };
            const theme = (0, store_1.createObject)(store, themeSeed, theme_1.Theme);
            const added = store.addObject(project.themes, theme);
            // Seed each color slot (getThemeColor already defaults to #000000 for
            // missing keys, but this matches clipboard-paste behavior).
            for (const color of project.colors || []) {
                project.setThemeColor(added.objID, color.objID, "#000000");
            }
            return { name: added.name };
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
    },
    set_active_theme(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const theme = (0, project_access_1.resolveByName)((0, project_access_1.projectThemes)(store), params.name, "theme");
        // UI navigation state (observable box), NOT a document/undo command.
        store.navigationStore.selectedThemeObject.set(theme);
        return { active: theme.name };
    },
    set_theme_color(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const project = store.project;
        const theme = (0, project_access_1.resolveByName)(project.themes, params.theme, "theme");
        const color = (0, project_access_1.resolveByName)(project.colors, params.color, "color");
        if (typeof params.value !== "string") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "value (string) is required.");
        }
        // Theme.colors is index-aligned to project.colors; place the value at the
        // color's index and route through updateObject for the undo entry.
        const idx = (project.colors || []).indexOf(color);
        if (idx < 0) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No color named "${params.color}".`);
        }
        const colors = theme.colors.slice();
        colors[idx] = params.value;
        store.updateObject(theme, { colors });
        return { theme: theme.name, color: color.name, value: params.value };
    },
    rename_theme(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const theme = (0, project_access_1.resolveByName)((0, project_access_1.projectThemes)(store), params.name, "theme");
        if (!params.newName) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "newName is required.");
        }
        (0, project_access_1.assertNameFree)((0, project_access_1.projectThemes)(store), params.newName, "theme");
        store.undoManager.setCombineCommands(true);
        try {
            (0, search_1.replaceObjectReference)(theme, params.newName);
            store.updateObject(theme, { name: params.newName });
        }
        finally {
            store.undoManager.setCombineCommands(false);
        }
        return { name: params.newName };
    },
    delete_theme(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const theme = (0, project_access_1.resolveByName)((0, project_access_1.projectThemes)(store), params.name, "theme");
        store.deleteObject(theme);
        return { deleted: params.name };
    }
};
