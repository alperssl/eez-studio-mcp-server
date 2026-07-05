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

import { createObject } from "project-editor/store";
import { LVGLGroup } from "project-editor/lvgl/groups";
import { Theme } from "project-editor/features/style/theme";
import { replaceObjectReference } from "project-editor/core/search";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import {
    requireProjectStore,
    requireLvglStore,
    resolveObject,
    resolveByName,
    assertNameFree,
    projectGroups,
    projectThemes
} from "mcp-bridge/project-access";

export const groupsThemesHandlers: Record<string, Handler> = {
    // --- LVGL focus groups ---------------------------------------------------

    list_groups() {
        const store = requireLvglStore();
        const g: any = store.project.lvglGroups;
        const enc: string = g.defaultGroupForEncoderInSimulator || "";
        const kbd: string = g.defaultGroupForKeyboardInSimulator || "";
        return {
            groups: (g.groups || []).map((x: any) => ({
                name: x.name,
                isEncoderDefault: x.name === enc,
                isKeyboardDefault: x.name === kbd
            })),
            defaultGroupForEncoderInSimulator: enc,
            defaultGroupForKeyboardInSimulator: kbd
        };
    },

    create_group(params: any) {
        const store = requireLvglStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectGroups(store), params.name, "group");
        const groupSeed: any = { name: params.name };
        const group: any = createObject(store, groupSeed, LVGLGroup);
        store.addObject(store.project.lvglGroups.groups, group);
        return { name: group.name };
    },

    assign_widget_group(params: any) {
        const store = requireLvglStore();
        const widget: any = resolveObject(store, params.objID);
        // widget.group is stored as the group NAME; "" clears. A non-empty name
        // must exist, else widget.check() would flag a missing group.
        if (params.group) {
            if (
                !projectGroups(store).some(
                    (x: any) => x.name === params.group
                )
            ) {
                throw new BridgeError(
                    "NOT_FOUND",
                    `No group named "${params.group}".`
                );
            }
        }
        const props: any = { group: params.group ?? "" };
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

    set_group_tab_order(params: any) {
        const store = requireLvglStore();
        const widget: any = resolveObject(store, params.objID);
        if (params.groupIndex === undefined) {
            throw new BridgeError("BAD_PARAMS", "groupIndex is required.");
        }
        store.updateObject(widget, { groupIndex: params.groupIndex });
        return { objID: params.objID, groupIndex: widget.groupIndex };
    },

    rename_group(params: any) {
        const store = requireLvglStore();
        const group: any = resolveByName(
            projectGroups(store),
            params.name,
            "group"
        );
        if (!params.newName) {
            throw new BridgeError("BAD_PARAMS", "newName is required.");
        }
        assertNameFree(projectGroups(store), params.newName, "group");
        const g: any = store.project.lvglGroups;
        store.undoManager.setCombineCommands(true);
        try {
            // Rebind widget.group name strings (referencedObjectCollectionPath
            // "lvglGroups/groups"), then rename the group object itself.
            replaceObjectReference(group, params.newName);
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
        } finally {
            store.undoManager.setCombineCommands(false);
        }
        return { name: params.newName };
    },

    delete_group(params: any) {
        const store = requireLvglStore();
        const group: any = resolveByName(
            projectGroups(store),
            params.name,
            "group"
        );
        const g: any = store.project.lvglGroups;
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
        } finally {
            store.undoManager.setCombineCommands(false);
        }
        return { deleted: params.name };
    },

    set_group_defaults(params: any) {
        const store = requireLvglStore();
        const g: any = store.project.lvglGroups;
        const props: any = {};
        if (params.encoderGroup !== undefined) {
            if (
                params.encoderGroup &&
                !projectGroups(store).some(
                    (x: any) => x.name === params.encoderGroup
                )
            ) {
                throw new BridgeError(
                    "NOT_FOUND",
                    `No group named "${params.encoderGroup}".`
                );
            }
            props.defaultGroupForEncoderInSimulator = params.encoderGroup;
        }
        if (params.keyboardGroup !== undefined) {
            if (
                params.keyboardGroup &&
                !projectGroups(store).some(
                    (x: any) => x.name === params.keyboardGroup
                )
            ) {
                throw new BridgeError(
                    "NOT_FOUND",
                    `No group named "${params.keyboardGroup}".`
                );
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
        const store = requireProjectStore();
        const themes: any[] = projectThemes(store);
        const sel: any = store.navigationStore?.selectedThemeObject.get();
        const active: any = sel || themes[0];
        return {
            themes: themes.map((t: any) => ({
                name: t.name,
                active: t === active
            }))
        };
    },

    create_theme(params: any) {
        const store = requireProjectStore();
        if (!params.name) {
            throw new BridgeError("BAD_PARAMS", "name is required.");
        }
        assertNameFree(projectThemes(store), params.name, "theme");
        const project: any = store.project;
        store.undoManager.setCombineCommands(true);
        try {
            const themeSeed: any = { name: params.name };
            const theme: any = createObject(store, themeSeed, Theme);
            const added: any = store.addObject(project.themes, theme);
            // Seed each color slot (getThemeColor already defaults to #000000 for
            // missing keys, but this matches clipboard-paste behavior).
            for (const color of project.colors || []) {
                project.setThemeColor(added.objID, color.objID, "#000000");
            }
            return { name: added.name };
        } finally {
            store.undoManager.setCombineCommands(false);
        }
    },

    set_active_theme(params: any) {
        const store = requireProjectStore();
        const theme: any = resolveByName(
            projectThemes(store),
            params.name,
            "theme"
        );
        // UI navigation state (observable box), NOT a document/undo command.
        store.navigationStore.selectedThemeObject.set(theme);
        return { active: theme.name };
    },

    set_theme_color(params: any) {
        const store = requireProjectStore();
        const project: any = store.project;
        const theme: any = resolveByName(project.themes, params.theme, "theme");
        const color: any = resolveByName(project.colors, params.color, "color");
        if (typeof params.value !== "string") {
            throw new BridgeError("BAD_PARAMS", "value (string) is required.");
        }
        // Theme.colors is index-aligned to project.colors; place the value at the
        // color's index and route through updateObject for the undo entry.
        const idx: number = (project.colors || []).indexOf(color);
        if (idx < 0) {
            throw new BridgeError(
                "NOT_FOUND",
                `No color named "${params.color}".`
            );
        }
        const colors: any[] = theme.colors.slice();
        colors[idx] = params.value;
        store.updateObject(theme, { colors });
        return { theme: theme.name, color: color.name, value: params.value };
    },

    rename_theme(params: any) {
        const store = requireProjectStore();
        const theme: any = resolveByName(
            projectThemes(store),
            params.name,
            "theme"
        );
        if (!params.newName) {
            throw new BridgeError("BAD_PARAMS", "newName is required.");
        }
        assertNameFree(projectThemes(store), params.newName, "theme");
        store.undoManager.setCombineCommands(true);
        try {
            replaceObjectReference(theme, params.newName);
            store.updateObject(theme, { name: params.newName });
        } finally {
            store.undoManager.setCombineCommands(false);
        }
        return { name: params.newName };
    },

    delete_theme(params: any) {
        const store = requireProjectStore();
        const theme: any = resolveByName(
            projectThemes(store),
            params.name,
            "theme"
        );
        store.deleteObject(theme);
        return { deleted: params.name };
    }
};
