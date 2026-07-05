"use strict";
// MCP bridge handlers for PROJECT-LIFECYCLE + VIEW commands:
// save_as / new_project / open_project / reload_project / set_theme / open_view_tab.
//
// NONE of these are undo commands. They are app-lifecycle (save/new/open/reload) or
// transient home-shell UI (theme / view tabs). They must NOT go through
// updateObject / addObject / deleteObject / setCombineCommands.
//
// Two in-process renderers, one process: the bridge lives in the project-editor
// renderer, but `tabs` (home/tabs-store) and `settingsController` (home/settings)
// are the same singletons the whole app uses — no IPC round-trip needed.
//
// Source citations (studio/packages, read 2026-07-05):
//   ProjectStore.doSave        store/index.ts:690
//   free save(store, filePath) store/index.ts:1715
//   ProjectStore.newProject    store/index.ts:764
//   ProjectStore.reloadProject store/index.ts:1553
//   openProject(fp, runMode)   home/tabs-store.tsx:1381
//   tabs.openTabById(id, act)  home/tabs-store.tsx:1169
//   settingsController.switchTheme  home/settings.tsx:250
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandsHandlers = void 0;
const mobx_1 = require("mobx");
const tabs_store_1 = require("home/tabs-store");
const settings_1 = require("home/settings");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Local helpers -----------------------------------------------------------
const EEZ_PROJECT_EXT = ".eez-project";
/** Registered top-level home view tab ids (plus the two Home sub-views). */
const VIEW_TABS = new Set([
    "home",
    "history",
    "settings",
    "extensions",
    "shortcutsAndGroups"
]);
function ensureProjectExt(filePath) {
    return filePath.toLowerCase().endsWith(EEZ_PROJECT_EXT)
        ? filePath
        : filePath + EEZ_PROJECT_EXT;
}
/** Best-effort page count for a freshly-opened project tab. */
function pageCountOf(store) {
    const userPages = store?.project?.userPages || [];
    return userPages.length;
}
// --- Handlers ----------------------------------------------------------------
exports.commandsHandlers = {
    // Save/export the active project to a path.
    // With filePath: fully headless (set store.filePath + doSave → getJSON + fs.writeFile,
    // also clears the modified flag). Without filePath: EEZ pops a native OS save dialog
    // (store.saveAs), still callable — we read back store.filePath afterwards.
    async save_as(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (params.filePath) {
            const abs = ensureProjectExt(String(params.filePath));
            (0, mobx_1.runInAction)(() => {
                store.filePath = abs;
            });
            await store.doSave();
            return { saved: true, filePath: abs };
        }
        // No filePath → native save dialog (returns false if cancelled).
        const ok = await store.saveAs();
        return { saved: !!ok, filePath: store.filePath || null };
    },
    // Reset the ACTIVE tab's store to a fresh blank untitled project. DISRUPTIVE:
    // discards the current in-memory project with no save-confirm. The `type` param
    // is NOT honored by store.newProject() (blank-only; typed creation is the Wizard UI).
    async new_project(params) {
        const store = (0, project_access_1.requireProjectStore)();
        if (params.type != null &&
            String(params.type).toLowerCase() !== "empty" &&
            String(params.type).toLowerCase() !== "blank") {
            throw new protocol_1.BridgeError("UNSUPPORTED", "new_project only produces a blank project; typed project creation " +
                "requires the New Project wizard UI. Omit 'type' or pass 'empty'.");
        }
        await store.newProject();
        return { ok: true };
    },
    // Open an existing .eez-project by absolute path in a NEW tab (does not replace
    // the active project). Async load lands on tab activation.
    async open_project(params) {
        if (!params.filePath) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "filePath is required.");
        }
        const filePath = String(params.filePath);
        (0, tabs_store_1.openProject)(filePath, false);
        const tab = tabs_store_1.tabs.findProjectEditorTab(filePath, false);
        const store = tab ? tab.projectStore : undefined;
        return {
            opened: true,
            filePath,
            pages: store ? pageCountOf(store) : 0
        };
    },
    // Reload the active project from disk, discarding in-memory changes. DISRUPTIVE:
    // on a modified project, closeWindow() pops a save-confirm dialog.
    reload_project(_params) {
        const store = (0, project_access_1.requireProjectStore)();
        store.reloadProject();
        return { reloaded: true };
    },
    // Switch the EEZ editor dark/light theme (live CSS swap, no restart). Transient UI.
    set_theme(params) {
        const t = String(params.theme || "").toLowerCase();
        if (t !== "dark" && t !== "light") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "theme must be 'dark' or 'light'.");
        }
        const isDark = t === "dark";
        if (settings_1.settingsController.isDarkTheme !== isDark) {
            settings_1.settingsController.switchTheme(isDark);
        }
        return { theme: settings_1.settingsController.isDarkTheme ? "dark" : "light" };
    },
    // Open a top-level home/app view tab (home/history/settings/extensions/
    // shortcutsAndGroups). Transient UI navigation.
    open_view_tab(params) {
        const id = String(params.tab || "");
        if (!VIEW_TABS.has(id)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown view tab "${id}". Expected one of: ` +
                Array.from(VIEW_TABS).join(", ") +
                ".");
        }
        tabs_store_1.tabs.openTabById(id, true);
        return { tab: id };
    }
};
