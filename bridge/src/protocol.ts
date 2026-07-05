// EEZ Studio MCP Bridge — shared constants & wire types (renderer side).
// See docs/PROTOCOL.md in the eez-studio-mcp repo for the authoritative contract.

import * as os from "os";
import * as path from "path";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 38017;
export const HANDSHAKE_FILE = path.join(
    os.tmpdir(),
    "eez-studio-mcp-bridge.json"
);

export type ErrorCode =
    | "NO_PROJECT"
    | "NOT_FOUND"
    | "BAD_PARAMS"
    | "NOT_LVGL"
    | "UNSUPPORTED"
    | "INTERNAL";

export class BridgeError extends Error {
    constructor(public code: ErrorCode, message: string) {
        super(message);
        this.name = "BridgeError";
    }
}

/** A bridge method handler: (params) -> result (sync or async). Shared by all handler modules. */
export type Handler = (params: any) => any | Promise<any>;

export interface WireRequest {
    id: string;
    method: string;
    params?: Record<string, any>;
}

export interface WireResponse {
    id: string;
    ok: boolean;
    result?: any;
    error?: { code: ErrorCode; message: string };
}

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
    leftUnit: string;
    topUnit: string;
    widthUnit: string;
    heightUnit: string;
}

export interface AbsRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WidgetNode {
    objID: string;
    type: string;
    identifier: string | null;
    rect: Rect;
    absoluteRect: AbsRect;
    useStyle: string | null;
    hasLocalStyles: boolean;
    text?: string;
    children: WidgetNode[];
}

export interface WidgetDetail extends WidgetNode {
    props: Record<string, any>;
    localStyles: Record<string, Record<string, Record<string, any>>>;
    eventHandlers: Array<{
        eventName: string;
        handlerType: string;
        action: string;
        userData: number;
    }>;
}
