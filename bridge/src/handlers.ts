// Method dispatch: each MCP bridge method mapped onto EEZ's real ProjectStore /
// command-undo / navigation API. All mutations go through updateObject/addObject/
// deleteObject so the GUI, undo/redo, validation and codegen stay consistent.

import {
    createObject,
    getObjectPathAsString,
    getLabel
} from "project-editor/store";
import {
    findClass,
    getDefaultValue,
    getParent,
    MessageType
} from "project-editor/core/object";
import { lvglPropertiesMap } from "project-editor/lvgl/style-catalog";
import { EventHandler } from "project-editor/flow/component";
import { Section } from "project-editor/store/output-sections";
import { ProjectEditor } from "project-editor/project-editor-interface";

import { BridgeError, PROTOCOL_VERSION, WidgetNode } from "mcp-bridge/protocol";
import { getConsoleEntries, ConsoleLevel } from "mcp-bridge/console-capture";
import { getNotifications, NotifLevel } from "mcp-bridge/notification-capture";
import {
    requireProjectStore,
    requireLvglStore,
    resolveObject,
    resolvePage,
    pageChildrenTarget,
    pageOfObject,
    ProjectStoreLike
} from "mcp-bridge/project-access";
import { widgetToNode, widgetToDetail } from "mcp-bridge/serialize";
import { renderPage, renderSelection } from "mcp-bridge/render";
import { pagesHandlers } from "mcp-bridge/handlers-pages";
import { widgets2Handlers } from "mcp-bridge/handlers-widgets2";
import { assetsHandlers } from "mcp-bridge/handlers-assets";
import { projectEntitiesHandlers } from "mcp-bridge/handlers-project-entities";
import { projectHandlers } from "mcp-bridge/handlers-project";
import { widgetsSubitemsHandlers } from "mcp-bridge/handlers-widgets-subitems";
import { widgetsPropsHandlers } from "mcp-bridge/handlers-widgets-props";
import { variables2Handlers } from "mcp-bridge/handlers-variables2";
import { groupsThemesHandlers } from "mcp-bridge/handlers-groups-themes";
import { searchHandlers } from "mcp-bridge/handlers-search";
import { clipboardHandlers } from "mcp-bridge/handlers-clipboard";
import { editorsNavHandlers } from "mcp-bridge/handlers-editors-nav";
import { scrapbookHandlers } from "mcp-bridge/handlers-scrapbook";
import { i18nHandlers } from "mcp-bridge/handlers-i18n";
import { fontBitmapOpsHandlers } from "mcp-bridge/handlers-font-bitmap-ops";
import { settingsHandlers } from "mcp-bridge/handlers-settings";
import { simulatorHandlers } from "mcp-bridge/handlers-simulator";
import { buildOpsHandlers } from "mcp-bridge/handlers-build-ops";
import { fullSimExportHandlers } from "mcp-bridge/handlers-full-sim-export";
import { flowComponentsHandlers } from "mcp-bridge/handlers-flow-components";
import { flowConnectionsHandlers } from "mcp-bridge/handlers-flow-connections";
import { flowVarsHandlers } from "mcp-bridge/handlers-flow-vars";
import { flowReactiveHandlers } from "mcp-bridge/handlers-flow-reactive";
import { instrumentHandlers } from "mcp-bridge/handlers-instrument";
import { commandsHandlers } from "mcp-bridge/handlers-commands";

export type Handler = (params: any) => any | Promise<any>;

function eezStudioVersion(): string {
    try {
        return require("@electron/remote").app.getVersion();
    } catch (e) {
        return "unknown";
    }
}

function baseName(filePath: string | undefined): string {
    if (!filePath) {
        return "untitled";
    }
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1].replace(/\.eez-project$/i, "");
}

function countWidgets(node: WidgetNode): number {
    let n = node.children.length;
    for (const c of node.children) {
        n += countWidgets(c);
    }
    return n;
}

function selectedWidgets(store: ProjectStoreLike): any[] {
    const selected: any[] =
        store.navigationStore?.selectedPanel?.selectedObjects || [];
    return selected.filter(o => o && o.objID && o.type);
}

function severityOf(type: number): string {
    if (type === MessageType.ERROR) return "error";
    if (type === MessageType.WARNING) return "warning";
    return "info";
}

/** The objID of the nearest ancestor object (message.object is often a property wrapper). */
function nearestObjID(object: any): string | undefined {
    let cur = object;
    for (let i = 0; i < 64 && cur; i++) {
        if (cur.objID) return cur.objID;
        cur = getParent(cur);
    }
    return undefined;
}

function safe(fn: () => string): string | undefined {
    try {
        return fn();
    } catch (e) {
        return undefined;
    }
}

/** Flatten a diagnostics section (CHECKS/OUTPUT) into plain problem records. */
function collectProblems(section: any): any[] {
    const out: any[] = [];
    const walk = (msgs: any[], group?: string) => {
        for (const m of msgs || []) {
            if (m.type === MessageType.GROUP) {
                walk(m.messages || [], m.text);
            } else {
                out.push({
                    severity: severityOf(m.type),
                    text: m.text,
                    group,
                    objID: nearestObjID(m.object),
                    path: m.object
                        ? safe(() => getObjectPathAsString(m.object))
                        : undefined,
                    label: m.object ? safe(() => getLabel(m.object)) : undefined
                });
            }
        }
    };
    walk(section?.messages?.messages || []);
    return out;
}

function sectionSummary(section: any): any {
    return {
        numErrors: section?.numErrors ?? 0,
        numWarnings: section?.numWarnings ?? 0,
        problems: collectProblems(section)
    };
}

export const handlers: Record<string, Handler> = {
    ping() {
        return {
            pong: true,
            protocolVersion: PROTOCOL_VERSION,
            eezStudioVersion: eezStudioVersion()
        };
    },

    get_project_info() {
        const store = requireProjectStore();
        const g = store.project.settings.general;
        return {
            name: baseName(store.filePath),
            filePath: store.filePath || null,
            projectVersion: g.projectVersion,
            lvglVersion: g.lvglVersion,
            flowSupport: g.flowSupport,
            displayWidth: g.displayWidth,
            displayHeight: g.displayHeight,
            isModified: store.isModified,
            pages: (store.project.pages || []).map((p: any) => p.name)
        };
    },

    list_pages() {
        const store = requireProjectStore();
        const pages: any[] = store.project.pages || [];
        return {
            pages: pages.map(p => {
                const screen = p.lvglScreenWidget;
                const widgetCount = screen
                    ? countWidgets(widgetToNode(screen, true))
                    : 0;
                return {
                    name: p.name,
                    width: p.width,
                    height: p.height,
                    widgetCount
                };
            })
        };
    },

    get_page_tree(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.page);
        const screen = page.lvglScreenWidget;
        return {
            page: page.name,
            root: screen ? widgetToNode(screen, true) : null
        };
    },

    get_widget(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        return { widget: widgetToDetail(widget) };
    },

    get_selection() {
        const store = requireProjectStore();
        const widgets = selectedWidgets(store);
        const page = widgets.length ? pageOfObject(widgets[0]) : undefined;
        return {
            page: page ? page.name : null,
            objIDs: widgets.map(w => w.objID),
            widgets: widgets.map(w => widgetToNode(w, false))
        };
    },

    create_widget(params: any) {
        const store = requireLvglStore();
        const type: string = params.type;
        if (!type) {
            throw new BridgeError("BAD_PARAMS", "type is required.");
        }
        const cls = findClass(type);
        if (!cls) {
            throw new BridgeError("NOT_FOUND", `Unknown widget type "${type}".`);
        }

        let target: any[];
        if (params.parent) {
            const parent = resolveObject(store, params.parent);
            if (!Array.isArray(parent.children)) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    `Parent widget "${params.parent}" cannot contain children.`
                );
            }
            target = parent.children;
        } else if (params.page) {
            target = pageChildrenTarget(resolvePage(store, params.page));
        } else {
            throw new BridgeError(
                "BAD_PARAMS",
                "Either 'parent' (objID) or 'page' (name) is required."
            );
        }

        const seed: any = {};
        Object.assign(seed, getDefaultValue(store, cls.classInfo) || {});
        if (cls.classInfo.componentDefaultValue) {
            Object.assign(
                seed,
                cls.classInfo.componentDefaultValue(store) || {}
            );
        }
        seed.type = type;
        if (params.props) {
            Object.assign(seed, params.props);
        }

        const widget = createObject(store, seed, cls) as any;
        if (typeof params.index === "number") {
            store.insertObject(target, params.index, widget);
        } else {
            store.addObject(target, widget);
        }
        return { objID: widget.objID };
    },

    update_widget(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        store.updateObject(widget, params.props || {});
        return { objID: widget.objID };
    },

    set_style(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        const { part, state, values } = params;
        if (!part || !state || !values || typeof values !== "object") {
            throw new BridgeError(
                "BAD_PARAMS",
                "part, state and values{} are required."
            );
        }
        // Validate every property name up front.
        for (const prop of Object.keys(values)) {
            if (!lvglPropertiesMap.get(prop)) {
                throw new BridgeError(
                    "BAD_PARAMS",
                    `Unknown style property "${prop}".`
                );
            }
        }
        // Apply all cells in a SINGLE updateObject so the whole set_style is one
        // undo step (mirrors LVGLStylesDefinition.addPropertyToDefinition's spread).
        const ls = widget.localStyles;
        const def: any = { ...(ls.definition || {}) };
        def[part] = { ...(def[part] || {}) };
        def[part][state] = { ...(def[part][state] || {}), ...values };
        // Setting layout=GRID needs row/col descriptor arrays present (EEZ auto-adds these).
        if ((values as any).layout === "GRID") {
            if (def[part][state]["grid_row_dsc_array"] === undefined) {
                def[part][state]["grid_row_dsc_array"] = "";
            }
            if (def[part][state]["grid_column_dsc_array"] === undefined) {
                def[part][state]["grid_column_dsc_array"] = "";
            }
        }
        store.updateObject(ls, { definition: def });
        return { objID: widget.objID };
    },

    clear_style(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        const { part, state, prop } = params;
        const pi = lvglPropertiesMap.get(prop);
        if (!pi) {
            throw new BridgeError(
                "BAD_PARAMS",
                `Unknown style property "${prop}".`
            );
        }
        const ls = widget.localStyles;
        store.updateObject(ls, {
            definition: ls.removePropertyFromDefinition(pi, part, state)
        });
        return { objID: widget.objID };
    },

    delete_widget(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        store.deleteObject(widget);
        return { deleted: params.objID };
    },

    bind_event(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        if (!params.event || !params.action) {
            throw new BridgeError(
                "BAD_PARAMS",
                "event and action are required."
            );
        }
        const eh = createObject(
            store,
            {
                eventName: params.event,
                handlerType: "action",
                action: params.action,
                userData: params.userData ?? 0
            } as any,
            EventHandler
        );
        store.addObject(widget.eventHandlers, eh);
        return { objID: widget.objID };
    },

    unbind_event(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        const handlers2: any[] = widget.eventHandlers || [];
        const eh = handlers2.find(h => h.eventName === params.event);
        if (!eh) {
            throw new BridgeError(
                "NOT_FOUND",
                `No "${params.event}" handler on this widget.`
            );
        }
        store.deleteObject(eh);
        return { objID: widget.objID };
    },

    set_identifier(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        store.updateObject(widget, { identifier: params.name });
        return { objID: widget.objID };
    },

    async render_page(params: any) {
        const store = requireLvglStore();
        return await renderPage(store, params.page);
    },

    async render_selection(params: any) {
        const store = requireLvglStore();
        return await renderSelection(store, params.objID);
    },

    select_widget(params: any) {
        const store = requireProjectStore();
        const widget = resolveObject(store, params.objID);
        store.navigationStore.showObjects([widget], true, true, true);
        return { objID: widget.objID };
    },

    open_page(params: any) {
        const store = requireProjectStore();
        const page = resolvePage(store, params.page);
        store.editorsStore.openEditor(page);
        return { page: page.name };
    },

    undo() {
        const store = requireProjectStore();
        const um = store.undoManager;
        if (!um.canUndo) {
            return { label: null };
        }
        const label = um.undoDescription;
        um.undo();
        return { label };
    },

    redo() {
        const store = requireProjectStore();
        const um = store.undoManager;
        if (!um.canRedo) {
            return { label: null };
        }
        const label = um.redoDescription;
        um.redo();
        return { label };
    },

    async save() {
        const store = requireProjectStore();
        await store.save();
        return { saved: true, filePath: store.filePath || null };
    },

    list_fonts() {
        const store = requireProjectStore();
        return {
            fonts: (store.project.fonts || []).map((f: any) => ({
                name: f.name,
                size: f.source?.size,
                bpp: f.bpp
            }))
        };
    },

    list_bitmaps() {
        const store = requireProjectStore();
        return {
            bitmaps: (store.project.bitmaps || []).map((b: any) => ({
                name: b.name
            }))
        };
    },

    list_actions() {
        const store = requireProjectStore();
        return {
            actions: (store.project.actions || []).map((a: any) => ({
                name: a.name,
                implementationType: a.implementationType
            }))
        };
    },

    list_styles() {
        const store = requireProjectStore();
        const styles: any[] = store.project.lvglStyles?.styles || [];
        return {
            styles: styles.map(s => ({
                name: s.name,
                forWidgetType: s.forWidgetType
            }))
        };
    },

    // --- Diagnostics ---------------------------------------------------------

    // Run EEZ's project validation (the "Check" command) and return the results.
    async run_checks() {
        const store = requireProjectStore();
        await ProjectEditor.build.buildProject(store, "check");
        return sectionSummary(store.outputSectionsStore.getSection(Section.CHECKS));
    },

    // Read the current diagnostics without re-running: CHECKS (validation) and/or
    // OUTPUT (last build). Pass { section: "checks" | "output" } to narrow.
    get_problems(params: any) {
        const store = requireProjectStore();
        const which = params.section;
        const oss = store.outputSectionsStore;
        const result: any = {};
        if (!which || which === "checks") {
            result.checks = sectionSummary(oss.getSection(Section.CHECKS));
        }
        if (!which || which === "output") {
            result.output = sectionSummary(oss.getSection(Section.OUTPUT));
        }
        return result;
    },

    // Renderer/preview console output captured since the bridge started — catches
    // runtime problems (e.g. LVGL-WASM font-load failures) that are not project checks.
    get_console_log(params: any) {
        const level: ConsoleLevel = params.level || "warn";
        const limit = typeof params.limit === "number" ? params.limit : 100;
        return { entries: getConsoleEntries(level, limit) };
    },

    // EEZ Studio toast notifications captured since the bridge started — this is where
    // errors like `Font "..." extraction failed` surface (not the console, not the checks).
    get_notifications(params: any) {
        const level: NotifLevel = params.level || "warning";
        const limit = typeof params.limit === "number" ? params.limit : 100;
        return { entries: getNotifications(level, limit) };
    }
};

// Merge the domain handler modules onto the same dispatch table: pages
// (create/delete/rename/reorder/settings), widget clone/move/align/copy-style/
// introspect, asset write (bitmaps + fonts), project-level styles/actions/colors/
// variables, and project settings/build. Method names are disjoint across modules.
Object.assign(
    handlers,
    pagesHandlers,
    widgets2Handlers,
    assetsHandlers,
    projectEntitiesHandlers,
    projectHandlers,
    widgetsSubitemsHandlers,
    widgetsPropsHandlers,
    variables2Handlers,
    groupsThemesHandlers,
    searchHandlers,
    clipboardHandlers,
    editorsNavHandlers,
    scrapbookHandlers,
    i18nHandlers,
    fontBitmapOpsHandlers,
    settingsHandlers,
    simulatorHandlers,
    buildOpsHandlers,
    fullSimExportHandlers,
    flowComponentsHandlers,
    flowConnectionsHandlers,
    flowVarsHandlers,
    flowReactiveHandlers,
    instrumentHandlers,
    commandsHandlers
);
