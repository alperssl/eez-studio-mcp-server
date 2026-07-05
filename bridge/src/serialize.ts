// Serialize live LVGL widget objects into the plain WidgetNode/WidgetDetail wire shapes.

import { getClassInfo } from "project-editor/core/object";
import { WidgetNode, WidgetDetail, Rect } from "mcp-bridge/protocol";
import { absoluteRect } from "mcp-bridge/project-access";

// Properties handled explicitly or too heavy/circular to dump generically.
const SKIP_PROPS = new Set<string>([
    "children",
    "localStyles",
    "eventHandlers",
    "objID",
    "type",
    "customInputs",
    "customOutputs",
    "asInputProperties",
    "asOutputProperties",
    "catchError"
]);

function readRect(widget: any): Rect {
    return {
        left: widget.left ?? 0,
        top: widget.top ?? 0,
        width: widget.width ?? 0,
        height: widget.height ?? 0,
        leftUnit: widget.leftUnit ?? "px",
        topUnit: widget.topUnit ?? "px",
        widthUnit: widget.widthUnit ?? "px",
        heightUnit: widget.heightUnit ?? "px"
    };
}

function localStylesDefinition(
    widget: any
): Record<string, Record<string, Record<string, any>>> {
    const def = widget.localStyles?.definition;
    return def && typeof def === "object" ? def : {};
}

export function widgetToNode(widget: any, deep: boolean = true): WidgetNode {
    const node: WidgetNode = {
        objID: widget.objID,
        type: widget.type,
        identifier: widget.identifier || null,
        rect: readRect(widget),
        absoluteRect: absoluteRect(widget),
        useStyle: widget.useStyle || null,
        hasLocalStyles:
            Object.keys(localStylesDefinition(widget)).length > 0,
        children: []
    };
    if (typeof widget.text === "string") {
        node.text = widget.text;
    }
    const children: any[] = Array.isArray(widget.children)
        ? widget.children
        : [];
    if (deep) {
        node.children = children.map(c => widgetToNode(c, true));
    } else {
        node.children = children.map(c => widgetToNode(c, false));
    }
    return node;
}

function readProps(widget: any): Record<string, any> {
    const out: Record<string, any> = {};
    const classInfo = getClassInfo(widget);
    const properties: any[] = classInfo?.properties || [];
    for (const p of properties) {
        const name = p.name;
        if (SKIP_PROPS.has(name)) {
            continue;
        }
        const v = widget[name];
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") {
            out[name] = v;
        }
    }
    return out;
}

function readEventHandlers(widget: any): WidgetDetail["eventHandlers"] {
    const handlers: any[] = Array.isArray(widget.eventHandlers)
        ? widget.eventHandlers
        : [];
    return handlers.map(eh => ({
        eventName: eh.eventName,
        handlerType: eh.handlerType,
        action: eh.action,
        userData: eh.userData ?? 0
    }));
}

export function widgetToDetail(widget: any): WidgetDetail {
    const node = widgetToNode(widget, false);
    return {
        ...node,
        props: readProps(widget),
        localStyles: localStylesDefinition(widget),
        eventHandlers: readEventHandlers(widget)
    };
}
