"use strict";
// Widget structure / clone / move / introspect bridge methods. Every mutation goes
// through the same ProjectStore command/undo API used by handlers.ts, so the GUI,
// undo/redo, validation and codegen stay consistent. Multi-step edits are grouped
// into ONE undo entry via undoManager.setCombineCommands(true/false).
Object.defineProperty(exports, "__esModule", { value: true });
exports.widgets2Handlers = void 0;
const store_1 = require("project-editor/store");
const object_1 = require("project-editor/core/object");
const lvgl_versions_1 = require("project-editor/lvgl/lvgl-versions");
const project_editor_interface_1 = require("project-editor/project-editor-interface");
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
// --- Helpers ---------------------------------------------------------------
/** Resolve the destination children array for a clone/move given optional
 *  parent (objID) / page (name), falling back to `fallback` (e.g. the source's
 *  own parent array) when neither is provided. */
function resolveChildrenTarget(store, parentObjID, pageName, fallback) {
    if (parentObjID) {
        const parent = (0, project_access_1.resolveObject)(store, parentObjID);
        if (!Array.isArray(parent.children)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", `Parent widget "${parentObjID}" cannot contain children.`);
        }
        return parent.children;
    }
    if (pageName) {
        return (0, project_access_1.pageChildrenTarget)((0, project_access_1.resolvePage)(store, pageName));
    }
    return fallback();
}
/** True if `possibleAncestor` is `node` or one of its ancestors (walks getParent). */
function isAncestorOf(possibleAncestor, node) {
    let cur = node;
    for (let i = 0; i < 256 && cur; i++) {
        if (cur === possibleAncestor) {
            return true;
        }
        cur = (0, object_1.getParent)(cur);
    }
    return false;
}
/** Map a PropertyType to the coarse type string the protocol reports. */
function coarseType(type) {
    switch (type) {
        case 3 /* PropertyType.Number */:
        case 19 /* PropertyType.NumberArrayAsString */:
            return "number";
        case 2 /* PropertyType.Boolean */:
            return "boolean";
        case 4 /* PropertyType.Enum */:
            return "enum";
        case 8 /* PropertyType.Color */:
        case 9 /* PropertyType.ThemedColor */:
            return "color";
        case 5 /* PropertyType.String */:
        case 6 /* PropertyType.MultilineText */:
            return "string";
        case 1 /* PropertyType.Object */:
        case 0 /* PropertyType.Array */:
            return "object";
        default:
            return (object_1.TYPE_NAMES[type] || "any").toLowerCase();
    }
}
/** Editable classInfo properties for a widget class (skips hidden/computed ones). */
function classProps(classInfo) {
    const props = classInfo.properties || [];
    const out = [];
    for (const p of props) {
        if (!p || !p.name) {
            continue;
        }
        if (p.hideInPropertyGrid === true) {
            continue;
        }
        if (p.computed === true) {
            continue;
        }
        const entry = { name: p.name, type: coarseType(p.type) };
        if (p.type === 4 /* PropertyType.Enum */ && Array.isArray(p.enumItems)) {
            entry.enumValues = p.enumItems.map((e) => String(e.id));
        }
        else if (p.type === 4 /* PropertyType.Enum */) {
            // enumItems is a function ((object) => EnumItem[]); no instance at the
            // class level, so the concrete choices are dynamic/unknowable here.
            entry.enumValues = "dynamic";
        }
        out.push(entry);
    }
    return out;
}
/** Project-wide LVGL event names valid for the project's lvglVersion. */
function projectEventNames(store) {
    try {
        const events = (0, lvgl_versions_1.getLvglEvents)(store.project);
        return events ? Object.keys(events) : [];
    }
    catch (e) {
        return [];
    }
}
// --- Handlers --------------------------------------------------------------
exports.widgets2Handlers = {
    // Deep-clone a widget subtree (children + localStyles + props + eventHandlers)
    // with FRESH objIDs. addObject/insertObject run ensureUniqueProperties, which
    // rewrites any colliding LVGL identifiers automatically. A single add is already
    // one undo step; adding an optional left/top override makes it multi-step, so we
    // combine explicitly.
    duplicate_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const src = (0, project_access_1.resolveObject)(store, params.objID);
        const target = resolveChildrenTarget(store, params.parent, params.targetPage, () => {
            const arr = (0, object_1.getParent)(src);
            if (!Array.isArray(arr)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", "Source widget has no container to duplicate into; pass parent or targetPage.");
            }
            return arr;
        });
        const clone = (0, store_1.cloneObjectWithNewObjIds)(store, src);
        const hasPos = typeof params.left === "number" || typeof params.top === "number";
        const um = store.undoManager;
        if (hasPos) {
            um.setCombineCommands(true);
        }
        try {
            if (typeof params.index === "number") {
                store.insertObject(target, params.index, clone);
            }
            else {
                store.addObject(target, clone);
            }
            if (hasPos) {
                const pos = {};
                if (typeof params.left === "number") {
                    pos.left = params.left;
                }
                if (typeof params.top === "number") {
                    pos.top = params.top;
                }
                store.updateObject(clone, pos);
            }
            if (typeof params.identifierSuffix === "string" && clone.identifier) {
                store.updateObject(clone, {
                    identifier: clone.identifier + params.identifierSuffix
                });
            }
        }
        finally {
            if (hasPos) {
                um.setCombineCommands(false);
            }
        }
        return { objID: clone.objID };
    },
    // Reparent and/or reorder a subtree, preserving objID. Mirrors the GUI drag
    // path: delete the SAME instance from its old array, then insert it into the
    // destination — wrapped in one combined undo step. deleteObject/insertObject
    // never touch objID, so it is preserved across the move.
    move_widget(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const widget = (0, project_access_1.resolveObject)(store, params.objID);
        const target = resolveChildrenTarget(store, params.newParent, params.targetPage, () => {
            const arr = (0, object_1.getParent)(widget);
            if (!Array.isArray(arr)) {
                throw new protocol_1.BridgeError("BAD_PARAMS", "Widget has no container; pass newParent or targetPage.");
            }
            return arr;
        });
        // Guard against reparenting a widget into its own subtree (corrupt tree).
        // target is the destination children array; its owner is getParent(target).
        const targetOwner = (0, object_1.getParent)(target);
        if (targetOwner && isAncestorOf(widget, targetOwner)) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Cannot move a widget into itself or one of its descendants.");
        }
        const um = store.undoManager;
        um.setCombineCommands(true);
        try {
            store.deleteObject(widget);
            if (typeof params.index === "number") {
                store.insertObject(target, params.index, widget);
            }
            else {
                store.addObject(target, widget);
            }
        }
        finally {
            um.setCombineCommands(false);
        }
        return { objID: widget.objID };
    },
    // Align/distribute several widgets by writing left/top (px). All updates are
    // grouped into one undo step. Positions are read/written in each widget's own
    // parent coordinate space (left/top are px offsets from the parent).
    align_widgets(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const mode = params.mode;
        const objIDs = params.objIDs;
        if (!Array.isArray(objIDs) || objIDs.length === 0) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "objIDs[] is required.");
        }
        if (!mode) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "mode is required.");
        }
        const widgets = objIDs.map(id => (0, project_access_1.resolveObject)(store, id));
        // Snapshot geometry (treat non-px units as 0 offset — px alignment only).
        const box = widgets.map(w => ({
            w,
            left: typeof w.left === "number" ? w.left : 0,
            top: typeof w.top === "number" ? w.top : 0,
            width: typeof w.width === "number" ? w.width : 0,
            height: typeof w.height === "number" ? w.height : 0
        }));
        const minLeft = Math.min(...box.map(b => b.left));
        const maxRight = Math.max(...box.map(b => b.left + b.width));
        const minTop = Math.min(...box.map(b => b.top));
        const maxBottom = Math.max(...box.map(b => b.top + b.height));
        const centerX = (minLeft + maxRight) / 2;
        const centerY = (minTop + maxBottom) / 2;
        const updates = [];
        const setLeft = (b, left) => updates.push({ w: b.w, props: { left: Math.round(left) } });
        const setTop = (b, top) => updates.push({ w: b.w, props: { top: Math.round(top) } });
        switch (mode) {
            case "left":
                box.forEach(b => setLeft(b, minLeft));
                break;
            case "right":
                box.forEach(b => setLeft(b, maxRight - b.width));
                break;
            case "top":
                box.forEach(b => setTop(b, minTop));
                break;
            case "bottom":
                box.forEach(b => setTop(b, maxBottom - b.height));
                break;
            case "centerH":
                box.forEach(b => setLeft(b, centerX - b.width / 2));
                break;
            case "centerV":
                box.forEach(b => setTop(b, centerY - b.height / 2));
                break;
            case "distributeH": {
                if (box.length > 2) {
                    const sorted = [...box].sort((a, b) => a.left - b.left);
                    const totalW = sorted.reduce((s, b) => s + b.width, 0);
                    const span = maxRight - minLeft;
                    const gap = (span - totalW) / (sorted.length - 1);
                    let cursor = minLeft;
                    for (const b of sorted) {
                        setLeft(b, cursor);
                        cursor += b.width + gap;
                    }
                }
                break;
            }
            case "distributeV": {
                if (box.length > 2) {
                    const sorted = [...box].sort((a, b) => a.top - b.top);
                    const totalH = sorted.reduce((s, b) => s + b.height, 0);
                    const span = maxBottom - minTop;
                    const gap = (span - totalH) / (sorted.length - 1);
                    let cursor = minTop;
                    for (const b of sorted) {
                        setTop(b, cursor);
                        cursor += b.height + gap;
                    }
                }
                break;
            }
            default:
                throw new protocol_1.BridgeError("BAD_PARAMS", `Unknown align mode "${mode}".`);
        }
        const um = store.undoManager;
        um.setCombineCommands(true);
        try {
            for (const u of updates) {
                store.updateObject(u.w, u.props);
            }
        }
        finally {
            um.setCombineCommands(false);
        }
        return { objIDs };
    },
    // Copy local-style cells from one widget to another. Deep-merges the source
    // definition (part -> state -> prop -> value) into a copy of the target's
    // definition and writes it in a single updateObject — mirrors set_style.
    copy_style(params) {
        const store = (0, project_access_1.requireProjectStore)();
        const from = (0, project_access_1.resolveObject)(store, params.fromObjID);
        const to = (0, project_access_1.resolveObject)(store, params.toObjID);
        const src = (from.localStyles && from.localStyles.definition) || {};
        const ls = to.localStyles;
        if (!ls) {
            throw new protocol_1.BridgeError("BAD_PARAMS", "Target widget does not support local styles.");
        }
        const onlyPart = params.part;
        const onlyState = params.state;
        const def = { ...(ls.definition || {}) };
        for (const part of Object.keys(src)) {
            if (onlyPart && part !== onlyPart) {
                continue;
            }
            def[part] = { ...(def[part] || {}) };
            for (const state of Object.keys(src[part])) {
                if (onlyState && state !== onlyState) {
                    continue;
                }
                def[part][state] = {
                    ...(def[part][state] || {}),
                    ...src[part][state]
                };
            }
        }
        store.updateObject(ls, { definition: def });
        return { objID: to.objID };
    },
    // Enumerate creatable LVGL widget classes with their editable classInfo props
    // (name + coarse type + enumValues) and the project-wide LVGL event set. Read-only.
    list_widget_classes() {
        const store = (0, project_access_1.requireLvglStore)();
        const projectType = store.project.settings.general.projectType;
        const events = projectEventNames(store);
        const derived = (0, object_1.getClassesDerivedFrom)(store, project_editor_interface_1.ProjectEditor.LVGLWidgetClass);
        const classes = [];
        for (const d of derived) {
            const cls = d.objectClass;
            const ci = cls.classInfo;
            if (!ci) {
                continue;
            }
            // Only classes actually creatable in an LVGL project's palette.
            const enabledFn = ci.enabledInComponentPalette;
            if (typeof enabledFn === "function") {
                let enabled = false;
                try {
                    enabled = !!enabledFn(projectType, store);
                }
                catch (e) {
                    enabled = false;
                }
                if (!enabled) {
                    continue;
                }
            }
            // Skip the non-palette screen root.
            if (d.name === "LVGLScreenWidget") {
                continue;
            }
            classes.push({
                className: d.name,
                group: ci.componentPaletteGroupName,
                props: classProps(ci),
                events
            });
        }
        return { classes };
    }
};
