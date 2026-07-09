/**
 * Wire-protocol types for the EEZ Studio MCP Bridge (protocol version 1).
 *
 * These types mirror docs/PROTOCOL.md — the single source of truth shared by the
 * bridge (hosted inside the EEZ Studio renderer) and this MCP server. All values use
 * the object-model string form (colors "#rrggbb" or theme name, opacity int 0-255,
 * enums bare without "LV_", fonts/bitmaps by name) — never LV_* constants or BGR ints.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Default WebSocket port the bridge binds to when EEZ_MCP_BRIDGE_PORT is unset. */
export const DEFAULT_BRIDGE_PORT = 38017 as const;

/** Handshake file basename inside os.tmpdir(). */
export const HANDSHAKE_FILENAME = "eez-studio-mcp-bridge.json" as const;

// ---------------------------------------------------------------------------
// Handshake file (discovery & auth)
// ---------------------------------------------------------------------------

/** Contents of the handshake file written by the bridge on startup. */
export interface HandshakeFile {
  port: number;
  token: string;
  pid: number;
  protocolVersion: number;
  startedAt: string; // ISO8601
  eezStudioVersion: string;
}

// ---------------------------------------------------------------------------
// Message framing
// ---------------------------------------------------------------------------

/** Request envelope: mcp-server -> bridge. */
export interface BridgeRequest {
  id: string; // uuid, correlates the response
  method: BridgeMethod;
  params: Record<string, unknown>;
}

/** Successful response envelope: bridge -> mcp-server. */
export interface BridgeResponseOk<T = unknown> {
  id: string;
  ok: true;
  result: T;
}

/** Error codes the bridge may return. */
export type BridgeErrorCode =
  | "NO_PROJECT"
  | "NOT_FOUND"
  | "BAD_PARAMS"
  | "NOT_LVGL"
  | "UNSUPPORTED"
  | "INTERNAL";

/** Error response envelope: bridge -> mcp-server. */
export interface BridgeResponseError {
  id: string;
  ok: false;
  error: {
    code: BridgeErrorCode | string;
    message: string;
  };
}

export type BridgeResponse<T = unknown> = BridgeResponseOk<T> | BridgeResponseError;

/** Unsolicited event envelope: bridge -> mcp-server (no id). Ignorable by v1 clients. */
export interface BridgeEvent<T = unknown> {
  event: "hello" | "project-changed" | "selection-changed" | string;
  data: T;
}

// ---------------------------------------------------------------------------
// Method names (§4)
// ---------------------------------------------------------------------------

export const METHODS = {
  // Inspect (read-only)
  PING: "ping",
  GET_PROJECT_INFO: "get_project_info",
  LIST_PAGES: "list_pages",
  GET_PAGE_TREE: "get_page_tree",
  GET_WIDGET: "get_widget",
  GET_SELECTION: "get_selection",
  // Edit
  CREATE_WIDGET: "create_widget",
  UPDATE_WIDGET: "update_widget",
  SET_STYLE: "set_style",
  CLEAR_STYLE: "clear_style",
  DELETE_WIDGET: "delete_widget",
  BIND_EVENT: "bind_event",
  UNBIND_EVENT: "unbind_event",
  SET_IDENTIFIER: "set_identifier",
  // Render
  RENDER_PAGE: "render_page",
  RENDER_SELECTION: "render_selection",
  // Navigate / lifecycle
  SELECT_WIDGET: "select_widget",
  OPEN_PAGE: "open_page",
  UNDO: "undo",
  REDO: "redo",
  SAVE: "save",
  // Assets (read)
  LIST_FONTS: "list_fonts",
  LIST_BITMAPS: "list_bitmaps",
  LIST_ACTIONS: "list_actions",
  LIST_STYLES: "list_styles",
  // Diagnostics
  RUN_CHECKS: "run_checks",
  GET_PROBLEMS: "get_problems",
  GET_CONSOLE_LOG: "get_console_log",
  GET_NOTIFICATIONS: "get_notifications",
  // Pages / screens
  CREATE_PAGE: "create_page",
  DELETE_PAGE: "delete_page",
  RENAME_PAGE: "rename_page",
  REORDER_PAGE: "reorder_page",
  SET_PAGE_SETTINGS: "set_page_settings",
  // Widgets — structure / clone / move / introspect
  DUPLICATE_WIDGET: "duplicate_widget",
  MOVE_WIDGET: "move_widget",
  ALIGN_WIDGETS: "align_widgets",
  COPY_STYLE: "copy_style",
  LIST_WIDGET_CLASSES: "list_widget_classes",
  // Assets — write
  ADD_BITMAP: "add_bitmap",
  DELETE_BITMAP: "delete_bitmap",
  ADD_FONT: "add_font",
  EDIT_FONT: "edit_font",
  DELETE_FONT: "delete_font",
  CREATE_ACTION: "create_action",
  DELETE_ACTION: "delete_action",
  CREATE_STYLE: "create_style",
  UPDATE_STYLE: "update_style",
  DELETE_STYLE: "delete_style",
  LIST_COLORS: "list_colors",
  ADD_COLOR: "add_color",
  UPDATE_COLOR: "update_color",
  DELETE_COLOR: "delete_color",
  // Variables
  LIST_VARIABLES: "list_variables",
  ADD_VARIABLE: "add_variable",
  UPDATE_VARIABLE: "update_variable",
  DELETE_VARIABLE: "delete_variable",
  // Project / build
  GET_SETTINGS: "get_settings",
  UPDATE_SETTINGS: "update_settings",
  BUILD: "build",
  // Widgets — sub-items (matrix buttons, meter indicators/scales/sections, spans)
  ADD_MATRIX_BUTTON: "add_matrix_button",
  UPDATE_MATRIX_BUTTON: "update_matrix_button",
  ADD_METER_INDICATOR: "add_meter_indicator",
  ADD_METER_SCALE: "add_meter_scale",
  ADD_SCALE_SECTION: "add_scale_section",
  ADD_SPAN: "add_span",
  DELETE_SUBITEM: "delete_subitem",
  // Widgets — flags / states / layout / scroll / grid-cell
  SET_FLAG: "set_flag",
  SET_STATE: "set_state",
  SET_LAYOUT: "set_layout",
  SET_SCROLL: "set_scroll",
  SET_GRID_CELL: "set_grid_cell",
  // Enums / structures / user-widgets
  LIST_ENUMS: "list_enums",
  ADD_ENUM: "add_enum",
  ADD_ENUM_MEMBER: "add_enum_member",
  UPDATE_ENUM_MEMBER: "update_enum_member",
  DELETE_ENUM: "delete_enum",
  LIST_STRUCTURES: "list_structures",
  ADD_STRUCTURE: "add_structure",
  ADD_STRUCTURE_FIELD: "add_structure_field",
  DELETE_STRUCTURE: "delete_structure",
  LIST_USER_WIDGETS: "list_user_widgets",
  CREATE_USER_WIDGET: "create_user_widget",
  DELETE_USER_WIDGET: "delete_user_widget",
  // Groups / themes
  LIST_GROUPS: "list_groups",
  CREATE_GROUP: "create_group",
  ASSIGN_WIDGET_GROUP: "assign_widget_group",
  SET_GROUP_TAB_ORDER: "set_group_tab_order",
  RENAME_GROUP: "rename_group",
  DELETE_GROUP: "delete_group",
  SET_GROUP_DEFAULTS: "set_group_defaults",
  LIST_THEMES: "list_themes",
  CREATE_THEME: "create_theme",
  SET_ACTIVE_THEME: "set_active_theme",
  SET_THEME_COLOR: "set_theme_color",
  RENAME_THEME: "rename_theme",
  DELETE_THEME: "delete_theme",
  // Search / references
  SEARCH_PROJECT: "search_project",
  FIND_REFERENCES: "find_references",
  REPLACE_IN_PROJECT: "replace_in_project",
  IS_REFERENCED: "is_referenced",
  RESOLVE_PATH: "resolve_path",
  // Clipboard
  COPY_OBJECTS: "copy_objects",
  CUT_OBJECTS: "cut_objects",
  PASTE_OBJECTS: "paste_objects",
  GET_CLIPBOARD_INFO: "get_clipboard_info",
  // Editors & navigation
  REVEAL_OBJECT: "reveal_object",
  OPEN_EDITOR: "open_editor",
  ACTIVATE_EDITOR: "activate_editor",
  LIST_EDITORS: "list_editors",
  CLOSE_EDITOR: "close_editor",
  GET_ACTIVE_EDITOR: "get_active_editor",
  SELECT_ALL: "select_all",
  SET_SELECTION: "set_selection",
  GET_NAVIGATION_STATE: "get_navigation_state",
  SELECT_IN_NAVIGATION: "select_in_navigation",
  // Scrapbook
  LIST_SCRAPBOOK_ITEMS: "list_scrapbook_items",
  INSERT_SCRAPBOOK_ITEM: "insert_scrapbook_item",
  SAVE_SELECTION_TO_SCRAPBOOK: "save_selection_to_scrapbook",
  // Texts / i18n
  LIST_LANGUAGES: "list_languages",
  ADD_LANGUAGE: "add_language",
  LIST_TEXT_RESOURCES: "list_text_resources",
  ADD_TEXT_RESOURCE: "add_text_resource",
  SET_TRANSLATION: "set_translation",
  SET_WIDGET_TEXT_RESOURCE: "set_widget_text_resource",
  DELETE_LANGUAGE: "delete_language",
  RENAME_LANGUAGE: "rename_language",
  RENAME_TEXT_RESOURCE: "rename_text_resource",
  DELETE_TEXT_RESOURCE: "delete_text_resource",
  IMPORT_TEXTS: "import_texts",
  EXPORT_TEXTS: "export_texts",
  // Font & bitmap options
  SET_FONT_RANGES: "set_font_ranges",
  SET_FONT_SYMBOLS: "set_font_symbols",
  LIST_FONT_GLYPHS: "list_font_glyphs",
  ADD_FONT_ADDITIONAL_SOURCE: "add_font_additional_source",
  SET_BITMAP_OPTIONS: "set_bitmap_options",
  SET_FONT_FALLBACK: "set_font_fallback",
  EXPORT_BITMAP: "export_bitmap",
  // Settings & features
  LIST_FEATURES: "list_features",
  ENABLE_FEATURE: "enable_feature",
  DISABLE_FEATURE: "disable_feature",
  ADD_PROJECT_IMPORT: "add_project_import",
  REMOVE_PROJECT_IMPORT: "remove_project_import",
  ADD_BUILD_CONFIGURATION: "add_build_configuration",
  SET_ZOOM: "set_zoom",
  SET_README: "set_readme",
  // Simulator
  RUN_SIMULATOR: "run_simulator",
  STOP_SIMULATOR: "stop_simulator",
  GET_SIMULATOR_STATUS: "get_simulator_status",
  SCREENSHOT_SIMULATOR: "screenshot_simulator",
  PAUSE_SIMULATOR: "pause_simulator",
  RESUME_SIMULATOR: "resume_simulator",
  STEP_SIMULATOR: "step_simulator",
  // Build operations
  BUILD_ASSETS: "build_assets",
  GET_BUILD_DESTINATION: "get_build_destination",
  OPEN_BUILD_FOLDER: "open_build_folder",
  LIST_BUILD_CONFIGURATIONS: "list_build_configurations",
  SET_BUILD_CONFIGURATION: "set_build_configuration",
  // Build-file code-generation templates
  LIST_BUILD_FILES: "list_build_files",
  GET_BUILD_FILE: "get_build_file",
  SET_BUILD_FILE_TEMPLATE: "set_build_file_template",
  PATCH_BUILD_FILE_TEMPLATE: "patch_build_file_template",
  SET_EXT_CLICK_AREA: "set_ext_click_area",
  // Full simulator & export
  START_FULL_SIMULATOR: "start_full_simulator",
  STOP_FULL_SIMULATOR: "stop_full_simulator",
  EXPORT_DASHBOARD: "export_dashboard",
  BUILD_EXTENSIONS: "build_extensions",
  // Flow components
  CREATE_FLOW_COMPONENT: "create_flow_component",
  LIST_FLOW_COMPONENTS: "list_flow_components",
  LIST_FLOW_COMPONENT_TYPES: "list_flow_component_types",
  GET_FLOW_COMPONENT: "get_flow_component",
  SET_COMPONENT_PROPS: "set_component_props",
  MOVE_FLOW_COMPONENT: "move_flow_component",
  DELETE_FLOW_COMPONENT: "delete_flow_component",
  SET_CATCH_ERROR: "set_catch_error",
  CREATE_COMPONENT_GROUP: "create_component_group",
  // Flow connections & ports
  CONNECT_COMPONENTS: "connect_components",
  DISCONNECT_COMPONENTS: "disconnect_components",
  LIST_FLOW_CONNECTIONS: "list_flow_connections",
  UPDATE_FLOW_CONNECTION: "update_flow_connection",
  ADD_COMPONENT_INPUT: "add_component_input",
  ADD_COMPONENT_OUTPUT: "add_component_output",
  DELETE_COMPONENT_PORT: "delete_component_port",
  BIND_FLOW_EVENT: "bind_flow_event",
  // Flow variables & interface
  LIST_FLOW_VARIABLES: "list_flow_variables",
  ADD_FLOW_VARIABLE: "add_flow_variable",
  UPDATE_FLOW_VARIABLE: "update_flow_variable",
  DELETE_FLOW_VARIABLE: "delete_flow_variable",
  LIST_FLOW_INTERFACE: "list_flow_interface",
  ADD_FLOW_INPUT: "add_flow_input",
  ADD_FLOW_OUTPUT: "add_flow_output",
  LIST_ACTION_FLOWS: "list_action_flows",
  // Flow reactive & misc
  SET_REACTIVE_FLAG: "set_reactive_flag",
  SET_REACTIVE_STATE: "set_reactive_state",
  RENDER_FLOW: "render_flow",
  FIND_COMPONENT: "find_component",
  // Instrument & dashboard features
  MANAGE_SCPI: "manage_scpi",
  MANAGE_INSTRUMENT_COMMANDS: "manage_instrument_commands",
  SET_MICROPYTHON: "set_micropython",
  MANAGE_SHORTCUTS: "manage_shortcuts",
  LIST_EXTENSION_DEFINITIONS: "list_extension_definitions",
  ADD_EXTENSION_DEFINITION: "add_extension_definition",
  // Project lifecycle & view commands
  SAVE_AS: "save_as",
  NEW_PROJECT: "new_project",
  OPEN_PROJECT: "open_project",
  RELOAD_PROJECT: "reload_project",
  SET_THEME: "set_theme",
  OPEN_VIEW_TAB: "open_view_tab",
} as const;

export type BridgeMethod = (typeof METHODS)[keyof typeof METHODS];

// ---------------------------------------------------------------------------
// Shared shapes (§5)
// ---------------------------------------------------------------------------

/** Widget rect in the object model, with per-edge unit selectors. */
export interface WidgetRect {
  left: number;
  top: number;
  width: number;
  height: number;
  leftUnit: string; // "px" | "content" | "%" | ...
  topUnit: string;
  widthUnit: string;
  heightUnit: string;
}

/** Page-space absolute rectangle (best-effort). */
export interface AbsoluteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node in a page's widget tree (get_page_tree / get_selection). */
export interface WidgetNode {
  objID: string;
  type: string; // e.g. "LVGLLabelWidget"
  identifier: string | null;
  rect: WidgetRect;
  absoluteRect?: AbsoluteRect;
  useStyle: string | null;
  hasLocalStyles: boolean;
  text?: string; // present for widgets that have a text/label prop
  children: WidgetNode[];
}

/** One event handler bound on a widget. */
export interface WidgetEventHandler {
  eventName: string;
  handlerType: string;
  action: string;
  userData?: unknown;
}

/** localStyles map: part -> state -> prop -> value. */
export type LocalStyles = Record<string, Record<string, Record<string, unknown>>>;

/** Full widget detail (get_widget) extends WidgetNode. */
export interface WidgetDetail extends WidgetNode {
  props: Record<string, unknown>;
  localStyles: LocalStyles;
  eventHandlers: WidgetEventHandler[];
}

// ---------------------------------------------------------------------------
// Per-method result shapes (§4)
// ---------------------------------------------------------------------------

export interface PingResult {
  pong: true;
  protocolVersion: number;
  eezStudioVersion: string;
}

export interface ProjectInfoResult {
  name: string;
  filePath: string;
  projectVersion: string;
  lvglVersion: string;
  flowSupport: boolean;
  displayWidth: number;
  displayHeight: number;
  isModified: boolean;
  pages: string[];
}

export interface PageSummary {
  name: string;
  width: number;
  height: number;
  widgetCount: number;
}

export interface ListPagesResult {
  pages: PageSummary[];
}

export interface PageTreeResult {
  page: string;
  root: WidgetNode;
}

export interface GetWidgetResult {
  widget: WidgetDetail;
}

export interface SelectionResult {
  page: string | null;
  objIDs: string[];
  widgets: WidgetNode[];
}

export interface ObjIDResult {
  objID: string;
}

export interface DeleteWidgetResult {
  deleted: string;
}

export interface RenderResult {
  pngBase64: string; // raw base64, no data: prefix
  width: number;
  height: number;
  objID?: string; // present for render_selection
}

export interface OpenPageResult {
  page: string;
}

export interface UndoRedoResult {
  label: string;
}

export interface SaveResult {
  saved: true;
  filePath: string;
}

export interface FontSummary {
  name: string;
  size?: number;
  bpp?: number;
}

export interface ListFontsResult {
  fonts: FontSummary[];
}

export interface BitmapSummary {
  name: string;
  width?: number;
  height?: number;
}

export interface ListBitmapsResult {
  bitmaps: BitmapSummary[];
}

export interface ActionSummary {
  name: string;
  implementationType: string;
}

export interface ListActionsResult {
  actions: ActionSummary[];
}

export interface StyleSummary {
  name: string;
  forWidgetType: string;
}

export interface ListStylesResult {
  styles: StyleSummary[];
}

// --- Diagnostics ---

export interface Problem {
  severity: "error" | "warning" | "info";
  text: string;
  group?: string;
  objID?: string; // nearest addressable widget, if any
  path?: string; // object path within the project
  label?: string;
}

export interface DiagnosticsSection {
  numErrors: number;
  numWarnings: number;
  problems: Problem[];
}

export type RunChecksResult = DiagnosticsSection;

export interface GetProblemsResult {
  checks?: DiagnosticsSection;
  output?: DiagnosticsSection;
}

export interface ConsoleEntry {
  ts: string; // ISO8601
  level: "log" | "info" | "warn" | "error";
  text: string;
  count: number; // consecutive duplicates collapsed into one entry
}

export interface ConsoleLogResult {
  entries: ConsoleEntry[];
}

export interface NotificationEntry {
  ts: string; // ISO8601
  level: "success" | "info" | "warning" | "error";
  text: string;
  count: number; // consecutive duplicates collapsed into one entry
}

export interface GetNotificationsResult {
  entries: NotificationEntry[];
}

// --- Pages / screens ---

export interface CreatePageResult {
  page: string;
  rootObjID: string; // the new page's LVGLScreenWidget objID
}

/** Generic { page } result (rename_page, set_page_settings). */
export interface PageResult {
  page: string;
}

export interface ReorderPageResult {
  page: string;
  index: number;
}

/** Generic { deleted } result (delete_page and other name-addressed deletes). */
export interface DeletedResult {
  deleted: string;
}

// --- Widgets — structure / clone / move / introspect ---

/** align_widgets returns the objIDs it operated on. */
export interface AlignWidgetsResult {
  objIDs: string[];
}

/** One editable classInfo property on a creatable widget class. */
export interface WidgetClassProp {
  name: string;
  type: string; // coarse: "string" | "number" | "boolean" | "enum" | "color" | ...
  enumValues?: string[]; // present when type === "enum"
}

/** A creatable widget type plus its editable props/events (list_widget_classes). */
export interface WidgetClass {
  className: string; // e.g. "LVGLSliderWidget"
  props: WidgetClassProp[];
  events?: string[]; // supported LVGL events, when derivable
}

export interface ListWidgetClassesResult {
  classes: WidgetClass[];
}

// --- Assets — write ---

export interface AddBitmapResult {
  name: string;
  width: number;
  height: number;
}

/** Generic { name } result (add_font, edit_font, create_action, create/update_style, add/update_color, add/update_variable). */
export interface NameResult {
  name: string;
}

/** One theme-palette color. */
export interface ColorSummary {
  name: string;
  value: string; // "#rrggbb"
}

export interface ListColorsResult {
  colors: ColorSummary[];
}

// --- Variables ---

/** One project/global variable. */
export interface VariableSummary {
  name: string;
  type: string;
  defaultValue?: unknown;
}

export interface ListVariablesResult {
  variables: VariableSummary[];
}

// --- Project / build ---

/** get_settings — superset of ProjectInfoResult; extra keys are project-dependent. */
export interface SettingsResult {
  displayWidth: number;
  displayHeight: number;
  projectVersion: string;
  lvglVersion: string;
  colorFormat: string;
  lvglInclude: string;
  flowSupport: boolean;
  buildDestination: string;
  [key: string]: unknown;
}

export interface UpdateSettingsResult {
  updated: boolean;
}

export interface BuildResult {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
  generatedFiles: string[];
}

// ---------------------------------------------------------------------------
// Widgets — sub-items (matrix buttons, meter indicators/scales/sections, spans)
// ---------------------------------------------------------------------------

/** Generic sub-item result: the owning widget + index of the affected sub-item. */
export interface SubItemResult {
  objID: string;
  index: number;
}

// ---------------------------------------------------------------------------
// Enums / structures / user-widgets
// ---------------------------------------------------------------------------

/** One enum member (name + resolved integer value). */
export interface EnumMemberSummary {
  name: string;
  value: number;
}

/** One project enum with its members. */
export interface EnumSummary {
  name: string;
  members: EnumMemberSummary[];
}

export interface ListEnumsResult {
  enums: EnumSummary[];
}

/** One structure field (name + object-model type string). */
export interface StructureFieldSummary {
  name: string;
  type: string;
}

/** One project structure with its fields. */
export interface StructureSummary {
  name: string;
  fields: StructureFieldSummary[];
}

export interface ListStructuresResult {
  structures: StructureSummary[];
}

/** One reusable user widget (LVGLUserWidget) definition. */
export interface UserWidgetSummary {
  name: string;
  width: number;
  height: number;
}

export interface ListUserWidgetsResult {
  userWidgets: UserWidgetSummary[];
}

// ---------------------------------------------------------------------------
// Groups / themes
// ---------------------------------------------------------------------------

/** One LVGL input group. */
export interface GroupSummary {
  name: string;
}

export interface ListGroupsResult {
  groups: GroupSummary[];
}

/** One theme; active flags the currently-selected theme. */
export interface ThemeSummary {
  name: string;
  active: boolean;
}

export interface ListThemesResult {
  themes: ThemeSummary[];
}

// ---------------------------------------------------------------------------
// Search / references
// ---------------------------------------------------------------------------

/** One match from search_project. */
export interface SearchMatch {
  objID?: string; // nearest addressable widget, if any
  path?: string; // object path within the project
  text: string; // the matched text/context
  label?: string;
}

export interface SearchProjectResult {
  matches: SearchMatch[];
}

/** One place that references the queried object/asset. */
export interface ReferenceSite {
  objID?: string;
  path?: string;
  label?: string;
}

export interface FindReferencesResult {
  references: ReferenceSite[];
}

export interface ReplaceInProjectResult {
  replaced: number;
}

export interface IsReferencedResult {
  referenced: boolean;
  count: number;
}

/** resolve_path maps a path <-> objID (whichever was not supplied). */
export interface ResolvePathResult {
  objID?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** copy_objects / cut_objects report what landed on the clipboard. */
export interface ClipboardResult {
  objIDs: string[];
}

export interface PasteObjectsResult {
  objIDs: string[];
}

/** Describes the current clipboard contents (get_clipboard_info). */
export interface ClipboardInfoResult {
  empty: boolean;
  count: number;
  canPaste: boolean;
}

// ---------------------------------------------------------------------------
// Editors & navigation
// ---------------------------------------------------------------------------

/** One open editor tab. */
export interface EditorSummary {
  objID?: string;
  path?: string;
  title: string;
  active: boolean;
  permanent: boolean;
}

export interface ListEditorsResult {
  editors: EditorSummary[];
}

export interface EditorResult {
  objID?: string;
  path?: string;
  title?: string;
}

/** Snapshot of the navigation panel selection (get_navigation_state). */
export interface NavigationStateResult {
  collection: string | null;
  objID: string | null;
  path: string | null;
}

// ---------------------------------------------------------------------------
// Scrapbook
// ---------------------------------------------------------------------------

/** One reusable scrapbook item. */
export interface ScrapbookItemSummary {
  itemId: string;
  name: string;
  description?: string;
}

export interface ListScrapbookItemsResult {
  items: ScrapbookItemSummary[];
}

// ---------------------------------------------------------------------------
// Texts / i18n
// ---------------------------------------------------------------------------

/** One project language (i18n). */
export interface LanguageSummary {
  languageID: string;
}

export interface ListLanguagesResult {
  languages: LanguageSummary[];
}

/** One text resource, with its per-language translations. */
export interface TextResourceSummary {
  resourceID: string;
  translations: Record<string, string>; // languageID -> text
}

export interface ListTextResourcesResult {
  textResources: TextResourceSummary[];
}

/** export_texts returns the serialized document in the requested format. */
export interface ExportTextsResult {
  format: string; // "csv" | "json" | "xliff"
  data: string;
}

export interface ImportTextsResult {
  imported: number;
}

// ---------------------------------------------------------------------------
// Font & bitmap options
// ---------------------------------------------------------------------------

/** One glyph in a font (code point + optional metadata). */
export interface FontGlyphSummary {
  encoding: number; // unicode code point
  char?: string;
}

export interface ListFontGlyphsResult {
  glyphs: FontGlyphSummary[];
}

/** export_bitmap reports where the image was written. */
export interface ExportBitmapResult {
  filePath: string;
}

// ---------------------------------------------------------------------------
// Settings & features
// ---------------------------------------------------------------------------

/** One optional project feature (extension). */
export interface FeatureSummary {
  key: string;
  name: string;
  enabled: boolean;
}

export interface ListFeaturesResult {
  features: FeatureSummary[];
}

// ---------------------------------------------------------------------------
// Simulator / build operations / full-simulator & export
// ---------------------------------------------------------------------------

/** screenshot_simulator — a PNG grab of the running LVGL simulator surface. */
export interface ScreenshotSimulatorResult {
  png: string; // raw base64, no data: prefix
  width: number;
  height: number;
  source: string; // which surface the grab came from
}
