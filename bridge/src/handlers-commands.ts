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

import { runInAction } from "mobx";

import { tabs, openProject } from "home/tabs-store";
import { settingsController } from "home/settings";

import { Handler, BridgeError } from "mcp-bridge/protocol";
import { requireProjectStore } from "mcp-bridge/project-access";

// --- Local helpers -----------------------------------------------------------

const EEZ_PROJECT_EXT = ".eez-project";

/** Registered top-level home view tab ids (plus the two Home sub-views). */
const VIEW_TABS: Set<string> = new Set([
    "home",
    "history",
    "settings",
    "extensions",
    "shortcutsAndGroups"
]);

function ensureProjectExt(filePath: string): string {
    return filePath.toLowerCase().endsWith(EEZ_PROJECT_EXT)
        ? filePath
        : filePath + EEZ_PROJECT_EXT;
}

/** Best-effort page count for a freshly-opened project tab. */
function pageCountOf(store: any): number {
    const userPages: any[] = store?.project?.userPages || [];
    return userPages.length;
}

// --- Handlers ----------------------------------------------------------------

export const commandsHandlers: Record<string, Handler> = {
    // Save/export the active project to a path.
    // With filePath: fully headless (set store.filePath + doSave → getJSON + fs.writeFile,
    // also clears the modified flag). Without filePath: EEZ pops a native OS save dialog
    // (store.saveAs), still callable — we read back store.filePath afterwards.
    async save_as(params: any): Promise<any> {
        const store = requireProjectStore();
        if (params.filePath) {
            const abs = ensureProjectExt(String(params.filePath));
            runInAction(() => {
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
    async new_project(params: any): Promise<any> {
        const store = requireProjectStore();
        if (
            params.type != null &&
            String(params.type).toLowerCase() !== "empty" &&
            String(params.type).toLowerCase() !== "blank"
        ) {
            throw new BridgeError(
                "UNSUPPORTED",
                "new_project only produces a blank project; typed project creation " +
                    "requires the New Project wizard UI. Omit 'type' or pass 'empty'."
            );
        }
        await store.newProject();
        return { ok: true };
    },

    // Open an existing .eez-project by absolute path in a NEW tab (does not replace
    // the active project). Async load lands on tab activation.
    async open_project(params: any): Promise<any> {
        if (!params.filePath) {
            throw new BridgeError("BAD_PARAMS", "filePath is required.");
        }
        const filePath = String(params.filePath);
        openProject(filePath, false);
        const tab: any = tabs.findProjectEditorTab(filePath, false);
        const store: any = tab ? tab.projectStore : undefined;
        return {
            opened: true,
            filePath,
            pages: store ? pageCountOf(store) : 0
        };
    },

    // Reload the active project from disk, discarding in-memory changes. DISRUPTIVE:
    // on a modified project, closeWindow() pops a save-confirm dialog.
    reload_project(_params: any): any {
        const store = requireProjectStore();
        store.reloadProject();
        return { reloaded: true };
    },

    // Switch the EEZ editor dark/light theme (live CSS swap, no restart). Transient UI.
    set_theme(params: any): any {
        const t = String(params.theme || "").toLowerCase();
        if (t !== "dark" && t !== "light") {
            throw new BridgeError(
                "BAD_PARAMS",
                "theme must be 'dark' or 'light'."
            );
        }
        const isDark = t === "dark";
        if (settingsController.isDarkTheme !== isDark) {
            settingsController.switchTheme(isDark);
        }
        return { theme: settingsController.isDarkTheme ? "dark" : "light" };
    },

    // Open a top-level home/app view tab (home/history/settings/extensions/
    // shortcutsAndGroups). Transient UI navigation.
    open_view_tab(params: any): any {
        const id = String(params.tab || "");
        if (!VIEW_TABS.has(id)) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown view tab "${id}". Expected one of: ` +
                    Array.from(VIEW_TABS).join(", ") +
                    "."
            );
        }
        tabs.openTabById(id, true);
        return { tab: id };
    }
};
