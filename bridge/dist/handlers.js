"use strict";
// Method dispatch: each MCP bridge method mapped onto EEZ's real ProjectStore /
// command-undo / navigation API. All mutations go through updateObject/addObject/
// deleteObject so the GUI, undo/redo, validation and codegen stay consistent.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const style_catalog_1 = require("project-editor/lvgl/style-catalog");
const component_1 = require("project-editor/flow/component");
const output_sections_1 = require("project-editor/store/output-sections");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const protocol_1 = require("mcp-bridge/protocol");
const console_capture_1 = require("mcp-bridge/console-capture");
const notification_capture_1 = require("mcp-bridge/notification-capture");
const project_access_1 = require("mcp-bridge/project-access");
const serialize_1 = require("mcp-bridge/serialize");
const render_1 = require("mcp-bridge/render");
const handlers_pages_1 = require("mcp-bridge/handlers-pages");
const handlers_widgets2_1 = require("mcp-bridge/handlers-widgets2");
const handlers_assets_1 = require("mcp-bridge/handlers-assets");
const handlers_project_entities_1 = require("mcp-bridge/handlers-project-entities");
const handlers_project_1 = require("mcp-bridge/handlers-project");
const handlers_widgets_subitems_1 = require("mcp-bridge/handlers-widgets-subitems");
const handlers_widgets_props_1 = require("mcp-bridge/handlers-widgets-props");
const handlers_variables2_1 = require("mcp-bridge/handlers-variables2");
const handlers_groups_themes_1 = require("mcp-bridge/handlers-groups-themes");
const handlers_search_1 = require("mcp-bridge/handlers-search");
const handlers_clipboard_1 = require("mcp-bridge/handlers-clipboard");
const handlers_editors_nav_1 = require("mcp-bridge/handlers-editors-nav");
const handlers_scrapbook_1 = require("mcp-bridge/handlers-scrapbook");
const handlers_i18n_1 = require("mcp-bridge/handlers-i18n");
const handlers_font_bitmap_ops_1 = require("mcp-bridge/handlers-font-bitmap-ops");
const handlers_settings_1 = require("mcp-bridge/handlers-settings");
const handlers_simulator_1 = require("mcp-bridge/handlers-simulator");
const handlers_build_ops_1 = require("mcp-bridge/handlers-build-ops");
const handlers_full_sim_export_1 = require("mcp-bridge/handlers-full-sim-export");
const handlers_flow_components_1 = require("mcp-bridge/handlers-flow-components");
const handlers_flow_connections_1 = require("mcp-bridge/handlers-flow-connections");
const handlers_flow_vars_1 = require("mcp-bridge/handlers-flow-vars");
const handlers_flow_reactive_1 = require("mcp-bridge/handlers-flow-reactive");
const handlers_instrument_1 = require("mcp-bridge/handlers-instrument");
const handlers_commands_1 = require("mcp-bridge/handlers-commands");
function eezStudioVersion() {
    try {
        return require("@electron/remote").app.getVersion();
    }
    catch (e) {
        return "unknown";
    }
}
function baseName(filePath) {
    if (!filePath) {
        return "untitled";
    }
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1].replace(/\.eez-project$/i, "");
}
function countWidgets(node) {
    let n = node.children.length;
    for (const c of node.children) {
        n += countWidgets(c);
    }
    return n;
}
function selectedWidgets(store) {
    const selected = store.navigationStore?.selectedPanel?.selectedObjects || [];
    return selected.filter(o => o && o.objID && o.type);
}
function severityOf(type) {
    if (type === object_1.MessageType.ERROR)
        return "error";
    if (type === object_1.MessageType.WARNING)
        return "warning";
    return "info";
}
/** The objID of the nearest ancestor object (message.object is often a property wrapper). */
function nearestObjID(object) {
    let cur = object;
    for (let i = 0; i < 64 && cur; i++) {
        if (cur.objID)
            return cur.objID;
        cur = (0, object_1.getParent)(cur);
    }
    return undefined;
}
function safe(fn) {
    try {
        return fn();
    }
    catch (e) {
        return undefined;
    }
}
/** Flatten a diagnostics section (CHECKS/OUTPUT) into plain problem records. */
function collectProblems(section) {
    const out = [];
    const walk = (msgs, group) => {
        for (const m of msgs || []) {
            if (m.type === object_1.MessageType.GROUP) {
                walk(m.messages || [], m.text);
            }
            else {
                out.push({
                    severity: severityOf(m.type),
                    text: m.text,
                    group,
                    objID: nearestObjID(m.object),
                    path: m.object
                        ? safe(() => (0, store_1.getObjectPathAsString)(m.object))
                        : undefined,
                    label: m.object ? safe(() => (0, store_1.getLabel)(m.object)) : undefined
                });
            }
        }
    };
    walk(section?.messages?.messages || []);
    return out;
}
function sectionSummary(section) {
    return {
        numErrors: section?.numErrors ?? 0,
        numWarnings: section?.numWarnings ?? 0,
        problems: collectProblems(section)
    };
}
exports.handlers = {
    ping() {
        return {
            pong: true,
            protocolVersion: protocol_1.PROTOCOL_VERSION,
            eezStudioVersion: eezStudioVersion()
        };
    },
    get_project_info() {
        const store = (0, project_access_1.requireProjectStore)();
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
            pages: (store.project.pages || []).map((p) => p.name)
        };
    },
    list_pages() {
        const store = (0, project_access_1.requireProjectStore)();
        const pages = store.project.pages || [];
        return {
            pages: pages.map(p => {
                const screen = p.lvglScreenWidget;
                const widgetCount = screen
                    ? countWidgets((0, serialize_1.widgetToNode)(screen, true))
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
    get_page_tree(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.page);
        const screen = page.lvglScreenWidget;
        return {
            page: page.name,
            root: screen ? (0, serialize_1.widgetToNode)(screen, true) : null
        };
    },
    get_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        return { widget: (0, serialize_1.widgetToDetail)(widget) };
    },
    get_selection() {
        const store = (0, project_access_1.requireProjectStore)();
        const widgets = selectedWidgets(store);
        const page = widgets.length ? (0, project_access_1.pageOfObject)(widgets[0]) : undefined;
        return {
            page: page ? page.name : null,
            objIDs: widgets.map(w => w.objID),
            widgets: widgets.map(w => (0, serialize_1.widgetToNode)(w, false))
        };
    },
    create_widget(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const type = params.type;
        if (!type) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "type is required.");
        }
        const cls = (0, object_1.findClass)(type);
        if (!cls) {
            throw new protocol_1.BridgeError("NOT_FOUND", `Unknown widget type "${type}".`);
        }
        let target;
        if (params.parent) {
            const parent = (0, project_access_1.resolveObject)(store, params.parent);
            if (!Array.isArray(parent.children)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `Parent widget "${params.parent}" cannot contain children.`);
            }
            target = parent.children;
        }
        else if (params.page) {
            target = (0, project_access_1.pageChildrenTarget)((0, project_access_1.resolvePage)(store, params.page));
        }
        else {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Either 'parent' (objID) or 'page' (name) is required.");
        }
        const seed = {};
        Object.assign(seed, (0, object_1.getDefaultValue)(store, cls.classInfo) || {});
        if (cls.classInfo.componentDefaultValue) {
            Object.assign(seed, cls.classInfo.componentDefaultValue(store) || {});
        }
        seed.type = type;
        if (params.props) {
            Object.assign(seed, params.props);
        }
        const widget = (0, store_1.createObject)(store, seed, cls);
        if (typeof params.index === "number") {
            store.insertObject(target, params.index, widget);
        }
        else {
            store.addObject(target, widget);
        }
        return { objID: widget.objID };
    },
    update_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        store.updateObject(widget, params.props || {});
        return { objID: widget.objID };
    },
    set_style(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const { part, state, values } = params;
        if (!part || !state || !values || typeof values !== "object") {
            throw new protocol_1.BridgeError("BAD_PARAMS", "part, state and values{} are required.");
        }
        // Validate every property name up front.
        for (const prop of Object.keys(values)) {
            if (!style_catalog_1.lvglPropertiesMap.get(prop)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown style property "${prop}".`);
            }
        }
        // Apply all cells in a SINGLE updateObject so the whole set_style is one
        // undo step (mirrors LVGLStylesDefinition.addPropertyToDefinition's spread).
        const ls = widget.localStyles;
        const def = { ...(ls.definition || {}) };
        def[part] = { ...(def[part] || {}) };
        def[part][state] = { ...(def[part][state] || {}), ...values };
        // Setting layout=GRID needs row/col descriptor arrays present (EEZ auto-adds these).
        if (values.layout === "GRID") {
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
    clear_style(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const { part, state, prop } = params;
        const pi = style_catalog_1.lvglPropertiesMap.get(prop);
        if (!pi) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown style property "${prop}".`);
        }
        const ls = widget.localStyles;
        store.updateObject(ls, {
            definition: ls.removePropertyFromDefinition(pi, part, state)
        });
        return { objID: widget.objID };
    },
    delete_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        store.deleteObject(widget);
        return { deleted: params.objID };
    },
    bind_event(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        if (!params.event || !params.action) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "event and action are required.");
        }
        const eh = (0, store_1.createObject)(store, {
            eventName: params.event,
            handlerType: "action",
            action: params.action,
            userData: params.userData ?? 0
        }, component_1.EventHandler);
        store.addObject(widget.eventHandlers, eh);
        return { objID: widget.objID };
    },
    unbind_event(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const handlers2 = widget.eventHandlers || [];
        const eh = handlers2.find(h => h.eventName === params.event);
        if (!eh) {
            throw new protocol_1.BridgeError("NOT_FOUND", `No "${params.event}" handler on this widget.`);
        }
        store.deleteObject(eh);
        return { objID: widget.objID };
    },
    set_identifier(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        store.updateObject(widget, { identifier: params.name });
        return { objID: widget.objID };
    },
    async render_page(params) {
        const store = (0, project_access_1.requireLvglStore)();
        return await (0, render_1.renderPage)(store, params.page);
    },
    async render_selection(params) {
        const store = (0, project_access_1.requireLvglStore)();
        return await (0, render_1.renderSelection)(store, params.objID);
    },
    select_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        store.navigationStore.showObjects([widget], true, true, true);
        return { objID: widget.objID };
    },
    open_page(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const page = (0, project_access_1.resolvePage)(store, params.page);
        store.editorsStore.openEditor(page);
        return { page: page.name };
    },
    undo() {
        const store = (0, project_access_1.requireProjectStore)();
        const um = store.undoManager;
        if (!um.canUndo) {
            return { label: null };
        }
        const label = um.undoDescription;
        um.undo();
        return { label };
    },
    redo() {
        const store = (0, project_access_1.requireProjectStore)();
        const um = store.undoManager;
        if (!um.canRedo) {
            return { label: null };
        }
        const label = um.redoDescription;
        um.redo();
        return { label };
    },
    async save() {
        const store = (0, project_access_1.requireProjectStore)();
        await store.save();
        return { saved: true, filePath: store.filePath || null };
    },
    list_fonts() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            fonts: (store.project.fonts || []).map((f) => ({
                name: f.name,
                size: f.source?.size,
                bpp: f.bpp
            }))
        };
    },
    list_bitmaps() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            bitmaps: (store.project.bitmaps || []).map((b) => ({
                name: b.name
            }))
        };
    },
    list_actions() {
        const store = (0, project_access_1.requireProjectStore)();
        return {
            actions: (store.project.actions || []).map((a) => ({
                name: a.name,
                implementationType: a.implementationType
            }))
        };
    },
    list_styles() {
        const store = (0, project_access_1.requireProjectStore)();
        const styles = store.project.lvglStyles?.styles || [];
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
        const store = (0, project_access_1.requireProjectStore)();
        await project_editor_interface_1.ProjectEditor.build.buildProject(store, "check");
        return sectionSummary(store.outputSectionsStore.getSection(output_sections_1.Section.CHECKS));
    },
    // Read the current diagnostics without re-running: CHECKS (validation) and/or
    // OUTPUT (last build). Pass { section: "checks" | "output" } to narrow.
    get_problems(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const which = params.section;
        const oss = store.outputSectionsStore;
        const result = {};
        if (!which || which === "checks") {
            result.checks = sectionSummary(oss.getSection(output_sections_1.Section.CHECKS));
        }
        if (!which || which === "output") {
            result.output = sectionSummary(oss.getSection(output_sections_1.Section.OUTPUT));
        }
        return result;
    },
    // Renderer/preview console output captured since the bridge started — catches
    // runtime problems (e.g. LVGL-WASM font-load failures) that are not project checks.
    get_console_log(params) {
        const level = params.level || "warn";
        const limit = typeof params.limit === "number" ? params.limit : 100;
        return { entries: (0, console_capture_1.getConsoleEntries)(level, limit) };
    },
    // EEZ Studio toast notifications captured since the bridge started — this is where
    // errors like `Font "..." extraction failed` surface (not the console, not the checks).
    get_notifications(params) {
        const level = params.level || "warning";
        const limit = typeof params.limit === "number" ? params.limit : 100;
        return { entries: (0, notification_capture_1.getNotifications)(level, limit) };
    }
};
// Merge the domain handler modules onto the same dispatch table: pages
// (create/delete/rename/reorder/settings), widget clone/move/align/copy-style/
// introspect, asset write (bitmaps + fonts), project-level styles/actions/colors/
// variables, and project settings/build. Method names are disjoint across modules.
Object.assign(exports.handlers, handlers_pages_1.pagesHandlers, handlers_widgets2_1.widgets2Handlers, handlers_assets_1.assetsHandlers, handlers_project_entities_1.projectEntitiesHandlers, handlers_project_1.projectHandlers, handlers_widgets_subitems_1.widgetsSubitemsHandlers, handlers_widgets_props_1.widgetsPropsHandlers, handlers_variables2_1.variables2Handlers, handlers_groups_themes_1.groupsThemesHandlers, handlers_search_1.searchHandlers, handlers_clipboard_1.clipboardHandlers, handlers_editors_nav_1.editorsNavHandlers, handlers_scrapbook_1.scrapbookHandlers, handlers_i18n_1.i18nHandlers, handlers_font_bitmap_ops_1.fontBitmapOpsHandlers, handlers_settings_1.settingsHandlers, handlers_simulator_1.simulatorHandlers, handlers_build_ops_1.buildOpsHandlers, handlers_full_sim_export_1.fullSimExportHandlers, handlers_flow_components_1.flowComponentsHandlers, handlers_flow_connections_1.flowConnectionsHandlers, handlers_flow_vars_1.flowVarsHandlers, handlers_flow_reactive_1.flowReactiveHandlers, handlers_instrument_1.instrumentHandlers, handlers_commands_1.commandsHandlers);
