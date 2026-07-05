#!/usr/bin/env node
/**
 * EEZ Studio MCP Server.
 *
 * Exposes the EEZ Studio bridge protocol (docs/PROTOCOL.md) as MCP tools over stdio,
 * so an AI agent can inspect, edit, and render the currently-open .eez-project live.
 *
 * Tool surface is a 1:1 mapping over the bridge methods. Non-render tools return
 * pretty JSON text + structuredContent; render tools return an image content block.
 *
 * stdout is reserved for the MCP stdio channel — all diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeClient, BridgeRequestError, BridgeUnavailableError } from "./bridge-client.js";
import {
  METHODS,
  type BridgeMethod,
  type RenderResult,
  type ScreenshotSimulatorResult,
} from "./protocol.js";

const SERVER_NAME = "eez-studio-mcp";
const SERVER_VERSION = "0.1.0";

// A single shared client — lazily connects on first tool call, auto-reconnects.
const bridge = new BridgeClient();

function stderr(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

/** MCP text result with structuredContent mirror (non-render tools). */
function textResult(result: unknown) {
  const structured =
    result !== null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : { value: result };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: structured,
  };
}

/** MCP image result (render tools) — raw base64, no data: prefix. */
function imageResult(result: RenderResult) {
  return {
    content: [
      {
        type: "image" as const,
        data: result.pngBase64,
        mimeType: "image/png",
      },
    ],
  };
}

/** Turn any thrown error into an MCP isError result with actionable text. */
function errorResult(method: BridgeMethod, err: unknown) {
  let message: string;
  if (err instanceof BridgeUnavailableError) {
    message = err.message;
  } else if (err instanceof BridgeRequestError) {
    message = `Bridge rejected "${method}" (${err.code}): ${err.message}`;
  } else if (err instanceof Error) {
    message = `"${method}" failed: ${err.message}`;
  } else {
    message = `"${method}" failed: ${String(err)}`;
  }
  stderr(message);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Register a non-render tool: call the bridge method with validated params and
 * return text + structuredContent.
 */
function registerBridgeTool(
  method: BridgeMethod,
  config: { title: string; description: string; inputSchema: z.ZodRawShape }
): void {
  server.registerTool(
    method,
    { title: config.title, description: config.description, inputSchema: config.inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const params = pruneUndefined(args ?? {});
        const result = await bridge.request(method, params);
        return textResult(result);
      } catch (err) {
        return errorResult(method, err);
      }
    }
  );
}

/** Register a render tool: same call path, but return an image content block. */
function registerRenderTool(
  method: BridgeMethod,
  config: { title: string; description: string; inputSchema: z.ZodRawShape }
): void {
  server.registerTool(
    method,
    { title: config.title, description: config.description, inputSchema: config.inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const params = pruneUndefined(args ?? {});
        const result = (await bridge.request(method, params)) as RenderResult;
        if (!result || typeof result.pngBase64 !== "string") {
          return errorResult(method, new Error("Bridge returned no PNG data for the render."));
        }
        return imageResult(result);
      } catch (err) {
        return errorResult(method, err);
      }
    }
  );
}

/**
 * Register the simulator screenshot tool: same call path as a render tool, but the
 * bridge returns { png, width, height, source } (png, not pngBase64). Emit an image
 * content block from the base64 png; fall back to structured JSON if it is missing.
 */
function registerScreenshotTool(
  method: BridgeMethod,
  config: { title: string; description: string; inputSchema: z.ZodRawShape }
): void {
  server.registerTool(
    method,
    { title: config.title, description: config.description, inputSchema: config.inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const params = pruneUndefined(args ?? {});
        const result = (await bridge.request(method, params)) as ScreenshotSimulatorResult;
        if (result && typeof result.png === "string") {
          return {
            content: [
              {
                type: "image" as const,
                data: result.png,
                mimeType: "image/png",
              },
            ],
          };
        }
        // Fall back to structured JSON when no PNG is present.
        return textResult(result);
      } catch (err) {
        return errorResult(method, err);
      }
    }
  );
}

/** Drop keys whose value is undefined so optional zod fields don't leak nulls. */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reusable zod fragments
// ---------------------------------------------------------------------------

const objID = z
  .string()
  .describe("Stable serialized GUID that addresses a widget (returned by every inspect method).");

const pageName = z.string().describe("Unique page name (pages are addressed by name, not id).");

const part = z
  .string()
  .describe('Bare LVGL selector part, e.g. "MAIN", "KNOB", "INDICATOR", "ITEMS".');

const state = z
  .string()
  .describe('Bare LVGL selector state, e.g. "DEFAULT", "PRESSED", "CHECKED", "CHECKED|PRESSED".');

// Guidance shared across edit-tool descriptions.
const VALUE_FORMAT_NOTE =
  " Values use the object-model string form: colors as \"#rrggbb\" or a theme color name, " +
  "opacity as an int 0-255, enums bare without the LV_ prefix, fonts/bitmaps by name.";

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// --- Inspect (read-only) ---------------------------------------------------

registerBridgeTool(METHODS.PING, {
  title: "Ping bridge",
  description:
    "Health check. Returns { pong, protocolVersion, eezStudioVersion }. Use to confirm the EEZ Studio bridge is reachable.",
  inputSchema: {},
});

registerBridgeTool(METHODS.GET_PROJECT_INFO, {
  title: "Get project info",
  description:
    "Summary of the currently-open project: name, filePath, projectVersion, lvglVersion, flowSupport, display size, isModified, and the list of page names. Start here to orient yourself.",
  inputSchema: {},
});

registerBridgeTool(METHODS.LIST_PAGES, {
  title: "List pages",
  description:
    "List every page with { name, width, height, widgetCount }. Pages are addressed by name in all other tools.",
  inputSchema: {},
});

registerBridgeTool(METHODS.GET_PAGE_TREE, {
  title: "Get page widget tree",
  description:
    "Return the nested widget tree for a page. Each node carries its objID (address it for edits), type, identifier, rect, absoluteRect, useStyle, hasLocalStyles, and children. Use depth to limit nesting.",
  inputSchema: {
    page: pageName,
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional max tree depth to return (omit for the full tree)."),
  },
});

registerBridgeTool(METHODS.GET_WIDGET, {
  title: "Get widget detail",
  description:
    "Full detail for one widget by objID: all serialized props, localStyles ({part:{state:{prop:value}}}), and eventHandlers. Use before editing to see current values.",
  inputSchema: { objID },
});

registerBridgeTool(METHODS.GET_SELECTION, {
  title: "Get current selection",
  description:
    "What the user currently has selected in the GUI: { page, objIDs, widgets }. Use to act on what the user is looking at.",
  inputSchema: {},
});

// --- Edit (each call is one undo step) -------------------------------------

registerBridgeTool(METHODS.CREATE_WIDGET, {
  title: "Create widget",
  description:
    'Create a widget of a registered class (e.g. "LVGLLabelWidget", "LVGLButtonWidget"). ' +
    "Provide parent (an objID) to nest it under a widget, OR page to add it to the page root; " +
    "index sets the position among siblings. props are classInfo keys " +
    "(left, top, width, height, leftUnit, ..., text, textType, widgetFlags, states, useStyle, zoom, angle, image, ...). " +
    "Returns { objID } of the new widget." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    type: z.string().describe('Registered widget class name, e.g. "LVGLLabelWidget".'),
    parent: objID.optional().describe("Parent widget objID to nest under (mutually exclusive with page)."),
    page: pageName.optional().describe("Page name to add the widget to the screen root (if no parent)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among siblings."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Initial classInfo property values (object-model string form)."),
  },
});

registerBridgeTool(METHODS.UPDATE_WIDGET, {
  title: "Update widget props",
  description:
    "Update one or more classInfo props on a widget by objID (forwarded to ProjectStore.updateObject). " +
    "Returns { objID }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    props: z
      .record(z.string(), z.unknown())
      .describe("Property keys to update with their new values (object-model string form)."),
  },
});

registerBridgeTool(METHODS.SET_STYLE, {
  title: "Set local style",
  description:
    "Set one or more style cells on a widget's localStyles for a given part+state. " +
    'part/state are bare LVGL selectors (e.g. part "MAIN", state "PRESSED"). ' +
    "values is a map of style prop -> value. Returns { objID }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    part,
    state,
    values: z
      .record(z.string(), z.unknown())
      .describe('Style props to set, e.g. { "bg_color": "#204080", "bg_opa": 255, "text_font": "Montserrat14" }.'),
  },
});

registerBridgeTool(METHODS.CLEAR_STYLE, {
  title: "Clear local style",
  description:
    "Remove a single style prop from a widget's localStyles for a part+state. Returns { objID }.",
  inputSchema: {
    objID,
    part,
    state,
    prop: z.string().describe('Style property name to clear, e.g. "bg_color".'),
  },
});

registerBridgeTool(METHODS.DELETE_WIDGET, {
  title: "Delete widget",
  description: "Delete a widget (and its children) by objID. Returns { deleted: objID }.",
  inputSchema: { objID },
});

registerBridgeTool(METHODS.BIND_EVENT, {
  title: "Bind event handler",
  description:
    "Add an action event handler to a widget. event is a bare LVGL event name (e.g. \"CLICKED\", \"VALUE_CHANGED\"); " +
    "action is the name of an existing action. Optional userData is passed to the handler. Returns { objID }.",
  inputSchema: {
    objID,
    event: z.string().describe('Bare LVGL event name, e.g. "CLICKED", "PRESSED", "VALUE_CHANGED".'),
    action: z.string().describe("Name of an existing action to invoke (see list_actions)."),
    userData: z.unknown().optional().describe("Optional user data passed to the handler."),
  },
});

registerBridgeTool(METHODS.UNBIND_EVENT, {
  title: "Unbind event handler",
  description: "Remove the action handler for a given event on a widget. Returns { objID }.",
  inputSchema: {
    objID,
    event: z.string().describe('Bare LVGL event name to unbind, e.g. "CLICKED".'),
  },
});

registerBridgeTool(METHODS.SET_IDENTIFIER, {
  title: "Set widget identifier",
  description:
    "Set the widget's identifier (its code-facing name). Returns { objID }. Use a valid C identifier.",
  inputSchema: {
    objID,
    name: z.string().describe("New identifier (C-style name) for the widget."),
  },
});

// --- Render (pixel-exact) --------------------------------------------------

registerRenderTool(METHODS.RENDER_PAGE, {
  title: "Render page (PNG)",
  description:
    "Render a page pixel-exactly from EEZ Studio's own LVGL-WASM preview and return it as a PNG image. " +
    "Opens the page editor if needed and waits for a painted frame. Use to see exactly what the user sees.",
  inputSchema: { page: pageName },
});

registerRenderTool(METHODS.RENDER_SELECTION, {
  title: "Render widget (PNG)",
  description:
    "Render a single widget cropped to its rect and return it as a PNG image. " +
    "Pass objID to target a specific widget; omit it to render the current selection.",
  inputSchema: {
    objID: objID.optional().describe("Widget to render; omit to use the current selection."),
  },
});

// --- Navigate / lifecycle --------------------------------------------------

registerBridgeTool(METHODS.SELECT_WIDGET, {
  title: "Select widget in GUI",
  description:
    "Reveal and select a widget in the EEZ Studio GUI (scrolls it into view). Returns { objID }.",
  inputSchema: { objID },
});

registerBridgeTool(METHODS.OPEN_PAGE, {
  title: "Open page editor",
  description: "Open the editor tab for a page. Returns { page }.",
  inputSchema: { page: pageName },
});

registerBridgeTool(METHODS.UNDO, {
  title: "Undo",
  description: "Undo the last edit. Returns { label } describing the undone step.",
  inputSchema: {},
});

registerBridgeTool(METHODS.REDO, {
  title: "Redo",
  description: "Redo the last undone edit. Returns { label } describing the redone step.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SAVE, {
  title: "Save project",
  description: "Save the project to disk. Returns { saved: true, filePath }.",
  inputSchema: {},
});

// --- Assets (read) ---------------------------------------------------------

registerBridgeTool(METHODS.LIST_FONTS, {
  title: "List fonts",
  description:
    "List available fonts as [{ name, size?, bpp? }]. Reference fonts by name in text_font style props.",
  inputSchema: {},
});

registerBridgeTool(METHODS.LIST_BITMAPS, {
  title: "List bitmaps",
  description:
    "List available bitmaps/images as [{ name, width?, height? }]. Reference bitmaps by name in image props.",
  inputSchema: {},
});

registerBridgeTool(METHODS.LIST_ACTIONS, {
  title: "List actions",
  description:
    "List available actions as [{ name, implementationType }]. Use these names with bind_event.",
  inputSchema: {},
});

registerBridgeTool(METHODS.LIST_STYLES, {
  title: "List styles",
  description:
    "List reusable named styles as [{ name, forWidgetType }]. Reference these by name in a widget's useStyle prop.",
  inputSchema: {},
});

// --- Diagnostics -----------------------------------------------------------

registerBridgeTool(METHODS.RUN_CHECKS, {
  title: "Run project checks",
  description:
    'Run EEZ Studio\'s project validation (the "Check" command) and return ' +
    "{ numErrors, numWarnings, problems[] }, where each problem is { severity, text, objID?, path?, label? }. " +
    "Use after edits or when a project seems misconfigured to surface invalid references, missing fonts/bitmaps/actions, and bad values. objID lets you select/fix the offending widget.",
  inputSchema: {},
});

registerBridgeTool(METHODS.GET_PROBLEMS, {
  title: "Get problems",
  description:
    "Read the CURRENT diagnostics without re-running: EEZ's CHECKS (validation) and/or OUTPUT (last build). " +
    "Returns { checks?, output? }, each { numErrors, numWarnings, problems[] }. Pass { section } to narrow. " +
    "If checks may be stale, call run_checks first.",
  inputSchema: {
    section: z
      .enum(["checks", "output"])
      .optional()
      .describe("Limit to one section; omit for both."),
  },
});

registerBridgeTool(METHODS.GET_CONSOLE_LOG, {
  title: "Get console log",
  description:
    "Return renderer/preview console output captured since the bridge started — catches RUNTIME problems that are not project checks, " +
    "e.g. LVGL-WASM font-load failures when a project opens. Returns { entries: [{ ts, level, text }] }. " +
    'level filters to that severity and above (default "warn").',
  inputSchema: {
    level: z
      .enum(["log", "info", "warn", "error"])
      .optional()
      .describe('Minimum level to include (default "warn").'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max most-recent entries to return (default 100)."),
  },
});

registerBridgeTool(METHODS.GET_NOTIFICATIONS, {
  title: "Get notifications",
  description:
    "Return EEZ Studio's toast notifications captured since the bridge started. This is where errors like " +
    '`Font "roboto22" extraction failed: ...` surface — they are NOT in the console log or the project checks. ' +
    "Returns { entries: [{ ts, level, text, count }] }. level filters to that severity and above (default \"warning\"). " +
    "Check this on open and after asset/font changes.",
  inputSchema: {
    level: z
      .enum(["success", "info", "warning", "error"])
      .optional()
      .describe('Minimum level to include (default "warning").'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max most-recent entries to return (default 100)."),
  },
});

// --- Pages / screens (each call is one undo step) --------------------------

registerBridgeTool(METHODS.CREATE_PAGE, {
  title: "Create page",
  description:
    "Create a new LVGL screen (Page) added to the project, addressed thereafter by its unique name. " +
    "width/height default to the display size; index sets its position among pages. " +
    "Returns { page, rootObjID } where rootObjID is the page's LVGLScreenWidget (use it as a parent for create_widget). One undo step.",
  inputSchema: {
    name: z.string().describe("Unique name for the new page."),
    width: z.number().int().positive().optional().describe("Page width in px (defaults to display width)."),
    height: z.number().int().positive().optional().describe("Page height in px (defaults to display height)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among pages."),
  },
});

registerBridgeTool(METHODS.DELETE_PAGE, {
  title: "Delete page",
  description: "Delete a page (and its widget tree) by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: pageName,
  },
});

registerBridgeTool(METHODS.RENAME_PAGE, {
  title: "Rename page",
  description:
    "Rename a page. Pages are addressed by name, so update references accordingly. Returns { page } with the new name. One undo step.",
  inputSchema: {
    name: pageName,
    newName: z.string().describe("New unique page name."),
  },
});

registerBridgeTool(METHODS.REORDER_PAGE, {
  title: "Reorder page",
  description: "Move a page to a new position among pages. Returns { page, index }. One undo step.",
  inputSchema: {
    name: pageName,
    index: z.number().int().nonnegative().describe("New position index among pages."),
  },
});

registerBridgeTool(METHODS.SET_PAGE_SETTINGS, {
  title: "Set page settings",
  description:
    "Update page-level props by name (e.g. background, isStartScreen). props is a map of page property -> value. " +
    "Returns { page }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: pageName,
    props: z
      .record(z.string(), z.unknown())
      .describe("Page property keys to set, e.g. { \"isStartScreen\": true } (object-model string form)."),
  },
});

// --- Widgets — structure / clone / move / introspect -----------------------
// (all undoable except list_widget_classes, which is read-only)

registerBridgeTool(METHODS.DUPLICATE_WIDGET, {
  title: "Duplicate widget",
  description:
    "Deep-clone a widget subtree (children + localStyles + props + eventHandlers) with FRESH objIDs and no identifier collisions. " +
    "Address the source by objID. Optionally place the copy on targetPage or under parent (an objID), at index, offset by left/top, " +
    "and suffix cloned identifiers via identifierSuffix. Returns { objID } of the new root. One undo step.",
  inputSchema: {
    objID,
    targetPage: pageName.optional().describe("Page to place the clone on (defaults to the source's page)."),
    parent: objID.optional().describe("Parent widget objID to nest the clone under."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among siblings."),
    left: z.number().optional().describe("X offset applied to the clone's root, in px."),
    top: z.number().optional().describe("Y offset applied to the clone's root, in px."),
    identifierSuffix: z
      .string()
      .optional()
      .describe("Suffix appended to cloned identifiers to avoid collisions."),
  },
});

registerBridgeTool(METHODS.MOVE_WIDGET, {
  title: "Move widget",
  description:
    "Reparent and/or reorder (z-order) a widget subtree by objID; the objID is preserved. " +
    "Provide newParent (an objID) and/or targetPage to reparent, and index to set sibling order. Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    newParent: objID.optional().describe("New parent widget objID to move under."),
    targetPage: pageName.optional().describe("Page to move the widget to (its screen root)."),
    index: z.number().int().nonnegative().optional().describe("New position index among siblings (z-order)."),
  },
});

registerBridgeTool(METHODS.ALIGN_WIDGETS, {
  title: "Align widgets",
  description:
    "Align or distribute a set of widgets (by objID) relative to each other. mode is one of " +
    "left, right, top, bottom, centerH, centerV, distributeH, distributeV. Returns { objIDs }. One undo step.",
  inputSchema: {
    objIDs: z.array(objID).describe("Widget objIDs to align/distribute together."),
    mode: z
      .enum(["left", "right", "top", "bottom", "centerH", "centerV", "distributeH", "distributeV"])
      .describe("Alignment/distribution mode."),
  },
});

registerBridgeTool(METHODS.COPY_STYLE, {
  title: "Copy style",
  description:
    "Copy local-style cells from one widget to another (both by objID). Restrict to a specific part/state, or omit to copy all. " +
    "Returns { objID } of the target. One undo step.",
  inputSchema: {
    fromObjID: objID.describe("Source widget objID to copy local styles from."),
    toObjID: objID.describe("Target widget objID to copy local styles onto."),
    part: part.optional().describe("Restrict to this part; omit to copy all parts."),
    state: state.optional().describe("Restrict to this state; omit to copy all states."),
  },
});

registerBridgeTool(METHODS.LIST_WIDGET_CLASSES, {
  title: "List widget classes",
  description:
    "List every creatable widget type with its editable props and supported events: " +
    "[{ className, props: [{ name, type, enumValues? }], events? }]. " +
    "Use it so create_widget/update_widget can drive any widget type (slider, dropdown, roller, tabview, keyboard, switch, bar, arc, ...) " +
    "without guessing prop names. Read-only.",
  inputSchema: {},
});

// --- Assets — write (each call is one undo step) ---------------------------

registerBridgeTool(METHODS.ADD_BITMAP, {
  title: "Add bitmap",
  description:
    "Import an image as a named bitmap (GUI \"Add Bitmap\"), referenceable by name in an LVGLImageWidget's image prop. " +
    "Provide the source as filePath OR dataBase64, and optionally colorFormat. Returns { name, width, height }. " +
    "May run an async image-convert step. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique name for the imported bitmap."),
    filePath: z.string().optional().describe("Path to the source image (mutually exclusive with dataBase64)."),
    dataBase64: z.string().optional().describe("Raw base64 image bytes (no data: prefix; mutually exclusive with filePath)."),
    colorFormat: z.string().optional().describe("LVGL color format for the bitmap (bare, without LV_ prefix)."),
  },
});

registerBridgeTool(METHODS.DELETE_BITMAP, {
  title: "Delete bitmap",
  description: "Delete a bitmap by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the bitmap to delete."),
  },
});

registerBridgeTool(METHODS.ADD_FONT, {
  title: "Add font",
  description:
    "Import a TTF as a named LVGL font with glyph ranges, referenceable by name in text_font style props. " +
    "Returns { name }. Runs an async extract step — check get_notifications afterward for extraction failures. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique name for the font."),
    filePath: z.string().describe("Path to the source .ttf file."),
    size: z.number().int().positive().describe("Font size in px."),
    bpp: z.number().int().positive().describe("Bits per pixel (anti-aliasing depth), e.g. 1, 2, 4, 8."),
    ranges: z.string().describe("Glyph ranges to include, e.g. \"0x20-0x7F,0x131\"."),
  },
});

registerBridgeTool(METHODS.EDIT_FONT, {
  title: "Edit font",
  description:
    "Change a font's ranges/size/bpp and re-extract (e.g. to fix missing ▯ glyphs). Address by name. " +
    "Returns { name }. Runs an async re-extract step — check get_notifications afterward. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the font to edit."),
    size: z.number().int().positive().optional().describe("New font size in px."),
    bpp: z.number().int().positive().optional().describe("New bits per pixel."),
    ranges: z.string().optional().describe("New glyph ranges, e.g. \"0x20-0x7F,0x131\"."),
  },
});

registerBridgeTool(METHODS.DELETE_FONT, {
  title: "Delete font",
  description: "Delete a font by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the font to delete."),
  },
});

registerBridgeTool(METHODS.CREATE_ACTION, {
  title: "Create action",
  description:
    "Create a named action so bind_event can bind it; codegen emits action_<name>. " +
    'implementationType defaults to "native" (the no-flow form). Returns { name }. One undo step.',
  inputSchema: {
    name: z.string().describe("Unique action name."),
    implementationType: z
      .enum(["native", "flow"])
      .optional()
      .describe('Action implementation type (default "native").'),
  },
});

registerBridgeTool(METHODS.DELETE_ACTION, {
  title: "Delete action",
  description: "Delete an action by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the action to delete."),
  },
});

registerBridgeTool(METHODS.CREATE_STYLE, {
  title: "Create style",
  description:
    "Create a reusable named style (referenced via a widget's useStyle prop). forWidgetType scopes it to a widget class; " +
    "values is a map of style prop -> value. Returns { name }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: z.string().describe("Unique style name."),
    forWidgetType: z.string().describe("Widget class the style applies to, e.g. \"LVGLButtonWidget\"."),
    values: z
      .record(z.string(), z.unknown())
      .describe("Style props to set, e.g. { \"bg_color\": \"#204080\", \"radius\": 8 }."),
  },
});

registerBridgeTool(METHODS.UPDATE_STYLE, {
  title: "Update style",
  description:
    "Set or clear cells on a shared named style, addressed by name. Restrict to a part/state; " +
    "values is a map of style prop -> value. Returns { name }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: z.string().describe("Name of the style to update."),
    part: part.optional().describe("Bare LVGL part selector; omit for the default part."),
    state: state.optional().describe("Bare LVGL state selector; omit for the default state."),
    values: z
      .record(z.string(), z.unknown())
      .describe("Style props to set/clear (object-model string form)."),
  },
});

registerBridgeTool(METHODS.DELETE_STYLE, {
  title: "Delete style",
  description: "Delete a named style by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the style to delete."),
  },
});

registerBridgeTool(METHODS.LIST_COLORS, {
  title: "List colors",
  description:
    "List the theme palette as [{ name, value }], where value is \"#rrggbb\". " +
    "Reference these color names anywhere a color value is accepted. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_COLOR, {
  title: "Add color",
  description:
    "Add a named theme color. value is \"#rrggbb\". Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique theme color name."),
    value: z.string().describe('Color value as "#rrggbb".'),
  },
});

registerBridgeTool(METHODS.UPDATE_COLOR, {
  title: "Update color",
  description:
    "Change a named theme color's value (\"#rrggbb\"), addressed by name. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the theme color to update."),
    value: z.string().describe('New color value as "#rrggbb".'),
  },
});

registerBridgeTool(METHODS.DELETE_COLOR, {
  title: "Delete color",
  description: "Delete a named theme color by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the theme color to delete."),
  },
});

// --- Variables (flow projects + no-flow globals) ---------------------------

registerBridgeTool(METHODS.LIST_VARIABLES, {
  title: "List variables",
  description:
    "List project/global variables as [{ name, type, defaultValue? }]. Variables are addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_VARIABLE, {
  title: "Add variable",
  description:
    "Add a project/global variable by name with a type and optional defaultValue. Returns { name }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: z.string().describe("Unique variable name."),
    type: z.string().describe("Variable type (object-model type string)."),
    defaultValue: z.unknown().optional().describe("Optional default value (object-model string form)."),
  },
});

registerBridgeTool(METHODS.UPDATE_VARIABLE, {
  title: "Update variable",
  description:
    "Update a variable's props by name (e.g. type, defaultValue). props is a map of property -> value. " +
    "Returns { name }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: z.string().describe("Name of the variable to update."),
    props: z
      .record(z.string(), z.unknown())
      .describe("Variable property keys to set (object-model string form)."),
  },
});

registerBridgeTool(METHODS.DELETE_VARIABLE, {
  title: "Delete variable",
  description: "Delete a variable by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the variable to delete."),
  },
});

// --- Project / build -------------------------------------------------------

registerBridgeTool(METHODS.GET_SETTINGS, {
  title: "Get settings",
  description:
    "Read project settings — a superset of get_project_info: { displayWidth, displayHeight, projectVersion, lvglVersion, " +
    "colorFormat, lvglInclude, flowSupport, buildDestination, ... }. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.UPDATE_SETTINGS, {
  title: "Update settings",
  description:
    "Update project settings via updateObject(settings.general | settings.build, ...). Pass a general and/or build map " +
    "of setting key -> value. Returns { updated }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    general: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("settings.general keys to update (object-model string form)."),
    build: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("settings.build keys to update (object-model string form)."),
  },
});

registerBridgeTool(METHODS.BUILD, {
  title: "Build project",
  description:
    "Run EEZ Studio's Check + Generate (non-Docker LVGL codegen) to the configured destination. " +
    "Returns { ok, errors: Problem[], warnings: Problem[], generatedFiles: string[] }. " +
    "Runs an async generate step; inspect errors/warnings (each { severity, text, objID?, path?, label? }) on failure.",
  inputSchema: {},
});

// --- Widgets — sub-items (matrix buttons, meter indicators/scales/spans) ----
// (each call is one undo step)

registerBridgeTool(METHODS.ADD_MATRIX_BUTTON, {
  title: "Add matrix button",
  description:
    "Append a button to an LVGLButtonMatrixWidget's map (address the matrix by objID). " +
    "text is the button label; width is the relative column width; newLine forces a row break after it; " +
    "ctrl is a map of button control flags (e.g. { \"HIDDEN\": false, \"CHECKABLE\": true }). " +
    "index inserts at a position instead of appending. Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    text: z.string().optional().describe("Button label text."),
    width: z.number().int().positive().optional().describe("Relative column width for the button."),
    newLine: z.boolean().optional().describe("Force a row break after this button."),
    ctrl: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Button control flags, e.g. { \"CHECKABLE\": true, \"HIDDEN\": false }."),
    index: z.number().int().nonnegative().optional().describe("Insertion index in the button map (append if omitted)."),
  },
});

registerBridgeTool(METHODS.UPDATE_MATRIX_BUTTON, {
  title: "Update matrix button",
  description:
    "Update one existing button in an LVGLButtonMatrixWidget's map by index (matrix addressed by objID). " +
    "props is a map of button fields to change (e.g. { \"text\": \"OK\", \"width\": 2, \"newLine\": true, \"ctrl\": {...} }). " +
    "Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    index: z.number().int().nonnegative().describe("Index of the button to update in the map."),
    props: z
      .record(z.string(), z.unknown())
      .describe("Button fields to update (object-model string form)."),
  },
});

registerBridgeTool(METHODS.ADD_METER_INDICATOR, {
  title: "Add meter indicator",
  description:
    "Add an indicator to an LVGLMeterWidget (address by objID). type selects the indicator kind. " +
    "scaleIndex picks which scale it belongs to; props sets indicator fields (e.g. color, value, startValue, endValue). " +
    "index inserts at a position. Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    type: z
      .enum(["NEEDLE_IMG", "NEEDLE_LINE", "SCALE_LINES", "ARC"])
      .describe("Indicator kind to add."),
    scaleIndex: z.number().int().nonnegative().optional().describe("Index of the scale the indicator belongs to."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Indicator field values (object-model string form)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among indicators (append if omitted)."),
  },
});

registerBridgeTool(METHODS.ADD_METER_SCALE, {
  title: "Add meter scale",
  description:
    "Add a scale to an LVGLMeterWidget (address by objID). props sets scale fields " +
    "(e.g. minValue, maxValue, angleRange, rotation, tick counts/colors). index inserts at a position. " +
    "Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Scale field values (object-model string form)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among scales (append if omitted)."),
  },
});

registerBridgeTool(METHODS.ADD_SCALE_SECTION, {
  title: "Add scale section",
  description:
    "Add a colored section to an LVGLScaleWidget (address by objID). props sets section fields " +
    "(e.g. startValue, endValue, and the section's part styles). index inserts at a position. " +
    "Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Section field values (object-model string form)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among sections (append if omitted)."),
  },
});

registerBridgeTool(METHODS.ADD_SPAN, {
  title: "Add span",
  description:
    "Append a text span to an LVGLSpangroupWidget (address by objID). text is the span content; " +
    "props sets span style fields (e.g. text_color, text_font). index inserts at a position. " +
    "Returns { objID, index }." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    text: z.string().optional().describe("Span text content."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Span field/style values (object-model string form)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among spans (append if omitted)."),
  },
});

registerBridgeTool(METHODS.DELETE_SUBITEM, {
  title: "Delete widget sub-item",
  description:
    "Delete a sub-item from a widget by objID: a matrix button, meter indicator, meter scale, scale section, or span. " +
    "kind selects the sub-item family; index selects which one. Returns { objID, index }. One undo step.",
  inputSchema: {
    objID,
    kind: z
      .enum(["button", "indicator", "scale", "section", "span"])
      .optional()
      .describe("Sub-item family to delete from."),
    index: z.number().int().nonnegative().optional().describe("Index of the sub-item to delete."),
  },
});

// --- Widgets — flags / states / layout / scroll / grid-cell ----------------
// (each call is one undo step)

registerBridgeTool(METHODS.SET_FLAG, {
  title: "Set widget flag",
  description:
    "Toggle a single LVGL widget flag on a widget by objID. flag is a bare flag name (e.g. \"HIDDEN\", \"CLICKABLE\", " +
    "\"SCROLLABLE\", \"CHECKABLE\"); on turns it on/off. Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    flag: z.string().describe('Bare LVGL flag name, e.g. "HIDDEN", "CLICKABLE", "SCROLLABLE".'),
    on: z.boolean().describe("Whether to set (true) or clear (false) the flag."),
  },
});

registerBridgeTool(METHODS.SET_STATE, {
  title: "Set widget state",
  description:
    "Toggle a single LVGL widget state on a widget by objID. state is a bare state name (e.g. \"CHECKED\", " +
    "\"DISABLED\", \"PRESSED\"); on turns it on/off. Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    state: z.string().describe('Bare LVGL state name, e.g. "CHECKED", "DISABLED", "PRESSED".'),
    on: z.boolean().describe("Whether to set (true) or clear (false) the state."),
  },
});

registerBridgeTool(METHODS.SET_LAYOUT, {
  title: "Set widget layout",
  description:
    "Set a widget's layout (address by objID). layout picks NONE, FLEX, or GRID. For FLEX, set flexFlow and the " +
    "*Place alignments; for GRID, set gridColumns/gridRows track templates. Bare values, no LV_ prefix. " +
    "Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    layout: z.enum(["NONE", "FLEX", "GRID"]).describe("Layout mode for the widget."),
    flexFlow: z.string().optional().describe('FLEX flow, e.g. "ROW", "COLUMN", "ROW_WRAP".'),
    flexMainPlace: z.string().optional().describe("FLEX main-axis placement (justify)."),
    flexCrossPlace: z.string().optional().describe("FLEX cross-axis placement (align items)."),
    flexTrackPlace: z.string().optional().describe("FLEX track placement (align content)."),
    gridColumns: z.string().optional().describe("GRID column track template."),
    gridRows: z.string().optional().describe("GRID row track template."),
  },
});

registerBridgeTool(METHODS.SET_SCROLL, {
  title: "Set widget scroll",
  description:
    "Configure a widget's scrolling behavior (address by objID): scrollbarMode, scrollDirection, and snap-align " +
    "on X/Y. Bare values, no LV_ prefix. Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    scrollbarMode: z.string().optional().describe('Scrollbar mode, e.g. "OFF", "ON", "ACTIVE", "AUTO".'),
    scrollDirection: z.string().optional().describe('Allowed scroll direction, e.g. "ALL", "HOR", "VER".'),
    scrollSnapX: z.string().optional().describe('Horizontal snap alignment, e.g. "NONE", "START", "CENTER", "END".'),
    scrollSnapY: z.string().optional().describe('Vertical snap alignment, e.g. "NONE", "START", "CENTER", "END".'),
  },
});

registerBridgeTool(METHODS.SET_GRID_CELL, {
  title: "Set grid cell placement",
  description:
    "Place a widget within its parent's GRID layout (address the child by objID): column/row position, span, and " +
    "per-axis alignment. Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    colPos: z.number().int().nonnegative().optional().describe("Grid column position (0-based)."),
    colSpan: z.number().int().positive().optional().describe("Number of columns to span."),
    xAlign: z.string().optional().describe('Horizontal cell alignment, e.g. "START", "CENTER", "END", "STRETCH".'),
    rowPos: z.number().int().nonnegative().optional().describe("Grid row position (0-based)."),
    rowSpan: z.number().int().positive().optional().describe("Number of rows to span."),
    yAlign: z.string().optional().describe('Vertical cell alignment, e.g. "START", "CENTER", "END", "STRETCH".'),
  },
});

// --- Enums / structures / user-widgets -------------------------------------
// (list_* are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.LIST_ENUMS, {
  title: "List enums",
  description:
    "List project enums as [{ name, members: [{ name, value }] }]. Enums are addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_ENUM, {
  title: "Add enum",
  description:
    "Create a project enum by name, optionally seeded with members. Each member is { name, specificValue?, automaticValue? }. " +
    "Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique enum name."),
    members: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Optional initial members, each { name, specificValue?, automaticValue? }."),
  },
});

registerBridgeTool(METHODS.ADD_ENUM_MEMBER, {
  title: "Add enum member",
  description:
    "Add a member to an existing enum (by enumName). name is the member name. Set specificValue for a fixed int, " +
    "or automaticValue true to auto-assign. index inserts at a position. Returns { name }. One undo step.",
  inputSchema: {
    enumName: z.string().describe("Name of the enum to add the member to."),
    name: z.string().describe("New member name."),
    specificValue: z.number().int().optional().describe("Explicit integer value for the member."),
    automaticValue: z.boolean().optional().describe("Auto-assign the value instead of a specific one."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among members."),
  },
});

registerBridgeTool(METHODS.UPDATE_ENUM_MEMBER, {
  title: "Update enum member",
  description:
    "Update an enum member's props (by enumName + memberName). props is a map of member fields " +
    "(e.g. { \"name\": \"NEW\", \"specificValue\": 5 }). Returns { name }. One undo step.",
  inputSchema: {
    enumName: z.string().describe("Name of the enum that owns the member."),
    memberName: z.string().describe("Name of the member to update."),
    props: z
      .record(z.string(), z.unknown())
      .describe("Member fields to update (object-model string form)."),
  },
});

registerBridgeTool(METHODS.DELETE_ENUM, {
  title: "Delete enum or member",
  description:
    "Delete an enum by name, or just one member if memberName is given. Returns { deleted }. One undo step.",
  inputSchema: {
    enumName: z.string().describe("Name of the enum to delete (or the enum that owns the member)."),
    memberName: z.string().optional().describe("If given, delete only this member instead of the whole enum."),
  },
});

registerBridgeTool(METHODS.LIST_STRUCTURES, {
  title: "List structures",
  description:
    "List project structures as [{ name, fields: [{ name, type }] }]. Structures are addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_STRUCTURE, {
  title: "Add structure",
  description:
    "Create a project structure by name, optionally seeded with fields. Each field is { name, type }. " +
    "Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique structure name."),
    fields: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Optional initial fields, each { name, type }."),
  },
});

registerBridgeTool(METHODS.ADD_STRUCTURE_FIELD, {
  title: "Add structure field",
  description:
    "Add a field to an existing structure (by structureName). name is the field name; type is the object-model type string. " +
    "index inserts at a position. Returns { name }. One undo step.",
  inputSchema: {
    structureName: z.string().describe("Name of the structure to add the field to."),
    name: z.string().describe("New field name."),
    type: z.string().describe("Field type (object-model type string)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among fields."),
  },
});

registerBridgeTool(METHODS.DELETE_STRUCTURE, {
  title: "Delete structure or field",
  description:
    "Delete a structure by name, or just one field if fieldName is given. Returns { deleted }. One undo step.",
  inputSchema: {
    structureName: z.string().describe("Name of the structure to delete (or the structure that owns the field)."),
    fieldName: z.string().optional().describe("If given, delete only this field instead of the whole structure."),
  },
});

registerBridgeTool(METHODS.LIST_USER_WIDGETS, {
  title: "List user widgets",
  description:
    "List reusable user widgets (LVGLUserWidget definitions) as [{ name, width, height }]. Addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.CREATE_USER_WIDGET, {
  title: "Create user widget",
  description:
    "Create a reusable user widget definition by name. width/height default to the display size. " +
    "Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique user-widget name."),
    width: z.number().int().positive().optional().describe("Widget width in px (defaults to display width)."),
    height: z.number().int().positive().optional().describe("Widget height in px (defaults to display height)."),
  },
});

registerBridgeTool(METHODS.DELETE_USER_WIDGET, {
  title: "Delete user widget",
  description: "Delete a user widget definition by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the user widget to delete."),
  },
});

// --- Groups / themes -------------------------------------------------------
// (list_* are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.LIST_GROUPS, {
  title: "List groups",
  description:
    "List LVGL input groups as [{ name }]. Groups are addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.CREATE_GROUP, {
  title: "Create group",
  description: "Create an LVGL input group by name. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique group name."),
  },
});

registerBridgeTool(METHODS.ASSIGN_WIDGET_GROUP, {
  title: "Assign widget to group",
  description:
    "Assign a widget (by objID) to an input group by name; groupIndex sets its tab order within the group. " +
    "Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    group: z.string().describe("Name of the group to assign the widget to."),
    groupIndex: z.number().int().nonnegative().optional().describe("Tab-order position within the group."),
  },
});

registerBridgeTool(METHODS.SET_GROUP_TAB_ORDER, {
  title: "Set widget group tab order",
  description:
    "Set a widget's tab-order index within its assigned group (address the widget by objID). Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    groupIndex: z.number().int().nonnegative().describe("New tab-order position within the group."),
  },
});

registerBridgeTool(METHODS.RENAME_GROUP, {
  title: "Rename group",
  description:
    "Rename an input group. Groups are addressed by name, so update references accordingly. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Current group name."),
    newName: z.string().describe("New unique group name."),
  },
});

registerBridgeTool(METHODS.DELETE_GROUP, {
  title: "Delete group",
  description: "Delete an input group by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the group to delete."),
  },
});

registerBridgeTool(METHODS.SET_GROUP_DEFAULTS, {
  title: "Set default groups",
  description:
    "Set the project's default encoder and/or keyboard input groups (by group name). Returns { updated }. One undo step.",
  inputSchema: {
    encoderGroup: z.string().optional().describe("Name of the default encoder group."),
    keyboardGroup: z.string().optional().describe("Name of the default keyboard group."),
  },
});

registerBridgeTool(METHODS.LIST_THEMES, {
  title: "List themes",
  description:
    "List project themes as [{ name, active }], where active flags the current theme. Themes are addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.CREATE_THEME, {
  title: "Create theme",
  description: "Create a project theme by name. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique theme name."),
  },
});

registerBridgeTool(METHODS.SET_ACTIVE_THEME, {
  title: "Set active theme",
  description: "Make a theme the active/selected theme by name. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the theme to activate."),
  },
});

registerBridgeTool(METHODS.SET_THEME_COLOR, {
  title: "Set theme color",
  description:
    "Set a named theme color's value within a specific theme. theme is the theme name, color is the theme-color name, " +
    'value is "#rrggbb". Returns { name }. One undo step.',
  inputSchema: {
    theme: z.string().describe("Name of the theme to edit."),
    color: z.string().describe("Name of the theme color to set."),
    value: z.string().describe('Color value as "#rrggbb".'),
  },
});

registerBridgeTool(METHODS.RENAME_THEME, {
  title: "Rename theme",
  description:
    "Rename a theme. Themes are addressed by name, so update references accordingly. Returns { name }. One undo step.",
  inputSchema: {
    name: z.string().describe("Current theme name."),
    newName: z.string().describe("New unique theme name."),
  },
});

registerBridgeTool(METHODS.DELETE_THEME, {
  title: "Delete theme",
  description: "Delete a theme by name. Returns { deleted }. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the theme to delete."),
  },
});

// --- Search / references (read-only, except replace_in_project) ------------

registerBridgeTool(METHODS.SEARCH_PROJECT, {
  title: "Search project",
  description:
    "Search the whole project for a text pattern (identifiers, texts, asset names, prop values). " +
    "Returns { matches: [{ objID?, path?, text, label? }] } — use objID/path to navigate to a hit. Read-only.",
  inputSchema: {
    pattern: z.string().describe("Text pattern to search for."),
    matchCase: z.boolean().optional().describe("Case-sensitive match (default false)."),
    matchWholeWord: z.boolean().optional().describe("Match whole words only (default false)."),
    limit: z.number().int().positive().optional().describe("Max matches to return."),
  },
});

registerBridgeTool(METHODS.FIND_REFERENCES, {
  title: "Find references",
  description:
    "Find every place that references a given object/asset (address it by objID OR path). " +
    "Returns { references: [{ objID?, path?, label? }] }. Read-only.",
  inputSchema: {
    objID: objID.optional().describe("Object to find references to (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path to find references to (mutually exclusive with objID)."),
  },
});

registerBridgeTool(METHODS.REPLACE_IN_PROJECT, {
  title: "Replace in project",
  description:
    "Find-and-replace a text pattern across the project. Optionally scope with target (a path/collection). " +
    "Returns { replaced }. One undo step.",
  inputSchema: {
    pattern: z.string().describe("Text pattern to find."),
    replacement: z.string().describe("Replacement text."),
    matchCase: z.boolean().optional().describe("Case-sensitive match (default false)."),
    matchWholeWord: z.boolean().optional().describe("Match whole words only (default false)."),
    target: z.string().optional().describe("Optional path/collection to scope the replacement to."),
  },
});

registerBridgeTool(METHODS.IS_REFERENCED, {
  title: "Is referenced",
  description:
    "Check whether an object/asset (by objID OR path) is referenced anywhere. " +
    "Returns { referenced, count }. Use before deleting to avoid breaking references. Read-only.",
  inputSchema: {
    objID: objID.optional().describe("Object to check (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path to check (mutually exclusive with objID)."),
  },
});

registerBridgeTool(METHODS.RESOLVE_PATH, {
  title: "Resolve path",
  description:
    "Resolve an object path to its objID, or an objID to its object path (supply whichever you have). " +
    "Returns { objID?, path? }. Read-only.",
  inputSchema: {
    path: z.string().optional().describe("Object path to resolve to an objID."),
    objID: objID.optional().describe("objID to resolve to an object path."),
  },
});

// --- Clipboard (paste/cut are one undo step) -------------------------------

registerBridgeTool(METHODS.COPY_OBJECTS, {
  title: "Copy objects",
  description:
    "Copy widgets (by objID) to the clipboard for later paste_objects. Returns { objIDs }.",
  inputSchema: {
    objIDs: z.array(z.string()).describe("Widget objIDs to copy to the clipboard."),
  },
});

registerBridgeTool(METHODS.CUT_OBJECTS, {
  title: "Cut objects",
  description:
    "Cut widgets (by objID) to the clipboard (removes them, ready to paste_objects). Returns { objIDs }. One undo step.",
  inputSchema: {
    objIDs: z.array(z.string()).describe("Widget objIDs to cut to the clipboard."),
  },
});

registerBridgeTool(METHODS.PASTE_OBJECTS, {
  title: "Paste objects",
  description:
    "Paste the clipboard contents into a target: into.objID nests under a widget, or into.page adds to a page root. " +
    "index sets sibling position. Returns { objIDs } of the pasted widgets. One undo step.",
  inputSchema: {
    into: z
      .object({
        objID: z.string().optional().describe("Parent widget objID to paste under."),
        page: z.string().optional().describe("Page name to paste onto its screen root."),
      })
      .describe("Paste destination (a widget objID or a page)."),
    index: z.number().int().nonnegative().optional().describe("Insertion index among siblings."),
  },
});

registerBridgeTool(METHODS.GET_CLIPBOARD_INFO, {
  title: "Get clipboard info",
  description:
    "Describe the current clipboard contents and whether it can be pasted into a target. " +
    "Pass optional into ({ objID?, page? }) to test paste-ability for that destination. " +
    "Returns { empty, count, canPaste }. Read-only.",
  inputSchema: {
    into: z
      .object({
        objID: z.string().optional().describe("Prospective parent widget objID."),
        page: z.string().optional().describe("Prospective destination page name."),
      })
      .optional()
      .describe("Optional destination to test paste-ability against."),
  },
});

// --- Editors & navigation --------------------------------------------------

registerBridgeTool(METHODS.REVEAL_OBJECT, {
  title: "Reveal object",
  description:
    "Reveal an object (by objID OR path) in the GUI: optionally open its editor, show it in the navigation panel, " +
    "and/or select it. Returns { objID?, path? }.",
  inputSchema: {
    objID: objID.optional().describe("Object to reveal (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path to reveal (mutually exclusive with objID)."),
    openEditor: z.boolean().optional().describe("Open the object's editor tab."),
    showInNavigation: z.boolean().optional().describe("Show the object in the navigation panel."),
    select: z.boolean().optional().describe("Select the object."),
  },
});

registerBridgeTool(METHODS.OPEN_EDITOR, {
  title: "Open editor",
  description:
    "Open an editor tab for an object (by objID OR path). permanent keeps it as a pinned tab instead of preview. " +
    "Returns { objID?, path?, title? }.",
  inputSchema: {
    objID: objID.optional().describe("Object to open (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path to open (mutually exclusive with objID)."),
    permanent: z.boolean().optional().describe("Pin the tab (not a transient preview)."),
  },
});

registerBridgeTool(METHODS.ACTIVATE_EDITOR, {
  title: "Activate editor",
  description:
    "Bring an already-open editor tab to the foreground (by objID OR path). Returns { objID?, path?, title? }.",
  inputSchema: {
    objID: objID.optional().describe("Object whose editor to activate (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path whose editor to activate (mutually exclusive with objID)."),
  },
});

registerBridgeTool(METHODS.LIST_EDITORS, {
  title: "List editors",
  description:
    "List open editor tabs as [{ objID?, path?, title, active, permanent }]. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.CLOSE_EDITOR, {
  title: "Close editor",
  description:
    "Close an open editor tab (by objID OR path). Returns { objID?, path?, title? }.",
  inputSchema: {
    objID: objID.optional().describe("Object whose editor to close (mutually exclusive with path)."),
    path: z.string().optional().describe("Object path whose editor to close (mutually exclusive with objID)."),
  },
});

registerBridgeTool(METHODS.GET_ACTIVE_EDITOR, {
  title: "Get active editor",
  description:
    "Return the currently-active editor tab as { objID?, path?, title? }. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SELECT_ALL, {
  title: "Select all",
  description:
    "Select all widgets in the active page editor. Returns the resulting selection.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SET_SELECTION, {
  title: "Set selection",
  description:
    "Replace the current selection with the given widgets (by objID). ensureVisible scrolls them into view. " +
    "Returns the resulting selection.",
  inputSchema: {
    objIDs: z.array(z.string()).describe("Widget objIDs to select."),
    ensureVisible: z.boolean().optional().describe("Scroll the selection into view."),
  },
});

registerBridgeTool(METHODS.GET_NAVIGATION_STATE, {
  title: "Get navigation state",
  description:
    "Return the navigation panel's current selection as { collection, objID, path }. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SELECT_IN_NAVIGATION, {
  title: "Select in navigation",
  description:
    "Select an item in the navigation panel: collection is the panel/collection name (e.g. \"pages\", \"styles\"), " +
    "and objID OR path addresses the item within it. Returns { collection, objID, path }.",
  inputSchema: {
    collection: z.string().describe('Navigation collection name, e.g. "pages", "styles", "fonts".'),
    objID: objID.optional().describe("Item to select (mutually exclusive with path)."),
    path: z.string().optional().describe("Item path to select (mutually exclusive with objID)."),
  },
});

// --- Scrapbook -------------------------------------------------------------

registerBridgeTool(METHODS.LIST_SCRAPBOOK_ITEMS, {
  title: "List scrapbook items",
  description:
    "List reusable scrapbook items as [{ itemId, name, description? }]. Pass file to read a specific scrapbook file. " +
    "Insert one with insert_scrapbook_item. Read-only.",
  inputSchema: {
    file: z.string().optional().describe("Optional scrapbook file path to read (defaults to the active scrapbook)."),
  },
});

registerBridgeTool(METHODS.INSERT_SCRAPBOOK_ITEM, {
  title: "Insert scrapbook item",
  description:
    "Insert a scrapbook item (by itemId, from list_scrapbook_items) into the active editor/selection. One undo step.",
  inputSchema: {
    itemId: z.string().describe("Id of the scrapbook item to insert (see list_scrapbook_items)."),
  },
});

registerBridgeTool(METHODS.SAVE_SELECTION_TO_SCRAPBOOK, {
  title: "Save selection to scrapbook",
  description:
    "Save the current selection as a reusable scrapbook item, with an optional name and description. " +
    "Returns the saved item.",
  inputSchema: {
    name: z.string().optional().describe("Optional name for the scrapbook item."),
    description: z.string().optional().describe("Optional description for the scrapbook item."),
  },
});

// --- Texts / i18n ----------------------------------------------------------
// (list_* / export_texts are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.LIST_LANGUAGES, {
  title: "List languages",
  description:
    "List the project's i18n languages as [{ languageID }]. Languages are addressed by languageID. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_LANGUAGE, {
  title: "Add language",
  description:
    "Add an i18n language by languageID (e.g. \"en\", \"de\"). Returns the updated language list. One undo step.",
  inputSchema: {
    languageID: z.string().describe('Unique language id, e.g. "en", "de", "fr".'),
  },
});

registerBridgeTool(METHODS.LIST_TEXT_RESOURCES, {
  title: "List text resources",
  description:
    "List i18n text resources as [{ resourceID, translations }], where translations maps languageID -> text. " +
    "Pass languageID to include only that language's text. Read-only.",
  inputSchema: {
    languageID: z.string().optional().describe("Limit translations to this language id (omit for all)."),
  },
});

registerBridgeTool(METHODS.ADD_TEXT_RESOURCE, {
  title: "Add text resource",
  description:
    "Add an i18n text resource (a translatable string key) by resourceID. Returns the added resource. One undo step.",
  inputSchema: {
    resourceID: z.string().describe("Unique text resource id (the translation key)."),
  },
});

registerBridgeTool(METHODS.SET_TRANSLATION, {
  title: "Set translation",
  description:
    "Set the text of a resource (by resourceID) for a specific language (by languageID). Returns the updated resource. One undo step.",
  inputSchema: {
    resourceID: z.string().describe("Id of the text resource to translate."),
    languageID: z.string().describe("Language id to set the text for."),
    text: z.string().describe("Translated text for this resource/language."),
  },
});

registerBridgeTool(METHODS.SET_WIDGET_TEXT_RESOURCE, {
  title: "Set widget text resource",
  description:
    "Bind a widget's text to an i18n text resource: address the widget by objID and the resource by resourceID. " +
    "Returns { objID }. One undo step.",
  inputSchema: {
    objID,
    resourceID: z.string().describe("Id of the text resource to bind the widget's text to."),
  },
});

registerBridgeTool(METHODS.DELETE_LANGUAGE, {
  title: "Delete language",
  description:
    "Delete an i18n language by languageID (removes its translations). Returns { deleted }. One undo step.",
  inputSchema: {
    languageID: z.string().describe("Language id to delete."),
  },
});

registerBridgeTool(METHODS.RENAME_LANGUAGE, {
  title: "Rename language",
  description:
    "Rename an i18n language's id. Languages are addressed by languageID, so update references accordingly. " +
    "Returns the updated language. One undo step.",
  inputSchema: {
    languageID: z.string().describe("Current language id."),
    newLanguageID: z.string().describe("New unique language id."),
  },
});

registerBridgeTool(METHODS.RENAME_TEXT_RESOURCE, {
  title: "Rename text resource",
  description:
    "Rename a text resource's id. Resources are addressed by resourceID, so update references (incl. widget bindings) accordingly. " +
    "Returns the updated resource. One undo step.",
  inputSchema: {
    resourceID: z.string().describe("Current text resource id."),
    newResourceID: z.string().describe("New unique text resource id."),
  },
});

registerBridgeTool(METHODS.DELETE_TEXT_RESOURCE, {
  title: "Delete text resource",
  description: "Delete an i18n text resource by resourceID. Returns { deleted }. One undo step.",
  inputSchema: {
    resourceID: z.string().describe("Id of the text resource to delete."),
  },
});

registerBridgeTool(METHODS.IMPORT_TEXTS, {
  title: "Import texts",
  description:
    "Import i18n languages/resources/translations from a serialized document. format is csv, json, or xliff; " +
    "data is the document body. mode merges into existing texts or replaces them (default merge). " +
    "Returns { imported }. One undo step.",
  inputSchema: {
    format: z.enum(["csv", "json", "xliff"]).describe("Serialized document format."),
    data: z.string().describe("The serialized texts document body to import."),
    mode: z
      .enum(["merge", "replace"])
      .optional()
      .describe('Whether to merge into or replace existing texts (default "merge").'),
  },
});

registerBridgeTool(METHODS.EXPORT_TEXTS, {
  title: "Export texts",
  description:
    "Export all i18n languages/resources/translations as a serialized document. format is csv, json, or xliff. " +
    "Returns { format, data }. Read-only.",
  inputSchema: {
    format: z.enum(["csv", "json", "xliff"]).describe("Serialized document format to export."),
  },
});

// --- Font & bitmap options -------------------------------------------------
// (list_font_glyphs / export_bitmap are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.SET_FONT_RANGES, {
  title: "Set font ranges",
  description:
    "Set the included glyph ranges on a font by name and re-extract. Returns { name }. " +
    "Runs an async re-extract — check get_notifications afterward. One undo step.",
  inputSchema: {
    fontName: z.string().describe("Name of the font to edit."),
    ranges: z.string().describe('Glyph ranges to include, e.g. "0x20-0x7F,0x131".'),
  },
});

registerBridgeTool(METHODS.SET_FONT_SYMBOLS, {
  title: "Set font symbols",
  description:
    "Set the explicit extra symbols/characters to include on a font by name and re-extract. Returns { name }. " +
    "Runs an async re-extract — check get_notifications afterward. One undo step.",
  inputSchema: {
    fontName: z.string().describe("Name of the font to edit."),
    symbols: z.string().describe("Explicit characters/symbols to include, e.g. \"°±µ\"."),
  },
});

registerBridgeTool(METHODS.LIST_FONT_GLYPHS, {
  title: "List font glyphs",
  description:
    "List the glyphs a font currently includes as [{ encoding, char? }] (encoding is the unicode code point). " +
    "Use to verify a font actually has the characters your text needs. Read-only.",
  inputSchema: {
    fontName: z.string().describe("Name of the font to inspect."),
  },
});

registerBridgeTool(METHODS.ADD_FONT_ADDITIONAL_SOURCE, {
  title: "Add font additional source",
  description:
    "Add an additional source TTF to an existing font (by name) to cover extra ranges/symbols (e.g. an icon font). " +
    "Provide filePath and optionally ranges and/or symbols to pull from it. Returns { name }. " +
    "Runs an async re-extract — check get_notifications afterward. One undo step.",
  inputSchema: {
    fontName: z.string().describe("Name of the font to add a source to."),
    filePath: z.string().describe("Path to the additional source .ttf file."),
    ranges: z.string().optional().describe('Glyph ranges to pull from this source, e.g. "0xE000-0xE0FF".'),
    symbols: z.string().optional().describe("Explicit symbols to pull from this source."),
  },
});

registerBridgeTool(METHODS.SET_BITMAP_OPTIONS, {
  title: "Set bitmap options",
  description:
    "Update a bitmap's build/output options by name: bpp, lvglBinaryOutputFormat, lvglDither, alwaysBuild, and style. " +
    "Only the fields you pass are changed. Returns { name }. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    bitmapName: z.string().describe("Name of the bitmap to configure."),
    bpp: z.number().int().positive().optional().describe("Bits per pixel for the bitmap."),
    lvglBinaryOutputFormat: z
      .string()
      .optional()
      .describe("LVGL binary output format (bare value, no LV_ prefix)."),
    lvglDither: z.boolean().optional().describe("Enable dithering on conversion."),
    alwaysBuild: z.boolean().optional().describe("Always rebuild this bitmap on build."),
    style: z.string().optional().describe("Name of a style to associate with the bitmap."),
  },
});

registerBridgeTool(METHODS.SET_FONT_FALLBACK, {
  title: "Set font fallback",
  description:
    "Set a fallback font (by name) on a font (by name) so missing glyphs render from the fallback instead of ▯. " +
    "Returns { name }. One undo step.",
  inputSchema: {
    fontName: z.string().describe("Name of the font to configure."),
    fallbackFontName: z.string().describe("Name of the fallback font to use for missing glyphs."),
  },
});

registerBridgeTool(METHODS.EXPORT_BITMAP, {
  title: "Export bitmap",
  description:
    "Export a bitmap (by name) to an image file on disk at filePath. Returns { filePath }. Read-only (no project change).",
  inputSchema: {
    bitmapName: z.string().describe("Name of the bitmap to export."),
    filePath: z.string().describe("Destination file path to write the image to."),
  },
});

// --- Settings & features ---------------------------------------------------
// (list_features is read-only; the rest are one undo step each)

registerBridgeTool(METHODS.LIST_FEATURES, {
  title: "List features",
  description:
    "List the optional project features (extensions) as [{ key, name, enabled }] — e.g. Texts, Style, Themes, Flow. " +
    "Use before enable_feature/disable_feature. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ENABLE_FEATURE, {
  title: "Enable feature",
  description:
    "Enable an optional project feature (extension) by key (see list_features). Returns the updated feature list. One undo step.",
  inputSchema: {
    key: z.string().describe("Feature key to enable (see list_features)."),
  },
});

registerBridgeTool(METHODS.DISABLE_FEATURE, {
  title: "Disable feature",
  description:
    "Disable an optional project feature (extension) by key (see list_features). Returns the updated feature list. One undo step.",
  inputSchema: {
    key: z.string().describe("Feature key to disable (see list_features)."),
  },
});

registerBridgeTool(METHODS.ADD_PROJECT_IMPORT, {
  title: "Add project import",
  description:
    "Import another .eez-project as a referenced/imported project. projectFilePath is the path to the imported project; " +
    "importAs sets the alias/namespace it's imported under. Returns the updated import list. One undo step.",
  inputSchema: {
    projectFilePath: z.string().describe("Path to the .eez-project file to import."),
    importAs: z.string().optional().describe("Alias/namespace to import the project under."),
  },
});

registerBridgeTool(METHODS.REMOVE_PROJECT_IMPORT, {
  title: "Remove project import",
  description:
    "Remove an imported project, addressed by importAs (its alias) OR projectFilePath. Returns { deleted }. One undo step.",
  inputSchema: {
    importAs: z.string().optional().describe("Alias of the import to remove (mutually exclusive with projectFilePath)."),
    projectFilePath: z
      .string()
      .optional()
      .describe("Path of the imported project to remove (mutually exclusive with importAs)."),
  },
});

registerBridgeTool(METHODS.ADD_BUILD_CONFIGURATION, {
  title: "Add build configuration",
  description:
    "Add a named build configuration to the project. Returns the added configuration. One undo step.",
  inputSchema: {
    name: z.string().describe("Unique build configuration name."),
  },
});

registerBridgeTool(METHODS.SET_ZOOM, {
  title: "Set editor zoom",
  description:
    "Set the page-editor zoom. mode selects how the level is applied (e.g. \"fit\", \"fill\", \"custom\"); " +
    "level is the zoom factor for custom mode; page limits it to one page (omit for the active editor). Returns the applied zoom.",
  inputSchema: {
    mode: z.string().describe('Zoom mode, e.g. "fit", "fill", "custom".'),
    level: z.number().optional().describe("Zoom factor (for custom mode)."),
    page: pageName.optional().describe("Page to apply the zoom to (omit for the active editor)."),
  },
});

registerBridgeTool(METHODS.SET_README, {
  title: "Set project readme",
  description:
    "Set the project's README file (the Markdown shown in the project's readme section). readmeFile is the path to the .md file. " +
    "Returns { updated }. One undo step.",
  inputSchema: {
    readmeFile: z.string().describe("Path to the README markdown file."),
  },
});

// --- Simulator -------------------------------------------------------------

registerBridgeTool(METHODS.RUN_SIMULATOR, {
  title: "Run simulator",
  description:
    "Start EEZ Studio's LVGL simulator for the current project. Pass debugger true to launch it attached to the debugger. " +
    "Returns the simulator run state.",
  inputSchema: {
    debugger: z.boolean().optional().describe("Launch the simulator attached to the debugger."),
  },
});

registerBridgeTool(METHODS.STOP_SIMULATOR, {
  title: "Stop simulator",
  description: "Stop the running LVGL simulator. Returns the simulator stop state.",
  inputSchema: {},
});

registerBridgeTool(METHODS.GET_SIMULATOR_STATUS, {
  title: "Get simulator status",
  description:
    "Report the current simulator status (running/paused/stopped and related state). Read-only.",
  inputSchema: {},
});

registerScreenshotTool(METHODS.SCREENSHOT_SIMULATOR, {
  title: "Screenshot simulator (PNG)",
  description:
    "Capture a PNG screenshot of the running LVGL simulator surface and return it as an image. " +
    "Use to see exactly what the simulator is currently rendering.",
  inputSchema: {},
});

registerBridgeTool(METHODS.PAUSE_SIMULATOR, {
  title: "Pause simulator",
  description: "Pause the running simulator (debugger). Returns the simulator state.",
  inputSchema: {},
});

registerBridgeTool(METHODS.RESUME_SIMULATOR, {
  title: "Resume simulator",
  description: "Resume a paused simulator (debugger). Returns the simulator state.",
  inputSchema: {},
});

registerBridgeTool(METHODS.STEP_SIMULATOR, {
  title: "Step simulator",
  description:
    "Single-step the paused simulator (debugger). kind selects step over, into, or out. Returns the simulator state.",
  inputSchema: {
    kind: z.enum(["over", "into", "out"]).describe("Step mode: over, into, or out."),
  },
});

// --- Build operations ------------------------------------------------------

registerBridgeTool(METHODS.BUILD_ASSETS, {
  title: "Build assets",
  description:
    "Build only the project's assets (not full codegen) to the configured destination. Returns the build result.",
  inputSchema: {},
});

registerBridgeTool(METHODS.GET_BUILD_DESTINATION, {
  title: "Get build destination",
  description:
    "Return the project's configured build destination folder. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.OPEN_BUILD_FOLDER, {
  title: "Open build folder",
  description:
    "Open the project's build destination folder in the OS file explorer. Returns the opened path.",
  inputSchema: {},
});

registerBridgeTool(METHODS.LIST_BUILD_CONFIGURATIONS, {
  title: "List build configurations",
  description:
    "List the project's named build configurations. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SET_BUILD_CONFIGURATION, {
  title: "Set build configuration",
  description:
    "Select the active build configuration by name (see list_build_configurations). Returns the selected configuration. One undo step.",
  inputSchema: {
    name: z.string().describe("Name of the build configuration to activate."),
  },
});

// --- Full simulator & export -----------------------------------------------

registerBridgeTool(METHODS.START_FULL_SIMULATOR, {
  title: "Start full simulator",
  description:
    "Start the full project simulator (builds then runs). Pass forceRebuild true to rebuild before starting. " +
    "Returns the simulator run state.",
  inputSchema: {
    forceRebuild: z.boolean().optional().describe("Rebuild the project before starting the simulator."),
  },
});

registerBridgeTool(METHODS.STOP_FULL_SIMULATOR, {
  title: "Stop full simulator",
  description: "Stop the full project simulator. Returns the simulator stop state.",
  inputSchema: {},
});

registerBridgeTool(METHODS.EXPORT_DASHBOARD, {
  title: "Export dashboard",
  description:
    "Export the project as a standalone dashboard bundle. Returns the export result.",
  inputSchema: {},
});

registerBridgeTool(METHODS.BUILD_EXTENSIONS, {
  title: "Build extensions",
  description:
    "Build the project's extensions. Pass install true to also install them after building. Returns the build result.",
  inputSchema: {
    install: z.boolean().optional().describe("Install the extensions after building them."),
  },
});

// --- Flow components -------------------------------------------------------
// Address the owning flow by page (a page name) OR action (an action name).
// (list_* are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.CREATE_FLOW_COMPONENT, {
  title: "Create flow component",
  description:
    "Add a flow component (action or widget component) to a flow. Address the flow by page OR action. " +
    "type is the registered component class name; left/top place it on the flow canvas; props sets initial fields. " +
    "Returns the created component. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to add to (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to add to (mutually exclusive with page)."),
    type: z.string().describe('Registered flow-component class name, e.g. "CallActionActionComponent".'),
    left: z.number().optional().describe("X position on the flow canvas, in px."),
    top: z.number().optional().describe("Y position on the flow canvas, in px."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Initial component field values (object-model string form)."),
  },
});

registerBridgeTool(METHODS.LIST_FLOW_COMPONENTS, {
  title: "List flow components",
  description:
    "List the components in a flow. Address the flow by page OR action. " +
    "Returns the components with their objIDs, types, and positions. Read-only.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to list (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to list (mutually exclusive with page)."),
  },
});

registerBridgeTool(METHODS.LIST_FLOW_COMPONENT_TYPES, {
  title: "List flow component types",
  description:
    "List the registered flow-component classes you can create, with their editable fields and ports. " +
    "Filter by group (palette group) and/or search (substring). Read-only.",
  inputSchema: {
    group: z.string().optional().describe("Palette group to filter by, e.g. \"Actions\", \"Dashboard Widgets\"."),
    search: z.string().optional().describe("Substring to filter component type names by."),
  },
});

registerBridgeTool(METHODS.GET_FLOW_COMPONENT, {
  title: "Get flow component",
  description:
    "Full detail for one flow component by objID: its type, props, inputs/outputs, and connections. " +
    "Use before editing to see current values. Read-only.",
  inputSchema: { objID },
});

registerBridgeTool(METHODS.SET_COMPONENT_PROPS, {
  title: "Set flow component props",
  description:
    "Update one or more fields on a flow component by objID. props is a map of field -> value. " +
    "Returns the updated component. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    objID,
    props: z
      .record(z.string(), z.unknown())
      .describe("Component field keys to update with their new values (object-model string form)."),
  },
});

registerBridgeTool(METHODS.MOVE_FLOW_COMPONENT, {
  title: "Move flow component",
  description:
    "Move a flow component to a new position on the flow canvas (address by objID). " +
    "left/top are the new coordinates in px. Returns the moved component. One undo step.",
  inputSchema: {
    objID,
    left: z.number().describe("New X position on the flow canvas, in px."),
    top: z.number().describe("New Y position on the flow canvas, in px."),
  },
});

registerBridgeTool(METHODS.DELETE_FLOW_COMPONENT, {
  title: "Delete flow component",
  description:
    "Delete a flow component (and its connections) by objID. Returns { deleted }. One undo step.",
  inputSchema: { objID },
});

registerBridgeTool(METHODS.SET_CATCH_ERROR, {
  title: "Set catch-error output",
  description:
    "Toggle a flow component's catch-error output on/off (address by objID). When on, the component exposes " +
    "an error output you can wire to an error handler. Returns the updated component. One undo step.",
  inputSchema: {
    objID,
    on: z.boolean().describe("Whether to enable (true) or disable (false) the catch-error output."),
  },
});

registerBridgeTool(METHODS.CREATE_COMPONENT_GROUP, {
  title: "Create component group",
  description:
    "Group flow components together on the canvas. Address the flow by page OR action. name is the group name; " +
    "componentIDs are the objIDs of the components to include. Returns the created group. One undo step.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow the group lives in (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow the group lives in (mutually exclusive with page)."),
    name: z.string().describe("Name for the component group."),
    componentIDs: z
      .array(z.string())
      .optional()
      .describe("objIDs of the flow components to include in the group."),
  },
});

// --- Flow connections & ports ----------------------------------------------
// (list_* are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.CONNECT_COMPONENTS, {
  title: "Connect flow components",
  description:
    "Wire an output of one flow component to an input of another. source/target are component objIDs; " +
    "output is the source's output port name; input is the target's input port name. " +
    "Returns the created connection. One undo step.",
  inputSchema: {
    source: objID.describe("Source component objID (the output side)."),
    output: z.string().describe("Name of the source component's output port."),
    target: objID.describe("Target component objID (the input side)."),
    input: z.string().describe("Name of the target component's input port."),
  },
});

registerBridgeTool(METHODS.DISCONNECT_COMPONENTS, {
  title: "Disconnect flow components",
  description:
    "Remove a flow connection: address it by objID, OR by its endpoints (source+output+target+input). " +
    "Returns { deleted }. One undo step.",
  inputSchema: {
    objID: objID.optional().describe("Connection objID to remove (mutually exclusive with endpoints)."),
    source: objID.optional().describe("Source component objID (with output/target/input)."),
    output: z.string().optional().describe("Source output port name."),
    target: objID.optional().describe("Target component objID (with source/output/input)."),
    input: z.string().optional().describe("Target input port name."),
  },
});

registerBridgeTool(METHODS.LIST_FLOW_CONNECTIONS, {
  title: "List flow connections",
  description:
    "List the connections (wires) in a flow. Address the flow by page OR action. " +
    "Returns the connections with their objIDs and endpoints. Read-only.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to list (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to list (mutually exclusive with page)."),
  },
});

registerBridgeTool(METHODS.UPDATE_FLOW_CONNECTION, {
  title: "Update flow connection",
  description:
    "Update a flow connection by objID: toggle disabled and/or set a description. Returns the updated connection. One undo step.",
  inputSchema: {
    objID,
    disabled: z.boolean().optional().describe("Whether the connection is disabled."),
    description: z.string().optional().describe("Description/label for the connection."),
  },
});

registerBridgeTool(METHODS.ADD_COMPONENT_INPUT, {
  title: "Add component input",
  description:
    "Add a named input port to a flow component (address by objID). name is the port name; type is its object-model type string. " +
    "Returns the updated component. One undo step.",
  inputSchema: {
    objID,
    name: z.string().describe("Name of the new input port."),
    type: z.string().describe("Port type (object-model type string)."),
  },
});

registerBridgeTool(METHODS.ADD_COMPONENT_OUTPUT, {
  title: "Add component output",
  description:
    "Add a named output port to a flow component (address by objID). name is the port name; type is its object-model type string. " +
    "Returns the updated component. One undo step.",
  inputSchema: {
    objID,
    name: z.string().describe("Name of the new output port."),
    type: z.string().describe("Port type (object-model type string)."),
  },
});

registerBridgeTool(METHODS.DELETE_COMPONENT_PORT, {
  title: "Delete component port",
  description:
    "Delete an input or output port from a flow component (address by objID). port is the port name; " +
    "direction selects input or output. Returns { deleted }. One undo step.",
  inputSchema: {
    objID,
    port: z.string().describe("Name of the port to delete."),
    direction: z.enum(["input", "output"]).describe("Which side the port is on."),
  },
});

registerBridgeTool(METHODS.BIND_FLOW_EVENT, {
  title: "Bind flow event",
  description:
    "Bind a widget's event to its flow (address the widget by objID). event is a bare LVGL event name " +
    "(e.g. \"CLICKED\", \"VALUE_CHANGED\"), which adds a flow event handler/output for it. " +
    "Returns the updated widget. One undo step.",
  inputSchema: {
    objID,
    event: z.string().describe('Bare LVGL event name to bind, e.g. "CLICKED", "VALUE_CHANGED".'),
  },
});

// --- Flow variables & interface --------------------------------------------
// Flow-local variables and the action-flow input/output interface.
// (list_* are read-only; the rest are one undo step each)

registerBridgeTool(METHODS.LIST_FLOW_VARIABLES, {
  title: "List flow variables",
  description:
    "List a flow's local variables. Address the flow by page OR action. " +
    "Returns the variables with their names, types, and defaults. Read-only.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to list (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to list (mutually exclusive with page)."),
  },
});

registerBridgeTool(METHODS.ADD_FLOW_VARIABLE, {
  title: "Add flow variable",
  description:
    "Add a flow-local variable. Address the flow by page OR action. name is the variable name; type is its object-model type; " +
    "defaultValue is an optional default. Returns the added variable. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to add to (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to add to (mutually exclusive with page)."),
    name: z.string().describe("Unique flow-variable name."),
    type: z.string().describe("Variable type (object-model type string)."),
    defaultValue: z.string().optional().describe("Optional default value (object-model string form)."),
  },
});

registerBridgeTool(METHODS.UPDATE_FLOW_VARIABLE, {
  title: "Update flow variable",
  description:
    "Update a flow-local variable's props by name. Address the flow by page OR action. props is a map of property -> value. " +
    "Returns the updated variable. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    page: pageName.optional().describe("Page whose flow owns the variable (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow owns the variable (mutually exclusive with page)."),
    name: z.string().describe("Name of the flow variable to update."),
    props: z
      .record(z.string(), z.unknown())
      .describe("Variable property keys to set (object-model string form)."),
  },
});

registerBridgeTool(METHODS.DELETE_FLOW_VARIABLE, {
  title: "Delete flow variable",
  description:
    "Delete a flow-local variable by name. Address the flow by page OR action. Returns { deleted }. One undo step.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow owns the variable (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow owns the variable (mutually exclusive with page)."),
    name: z.string().describe("Name of the flow variable to delete."),
  },
});

registerBridgeTool(METHODS.LIST_FLOW_INTERFACE, {
  title: "List flow interface",
  description:
    "List a flow's interface inputs and outputs (the action-flow signature). Address the flow by page OR action. " +
    "Returns the inputs/outputs with their names and types. Read-only.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to list (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to list (mutually exclusive with page)."),
  },
});

registerBridgeTool(METHODS.ADD_FLOW_INPUT, {
  title: "Add flow input",
  description:
    "Add an interface input to a flow. Address the flow by page OR action. name is the input name; type is its object-model type; " +
    "assignable marks it as an assignable (writable) input. Returns the added input. One undo step.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to add to (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to add to (mutually exclusive with page)."),
    name: z.string().describe("Unique flow-input name."),
    type: z.string().describe("Input type (object-model type string)."),
    assignable: z.boolean().optional().describe("Mark the input as assignable (writable)."),
  },
});

registerBridgeTool(METHODS.ADD_FLOW_OUTPUT, {
  title: "Add flow output",
  description:
    "Add an interface output to a flow. Address the flow by page OR action. name is the output name; type is its object-model type. " +
    "Returns the added output. One undo step.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to add to (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to add to (mutually exclusive with page)."),
    name: z.string().describe("Unique flow-output name."),
    type: z.string().describe("Output type (object-model type string)."),
  },
});

registerBridgeTool(METHODS.LIST_ACTION_FLOWS, {
  title: "List action flows",
  description:
    "List the project's action flows (user-defined flow actions) with their names and interfaces. Read-only.",
  inputSchema: {},
});

// --- Flow reactive & misc --------------------------------------------------
// (render_flow is a render tool; find_component is read-only; the rest are one undo step)

registerBridgeTool(METHODS.SET_REACTIVE_FLAG, {
  title: "Set reactive flag",
  description:
    "Bind a widget flag to a reactive value in flow mode (address the widget by objID). flag is the bare flag name " +
    "(e.g. \"HIDDEN\"); value is the literal or expression driving it; type selects literal or expression. " +
    "Returns the updated widget. One undo step.",
  inputSchema: {
    objID,
    flag: z.string().describe('Bare LVGL flag name, e.g. "HIDDEN", "CLICKABLE".'),
    value: z.string().describe("Literal value or flow expression driving the flag."),
    type: z.enum(["literal", "expression"]).describe("Whether value is a literal or a flow expression."),
  },
});

registerBridgeTool(METHODS.SET_REACTIVE_STATE, {
  title: "Set reactive state",
  description:
    "Bind a widget state to a reactive value in flow mode (address the widget by objID). state is the bare state name " +
    "(e.g. \"CHECKED\"); value is the literal or expression driving it; type selects literal or expression. " +
    "Returns the updated widget. One undo step.",
  inputSchema: {
    objID,
    state: z.string().describe('Bare LVGL state name, e.g. "CHECKED", "DISABLED".'),
    value: z.string().describe("Literal value or flow expression driving the state."),
    type: z.enum(["literal", "expression"]).describe("Whether value is a literal or a flow expression."),
  },
});

registerRenderTool(METHODS.RENDER_FLOW, {
  title: "Render flow (PNG)",
  description:
    "Render a flow's canvas (components and connections) as a PNG image. Address the flow by page OR action. " +
    "Use to see the flow graph exactly as EEZ Studio draws it.",
  inputSchema: {
    page: pageName.optional().describe("Page whose flow to render (mutually exclusive with action)."),
    action: z.string().optional().describe("Action whose flow to render (mutually exclusive with page)."),
  },
});

registerBridgeTool(METHODS.FIND_COMPONENT, {
  title: "Find flow component",
  description:
    "Resolve a flow component by its path (componentPath) to its objID and detail. Read-only.",
  inputSchema: {
    componentPath: z.string().describe("Path addressing the flow component within the project."),
  },
});

// --- Instrument & dashboard features ---------------------------------------
// SCPI subsystems/commands/enums, instrument command definitions, MicroPython,
// shortcuts, and extension (IEXT) definitions. (list_* are read-only; the rest
// are one undo step each.)

registerBridgeTool(METHODS.MANAGE_SCPI, {
  title: "Manage SCPI",
  description:
    "Create/update/delete SCPI subsystems, commands, and enums on the project's SCPI feature. " +
    "op selects the operation (e.g. \"add_subsystem\", \"add_command\", \"add_enum\", \"add_enum_member\", " +
    "\"update\", \"delete\"). Address items via subsystem, command, enumName, and member as needed; " +
    "fields carries the values to set. Returns the affected item. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    op: z.string().describe('Operation, e.g. "add_subsystem", "add_command", "add_enum", "update", "delete".'),
    subsystem: z.string().optional().describe("SCPI subsystem name to address."),
    command: z.string().optional().describe("SCPI command name to address."),
    enumName: z.string().optional().describe("SCPI enum name to address."),
    member: z.string().optional().describe("SCPI enum member name to address."),
    fields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Field values to set on the affected item (object-model string form)."),
  },
});

registerBridgeTool(METHODS.MANAGE_INSTRUMENT_COMMANDS, {
  title: "Manage instrument commands",
  description:
    "Create/update/delete entries in the project's instrument command definitions. op selects the operation " +
    "(e.g. \"add\", \"update\", \"delete\"); command addresses the command; description and helpLink set its metadata. " +
    "Returns the affected command. One undo step.",
  inputSchema: {
    op: z.string().describe('Operation, e.g. "add", "update", "delete".'),
    command: z.string().optional().describe("Instrument command name to address."),
    description: z.string().optional().describe("Human-readable command description."),
    helpLink: z.string().optional().describe("Documentation/help URL for the command."),
  },
});

registerBridgeTool(METHODS.SET_MICROPYTHON, {
  title: "Set MicroPython code",
  description:
    "Set the project's MicroPython source code (the MicroPython feature's script body). code is the full script text. " +
    "Returns the updated MicroPython object. One undo step.",
  inputSchema: {
    code: z.string().describe("Full MicroPython source code to set."),
  },
});

registerBridgeTool(METHODS.MANAGE_SHORTCUTS, {
  title: "Manage shortcuts",
  description:
    "Create/update/delete project shortcuts (toolbar/keyboard actions). op selects the operation " +
    "(e.g. \"add\", \"update\", \"delete\"); address an existing shortcut by id. name is the label; action is a map " +
    "describing the shortcut action; keybinding is the key combo; showInToolbar/toolbarButtonColor control toolbar " +
    "presentation; requiresConfirmation gates execution behind a prompt. Returns the affected shortcut. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    op: z.string().describe('Operation, e.g. "add", "update", "delete".'),
    id: z.string().optional().describe("Shortcut id to address (for update/delete)."),
    name: z.string().optional().describe("Shortcut label/name."),
    action: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Action definition for the shortcut (object-model string form)."),
    keybinding: z.string().optional().describe("Key combination, e.g. \"Ctrl+Shift+P\"."),
    showInToolbar: z.boolean().optional().describe("Whether to show the shortcut as a toolbar button."),
    toolbarButtonColor: z.string().optional().describe('Toolbar button color as "#rrggbb".'),
    requiresConfirmation: z.boolean().optional().describe("Prompt for confirmation before running the shortcut."),
  },
});

registerBridgeTool(METHODS.LIST_EXTENSION_DEFINITIONS, {
  title: "List extension definitions",
  description:
    "List the project's extension (IEXT) definitions with their names and props. Addressed by name. Read-only.",
  inputSchema: {},
});

registerBridgeTool(METHODS.ADD_EXTENSION_DEFINITION, {
  title: "Add extension definition",
  description:
    "Add an extension (IEXT) definition by name, optionally seeded with props (a map of definition fields). " +
    "Returns the added definition. One undo step." +
    VALUE_FORMAT_NOTE,
  inputSchema: {
    name: z.string().describe("Unique extension definition name."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Initial extension-definition field values (object-model string form)."),
  },
});

// --- Project lifecycle & view commands -------------------------------------
// Save-as, new/open/reload project, theme switch, and view-tab navigation.
// (open_view_tab and set_theme affect the UI/editor, not the object model.)

registerBridgeTool(METHODS.SAVE_AS, {
  title: "Save project as",
  description:
    "Save the project to a new location. Provide filePath to save there, or omit it to prompt for a destination. " +
    "Returns { saved, filePath }.",
  inputSchema: {
    filePath: z.string().optional().describe("Destination path to save to (omit to prompt)."),
  },
});

registerBridgeTool(METHODS.NEW_PROJECT, {
  title: "New project",
  description:
    "Create a new project. type selects the project template/kind (e.g. \"LVGL\", \"dashboard\", \"applet\"); " +
    "omit for the default. Returns the new project info.",
  inputSchema: {
    type: z.string().optional().describe('Project template/kind, e.g. "LVGL", "dashboard".'),
  },
});

registerBridgeTool(METHODS.OPEN_PROJECT, {
  title: "Open project",
  description:
    "Open an existing project from disk by filePath. Returns the opened project info.",
  inputSchema: {
    filePath: z.string().describe("Path to the .eez-project file to open."),
  },
});

registerBridgeTool(METHODS.RELOAD_PROJECT, {
  title: "Reload project",
  description:
    "Reload the current project from disk, discarding unsaved in-memory changes. Returns the reloaded project info.",
  inputSchema: {},
});

registerBridgeTool(METHODS.SET_THEME, {
  title: "Set editor theme",
  description:
    "Switch the EEZ Studio editor UI theme. theme is \"dark\" or \"light\". Returns the applied theme.",
  inputSchema: {
    theme: z.enum(["dark", "light"]).describe("Editor UI theme to apply."),
  },
});

registerBridgeTool(METHODS.OPEN_VIEW_TAB, {
  title: "Open view tab",
  description:
    "Open a top-level view/navigation tab in the editor (e.g. \"pages\", \"styles\", \"fonts\", \"bitmaps\", \"actions\", " +
    "\"variables\", \"settings\"). tab is the view name. Returns the opened tab.",
  inputSchema: {
    tab: z.string().describe('View tab name, e.g. "pages", "styles", "settings".'),
  },
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderr(`ready on stdio (v${SERVER_VERSION}) — waiting for MCP client`);
}

function shutdown(signal: string): void {
  stderr(`received ${signal} — shutting down`);
  bridge.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  stderr(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
