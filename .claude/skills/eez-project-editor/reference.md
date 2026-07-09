# EEZ Studio `.eez-project` LVGL — Full Reference Catalog

Companion to [SKILL.md](SKILL.md). Everything here is source-verified against
`packages/project-editor/lvgl/…` (and `flow/`, `features/`, `project/`). File:line
citations appear in each section.

**Scope:** EEZ project schema `projectVersion: "v3"` (a schema string — **not** an LVGL
version), targeting LVGL **`8.4.0` … `9.5.0`** (default `8.4.0`, set by `settings.general.lvglVersion`).
Applies to **both flow and no-flow** LVGL projects. Whether a project is flow or no-flow is
read from `settings.general.flowSupport` (`project-type-traits.ts:94-96`; surfaced via the
bridge's `get_project_info`).

The serialization catalog below (widget/style/font/state field shapes) is identical in both
modes — it is the LVGL widget-tree contract. The **difference is how logic is wired**:
- **No-flow:** events call top-level native `actions[]` (`handlerType: "action"`), and
  reactive values are read/written through generated C hooks (`get_var_*`, `set_var_*`,
  `action_*`). Sections marked *(no-flow-specific)* below describe this path.
- **Flow:** each page/action carries a visual flow graph — `components[]` +
  `connectionLines[]` + `localVariables[]` (`flow/flow.tsx:65-71, 167-169`). Logic is wired
  by dropping flow components (`ActionComponent` subclasses — `component.tsx:4366`) and drawing
  connection lines between their inputs/outputs; widget properties/flags/states are
  expression-bound and updated reactively. Flow projects require the `eez-framework` C++
  runtime. The bridge authors flow graphs directly (e.g. `create_flow_component`,
  `connect_components`, `set_reactive_flag`/`set_reactive_state`).

The full **208-method** bridge contract (pages, widgets + sub-items, styles,
assets/fonts/bitmaps/colors, variables/enums/structures/user-widgets, groups/themes,
i18n/texts, project-wide search/clipboard/navigation, the flow graph, the LVGL-WASM
simulator, and code generation/build) is authoritative in [../../../docs/PROTOCOL.md](../../../docs/PROTOCOL.md).

Table of contents:
- [Widgets](#widgets) — type list, common fields, widget-specific fields
- [Widget templates](#widget-templates) — copy-paste JSON
- [Styles](#styles) — full property catalog + value formats
- [Parts and states](#parts-and-states)
- [Events and actions](#events-and-actions)
- [Fonts](#fonts)
- [Name mappings](#name-mappings)
- [Source index](#source-index)

---

## Widgets

### Widget `type` strings (registerClass names)

From `widgets/index.ts:127-166`. The string is the value of the `"type"` field.

| `type` | Source | | `type` | Source |
|---|---|---|---|---|
| `LVGLAnimationImageWidget` | AnimationImage.tsx | | `LVGLLottieWidget` | Lottie.tsx |
| `LVGLArcWidget` | Arc.tsx | | `LVGLKeyboardWidget` | Keyboard.tsx |
| `LVGLBarWidget` | Bar.tsx | | `LVGLMenuWidget` | Menu.tsx |
| `LVGLButtonWidget` | Button.tsx | | `LVGLMessageBoxWidget` | MessageBox.tsx |
| `LVGLButtonMatrixWidget` | ButtonMatrix.tsx | | `LVGLMeterWidget` | Meter.tsx |
| `LVGLCalendarWidget` | Calendar.tsx | | `LVGLQRCodeWidget` | QRCode.tsx |
| `LVGLChartWidget` | Chart.tsx | | `LVGLPanelWidget` | Panel.tsx |
| `LVGLCheckboxWidget` | Checkbox.tsx | | `LVGLRollerWidget` | Roller.tsx |
| `LVGLCanvasWidget` | Canvas.tsx | | `LVGLScaleWidget` | Scale.tsx |
| `LVGLColorwheelWidget` | Colorwheel.tsx | | `LVGLScreenWidget` | Screen.tsx |
| `LVGLContainerWidget` | Container.tsx | | `LVGLSpanWidget` | Span.tsx |
| `LVGLDropdownWidget` | Dropdown.tsx | | `LVGLSpinboxWidget` | Spinbox.tsx |
| `LVGLImageWidget` | Image.tsx | | `LVGLSliderWidget` | Slider.tsx |
| `LVGLImgbuttonWidget` | Imgbutton.tsx | | `LVGLSpinnerWidget` | Spinner.tsx |
| `LVGLLabelWidget` | Label.tsx | | `LVGLSwitchWidget` | Switch.tsx |
| `LVGLLedWidget` | Led.tsx | | `LVGLTableWidget` | Table.tsx |
| `LVGLLineWidget` | Line.tsx | | `LVGLTabviewWidget` | Tabview.tsx |
| `LVGLListWidget` | List.tsx | | `LVGLTabWidget` | Tab.tsx |
| | | | `LVGLTextareaWidget` | Textarea.tsx |
| | | | `LVGLTileViewWidget` | TileView.tsx |
| | | | `LVGLUserWidgetWidget` | UserWidget.tsx |
| | | | `LVGLWindowWidget` | Window.tsx |

### Common base field set (every LVGL widget)

Inherited from `Component`/`Widget` (`flow/component.tsx`) and `LVGLWidget` (`widgets/Base.tsx`).
All fields are flat on the widget object.

**From `Component`/`Widget`:**

| Field | Type | Notes |
|---|---|---|
| `objID` | string (GUID) | Unique object id; referenced by connection lines. `core/object.ts:605`. |
| `type` | string | registerClass name. `component.tsx:1746`. |
| `left`,`top`,`width`,`height` | number | Geometry. `component.tsx:1752-1782`, overridden `Base.tsx:646-727`. |
| `customInputs` | array | Optional, default `[]` (omit when empty). |
| `customOutputs` | array | Optional, default `[]`. |
| `catchError` | boolean | Optional flow flag. |
| `timeline` | array | Optional, default `[]`. TimelineKeyframe[]. |
| `eventHandlers` | array | Optional. EventHandler[] (see [Events](#events-and-actions)). |
| `style` | object | **Flow styling — DISABLED for LVGL. Do NOT use.** |
| `locked`,`hiddenInEditor` | boolean | Optional editor flags. |

**From `LVGLWidget` (`widgets/Base.tsx:559-1061`):**

| Field | Type | Required? | Default |
|---|---|---|---|
| `identifier` | string ("Name" → `objects.<name>`) | optional | — |
| `leftUnit` | `"px"｜"%"` | required | `"px"` |
| `topUnit` | `"px"｜"%"` | required | `"px"` |
| `widthUnit` | `"px"｜"%"｜"content"` | required | `"px"` |
| `heightUnit` | `"px"｜"%"｜"content"` | required | `"px"` |
| `children` | LVGLWidget[] | required (may be `[]`) | — |
| `hiddenFlag` | string｜boolean (expr) | optional | — |
| `hiddenFlagType` | `"literal"｜"expression"` | required | `"literal"` |
| `clickableFlag` | string｜boolean | optional | — |
| `clickableFlagType` | `"literal"｜"expression"` | required | `"literal"` |
| `widgetFlags` | string (pipe-joined) | required (may be `""`) | `""` |
| `flagScrollbarMode` | `""｜"off"｜"on"｜"active"｜"auto"` | required | `""` |
| `flagScrollDirection` | `""｜none｜top｜left｜bottom｜right｜hor｜ver｜all` | required | `""` |
| `scrollSnapX` | `""｜none｜start｜end｜center` | required | `""` |
| `scrollSnapY` | `""｜none｜start｜end｜center` | required | `""` |
| `checkedState` | string｜boolean (assignable expr) | optional | — |
| `checkedStateType` | `"literal"｜"expression"` | required | `"literal"` |
| `disabledState` | string｜boolean | optional | — |
| `disabledStateType` | `"literal"｜"expression"` | required | `"literal"` |
| `states` | string (pipe-joined) | required (may be `""`) | `""` |
| `useStyle` | string (ref → `allLvglStyles` name) | optional | — |
| `localStyles` | LVGLStylesDefinition object | required (may be `{}`) | — |
| `group` | string (ref → `lvglGroups/groups`) | required | `""` |
| `groupIndex` | number | required | `0` |

Notes:
- `hiddenFlag`/`clickableFlag`/`checkedState`/`disabledState` are the reactive flags/states
  split out of `widgetFlags`/`states` into their own `…Type` pairs; the `…Type` field is
  ALWAYS present (default `"literal"`), the value field itself is optional.
- `codeIdentifier`, `absolutePosition`, `geometryProperties` are `computed` → NOT serialized.
- `identifier` is disabled only on `LVGLScreenWidget` (screens use the page name).

### Widget-specific fields

**`LVGLButtonWidget`** — none extra (`Button.tsx:23`). Default seeds one child Label "Button".

**`LVGLPanelWidget`** — none extra (`Panel.tsx:20`). Emits `lv_obj_create`.

**`LVGLContainerWidget`** — hidden `containerVersion: number` only (`Container.tsx:62-67`).

**`LVGLSwitchWidget`** — none extra (`Switch.tsx:20`). Default flags include `CHECKABLE`.

**`LVGLLabelWidget`** (`Label.tsx:23-137`):

| Field | Type | Default |
|---|---|---|
| `text` | string (expr) | `"Text"` |
| `textType` | `"literal"｜"translated-literal"｜"expression"` | `"literal"` |
| `previewValue` | string (only when `textType`==`expression`) | — |
| `longMode` | enum `WRAP｜DOT｜SCROLL｜SCROLL_CIRCULAR｜CLIP` | `"WRAP"` |
| `recolor` | boolean | `false` |

**`LVGLCheckboxWidget`** (`Checkbox.tsx:16-57`):

| Field | Type | Default |
|---|---|---|
| `text`,`textType` | string expr (literal/translated-literal only) | `"Checkbox"`, `"literal"` |

**`LVGLImageWidget`** (`Image.tsx:34-176`):

| Field | Type | Default |
|---|---|---|
| `image` | string (ref → `bitmaps`) | — |
| `setPivot` | boolean — `false` ⇒ rotate around **center** (default); `true` ⇒ use `pivotX/Y`. Raw-JSON: **omitting** it makes the loader force `true` @ pivot `0,0` (top-left) | `false` |
| `pivotX`,`pivotY` | number (only used when `setPivot:true`) | `0`,`0` |
| `zoom` | number (256 = 1x) | `256` |
| `angle` | number | `0` |
| `innerAlign` | enum `LV_IMAGE_ALIGN` (DEFAULT,TOP_LEFT…CENTER…TILE) | `"CENTER"` (v9 only) |
| `sizeMode` | enum `VIRTUAL｜REAL` | `"VIRTUAL"` (v8 only) |
| `value`,`valueType`,`previewValue` | int expr (Scale-needle mode only) | `0`,`"literal"` |

**`LVGLBarWidget`** (`Bar.tsx:22-134`):

| Field | Type | Default |
|---|---|---|
| `min`,`minType` | int expr | `0`,`"literal"` |
| `max`,`maxType` | int expr | `100`,`"literal"` |
| `mode` | enum `NORMAL｜SYMMETRICAL｜RANGE` | `"NORMAL"` |
| `value`,`valueType` | int expr | `25`,`"literal"` |
| `previewValue` | string | `"25"` |
| `valueStart`,`valueStartType` | int expr (RANGE mode) | `0`,`"literal"` |
| `previewValueStart` | string | `"0"` |
| `enableAnimation` | boolean | `false` |

**`LVGLSliderWidget`** (`Slider.tsx:22-133`) — like Bar but RANGE second value is `valueLeft`,
and `value`/`valueLeft` are **assignable** (2-way):

| Field | Type | Default |
|---|---|---|
| `min`,`minType` | int expr | `0`,`"literal"` |
| `max`,`maxType` | int expr | `100`,`"literal"` |
| `mode` | enum `NORMAL｜SYMMETRICAL｜RANGE` | `"NORMAL"` |
| `value`,`valueType` (assignable) | int expr | `25`,`"literal"` |
| `previewValue` | string/number | `25` |
| `valueLeft`,`valueLeftType` (assignable, RANGE) | int expr | `0`,`"literal"` |
| `previewValueLeft` | string/number | `0` |
| `enableAnimation` | boolean | `false` |

**`LVGLArcWidget`** (`Arc.tsx:37-281`):

| Field | Type | Default |
|---|---|---|
| `useAngle` | boolean (start/end-angle mode) | `false` |
| `rangeMin`,`rangeMinType` | int expr | `0`,`"literal"` |
| `rangeMax`,`rangeMaxType` | int expr | `100`,`"literal"` |
| `value`,`valueType` (assignable) | int expr | `25`,`"literal"` |
| `previewValue` | string | `"25"` |
| `mode` | enum `NORMAL｜SYMMETRICAL｜REVERSE` | `"NORMAL"` |
| `startAngle`,`startAngleType`,`previewStartAngle` | int expr (useAngle) | `135`,`"literal"`,`"135"` |
| `endAngle`,`endAngleType`,`previewEndAngle` | int expr (useAngle) | `45`,`"literal"`,`"45"` |
| `bgStartAngle`,`bgStartAngleType`,`previewBgStartAngle` | int expr | `135`,`"literal"`,`"135"` |
| `bgEndAngle`,`bgEndAngleType`,`previewBgEndAngle` | int expr | `45`,`"literal"`,`"45"` |
| `rotation`,`rotationType`,`previewRotation` | int expr | `0`,`"literal"`,`"0"` |

**`LVGLRollerWidget`** (`Roller.tsx:54-111`):

| Field | Type | Default |
|---|---|---|
| `options`,`optionsType` | `array:string` expr; literal is `\n`-separated string | `"Option 1\nOption 2\nOption 3"`,`"literal"` |
| `selected`,`selectedType` | int expr (assignable) | `0`,`"literal"` |
| `mode` | enum `NORMAL｜INFINITE` | `"NORMAL"` |

---

## Widget templates

Replace every `objID` with a fresh UUID. Set `identifier` to your object name. `children`
must be present (`[]` if none). `widgetFlags` strings below are the widget's LVGL-v8.4
`defaultFlags`. For v9 differences see per-widget notes.

### Panel / Container
```json
{
  "type": "LVGLPanelWidget",
  "objID": "REPLACE-UUID-1",
  "identifier": "mainPanel",
  "left": 0, "top": 0, "width": 300, "height": 200,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLLABLE|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0
}
```

### Button (with child Label, as EEZ seeds it)
```json
{
  "type": "LVGLButtonWidget",
  "objID": "REPLACE-UUID-2",
  "identifier": "startButton",
  "left": 0, "top": 0, "width": 100, "height": 50,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_ON_FOCUS|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "children": [
    {
      "type": "LVGLLabelWidget",
      "objID": "REPLACE-UUID-3",
      "left": 0, "top": 0, "width": 80, "height": 32,
      "leftUnit": "px", "topUnit": "px", "widthUnit": "content", "heightUnit": "content",
      "children": [],
      "hiddenFlagType": "literal", "clickableFlagType": "literal",
      "widgetFlags": "CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLLABLE|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
      "flagScrollbarMode": "", "flagScrollDirection": "",
      "scrollSnapX": "", "scrollSnapY": "",
      "checkedStateType": "literal", "disabledStateType": "literal",
      "states": "",
      "localStyles": { "definition": { "MAIN": { "DEFAULT": { "align": "CENTER" } } } },
      "group": "", "groupIndex": 0,
      "text": "Button", "textType": "literal", "longMode": "WRAP", "recolor": false
    }
  ]
}
```
Note: to give the child Label its own `objID` on a real `localStyles`, add `"objID"` inside
the `localStyles` object too.

### Label
```json
{
  "type": "LVGLLabelWidget",
  "objID": "REPLACE-UUID-4",
  "identifier": "statusLabel",
  "left": 0, "top": 0, "width": 80, "height": 32,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "content", "heightUnit": "content",
  "children": [],
  "hiddenFlagType": "literal", "clickableFlagType": "literal",
  "widgetFlags": "CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLLABLE|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "text": "Text", "textType": "literal", "longMode": "WRAP", "recolor": false
}
```
Dynamic label: `"textType": "expression", "text": "myVar", "previewValue": "123"`.

### Image
```json
{
  "type": "LVGLImageWidget",
  "objID": "REPLACE-UUID-5",
  "identifier": "logo",
  "left": 0, "top": 0, "width": 100, "height": 100,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "content", "heightUnit": "content",
  "children": [],
  "hiddenFlagType": "literal", "clickableFlagType": "literal",
  "widgetFlags": "ADV_HITTEST|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLLABLE|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "image": "MyBitmap",
  "setPivot": false, "pivotX": 0, "pivotY": 0,
  "zoom": 256, "angle": 0,
  "innerAlign": "CENTER", "sizeMode": "VIRTUAL",
  "value": 0, "valueType": "literal", "previewValue": "0"
}
```

### Bar
```json
{
  "type": "LVGLBarWidget",
  "objID": "REPLACE-UUID-6",
  "identifier": "levelBar",
  "left": 0, "top": 0, "width": 150, "height": 10,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "min": 0, "minType": "literal", "max": 100, "maxType": "literal",
  "mode": "NORMAL",
  "value": 25, "valueType": "literal", "previewValue": "25",
  "valueStart": 0, "valueStartType": "literal", "previewValueStart": "0",
  "enableAnimation": false
}
```
Dynamic value: `"valueType": "expression", "value": "myVar", "previewValue": "50"`.

### Slider
```json
{
  "type": "LVGLSliderWidget",
  "objID": "REPLACE-UUID-7",
  "identifier": "brightnessSlider",
  "left": 0, "top": 0, "width": 150, "height": 10,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_ON_FOCUS|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "min": 0, "minType": "literal", "max": 100, "maxType": "literal",
  "mode": "NORMAL",
  "value": 25, "valueType": "literal", "previewValue": 25,
  "valueLeft": 0, "valueLeftType": "literal", "previewValueLeft": 0,
  "enableAnimation": false
}
```
v8: drop `SCROLL_CHAIN_VER`/`SCROLL_ON_FOCUS` if targeting LVGL 8 (the string above is v9;
`Slider.tsx:170-184`).

### Arc
```json
{
  "type": "LVGLArcWidget",
  "objID": "REPLACE-UUID-8",
  "identifier": "dial",
  "left": 0, "top": 0, "width": 150, "height": 150,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "useAngle": false,
  "rangeMin": 0, "rangeMinType": "literal",
  "rangeMax": 100, "rangeMaxType": "literal",
  "value": 25, "valueType": "literal", "previewValue": "25",
  "mode": "NORMAL",
  "startAngle": 135, "startAngleType": "literal", "previewStartAngle": "135",
  "endAngle": 45, "endAngleType": "literal", "previewEndAngle": "45",
  "bgStartAngle": 135, "bgStartAngleType": "literal", "previewBgStartAngle": "135",
  "bgEndAngle": 45, "bgEndAngleType": "literal", "previewBgEndAngle": "45",
  "rotation": 0, "rotationType": "literal", "previewRotation": "0"
}
```

### Roller
```json
{
  "type": "LVGLRollerWidget",
  "objID": "REPLACE-UUID-9",
  "identifier": "modeRoller",
  "left": 0, "top": 0, "width": 80, "height": 100,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "widgetFlags": "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0,
  "options": "Option 1\nOption 2\nOption 3", "optionsType": "literal",
  "selected": 0, "selectedType": "literal",
  "mode": "NORMAL"
}
```

### Switch
```json
{
  "type": "LVGLSwitchWidget",
  "objID": "REPLACE-UUID-A",
  "identifier": "powerSwitch",
  "left": 0, "top": 0, "width": 50, "height": 25,
  "leftUnit": "px", "topUnit": "px", "widthUnit": "px", "heightUnit": "px",
  "children": [],
  "hiddenFlagType": "literal",
  "clickableFlag": true, "clickableFlagType": "literal",
  "checkedStateType": "literal", "disabledStateType": "literal",
  "widgetFlags": "CHECKABLE|CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_ON_FOCUS|SCROLL_WITH_ARROW|SNAPPABLE",
  "flagScrollbarMode": "", "flagScrollDirection": "",
  "scrollSnapX": "", "scrollSnapY": "",
  "states": "",
  "localStyles": {},
  "group": "", "groupIndex": 0
}
```
Bind on/off: `"checkedState": "myBoolVar", "checkedStateType": "expression"`.

---

## Styles

Model: `definition.<PART>.<STATE>.<snake_case_prop> = value`
(`style-definition.tsx:46-52, 83-86`). The property key is always the `name` field of an
`LVGLPropertyInfo`; the full valid key set is exactly `lvglPropertiesMap` keys. Value format
is determined by the property's `PropertyType`.

### Value-format rules (master key)

- **ThemedColor** (all `*_color`): string `"#RRGGBB"` **or** a theme-color name. Never `0x…`.
  (`style-helper.ts:100-115,136`; `style-definition.tsx:337`.)
- **Number**: number literal (int). Opacity is a plain int 0–255 — no percent string
  (`style-helper.ts:171-181`).
- **Enum**: bare id string, no `LV_` prefix (prefix added at C-build). (`style-catalog.tsx:149-172`.)
- **Boolean**: JSON `true`/`false`. (`style-definition.tsx:569-570`.)
- **NumberArrayAsString** (grid dsc): string like `"50, FR(1), CONTENT"`. (`style-catalog.tsx:795-833`.)
- **ObjectReference→bitmaps** (image sources): bitmap project name string.
- **String** (`anim`): e.g. `"delay=1000, repeat_delay=1000, repeat_count=3"`.

### POSITION AND SIZE (`style-catalog.tsx:2576-2614`)

| key | type | value |
|---|---|---|
| `align` | Enum | one of `DEFAULT, TOP_LEFT, TOP_MID, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_MID, BOTTOM_RIGHT, LEFT_MID, RIGHT_MID, CENTER, OUT_TOP_LEFT, OUT_TOP_MID, OUT_TOP_RIGHT, OUT_BOTTOM_LEFT, OUT_BOTTOM_MID, OUT_BOTTOM_RIGHT, OUT_LEFT_TOP, OUT_LEFT_MID, OUT_LEFT_BOTTOM, OUT_RIGHT_TOP, OUT_RIGHT_MID, OUT_RIGHT_BOTTOM` |
| `width`,`height` | Number | pixel int (or percentage / content via coord logic) |
| `length` | Number | int |
| `min_width`,`max_width`,`min_height`,`max_height` | Number | int |
| `x`,`y` | Number | int |
| `transform_width`,`transform_height` | Number | int |
| `translate_x`,`translate_y` | Number | int |
| `transform_zoom` | Number | int, 256 = normal |
| `transform_scale_x`,`transform_scale_y` | Number | int |
| `transform_angle`,`transform_rotation` | Number | int, 0.1° units |
| `transform_pivot_x`,`transform_pivot_y` | Number | int |
| `transform_skew_x`,`transform_skew_y` | Number | int |

### LAYOUT (`style-catalog.tsx:2616-2639`)

| key | type | value |
|---|---|---|
| `layout` | Enum | `NONE｜FLEX｜GRID` |
| `flex_flow` | Enum | `ROW, COLUMN, ROW_WRAP, ROW_REVERSE, ROW_WRAP_REVERSE, COLUMN_WRAP, COLUMN_REVERSE, COLUMN_WRAP_REVERSE` |
| `flex_main_place` | Enum | `START, END, CENTER, SPACE_EVENLY, SPACE_AROUND, SPACE_BETWEEN` |
| `flex_cross_place` | Enum | `START, END, CENTER` |
| `flex_track_place` | Enum | `START, END, CENTER, SPACE_EVENLY, SPACE_AROUND, SPACE_BETWEEN` |
| `flex_grow` | Number | int |
| `grid_column_align`,`grid_row_align` | Enum | `START, CENTER, END, STRETCH, SPACE_EVENLY, SPACE_AROUND, SPACE_BETWEEN` |
| `grid_row_dsc_array`,`grid_column_dsc_array` | NumberArrayAsString | e.g. `"50, FR(1), CONTENT"` |
| `grid_cell_column_pos`,`grid_cell_column_span`,`grid_cell_row_pos`,`grid_cell_row_span` | Number | int |
| `grid_cell_x_align`,`grid_cell_y_align` | Enum | same 7 grid-align values |

Load-time migration: legacy grid-align `EVENLY`/`AROUND`/`BETWEEN` → `SPACE_EVENLY`/… for
the 4 grid align props (`style-definition.tsx:100-131`).

### PADDING (`style-catalog.tsx:2641-2654`)
`pad_top`, `pad_bottom`, `pad_left`, `pad_right`, `pad_radial`, `pad_row`, `pad_column` — Number ints.

### MARGIN (`style-catalog.tsx:2656-2666`)
`margin_top`, `margin_bottom`, `margin_left`, `margin_right` — Number ints.

### BACKGROUND (`style-catalog.tsx:2668-2693`)

| key | type | value |
|---|---|---|
| `bg_color` | ThemedColor | `"#RRGGBB"` or theme name |
| `bg_opa` | Number | int 0–255 |
| `bg_grad_dir` | Enum | `NONE｜VER｜HOR` |
| `bg_grad_color` | ThemedColor | `"#RRGGBB"` |
| `bg_grad_stop`,`bg_main_stop` | Number | int 0–255 |
| `bg_main_opa`,`bg_grad_opa` | Number | int |
| `bg_dither_mode` | Enum | `NONE｜ORDERED｜ERR_DIFF` |
| `bg_img_src` | ObjectReference→bitmaps | bitmap name string |
| `bg_img_opa` | Number | int |
| `bg_img_recolor` | ThemedColor | `"#RRGGBB"` |
| `bg_img_recolor_opa` | Number | int |
| `bg_img_tiled` | Boolean | `true`/`false` |

### BORDER (`style-catalog.tsx:2695-2705`)

| key | type | value |
|---|---|---|
| `border_color` | ThemedColor | `"#RRGGBB"` |
| `border_opa` | Number | int |
| `border_width` | Number | int |
| `border_side` | Enum (OR) | `NONE｜FULL｜INTERNAL`, or `\|`-joined subset of `BOTTOM,TOP,LEFT,RIGHT` (e.g. `"TOP\|LEFT"`) |
| `border_post` | Boolean | `true`/`false` |

### OUTLINE (`style-catalog.tsx:2707-2717`)
`outline_width` (int), `outline_color` (`"#RRGGBB"`), `outline_opa` (int), `outline_pad` (int).

### SHADOW (`style-catalog.tsx:2719-2731`)
`shadow_width`, `shadow_ofs_x`, `shadow_ofs_y`, `shadow_spread` (ints), `shadow_color`
(`"#RRGGBB"`), `shadow_opa` (int).

### IMAGE (`style-catalog.tsx:2733-2741`)
`img_opa` (int), `img_recolor` (`"#RRGGBB"`), `img_recolor_opa` (int).

### LINE (`style-catalog.tsx:2743-2754`)
`line_width`, `line_dash_width`, `line_dash_gap` (ints), `line_rounded` (Boolean),
`line_color` (`"#RRGGBB"`), `line_opa` (int).

### ARC (`style-catalog.tsx:2756-2766`)
`arc_width` (int), `arc_rounded` (Boolean), `arc_color` (`"#RRGGBB"`), `arc_opa` (int),
`arc_img_src` (ObjectReference→bitmaps, bitmap name).

### TEXT (`style-catalog.tsx:2768-2781`)

| key | type | value |
|---|---|---|
| `text_color` | ThemedColor | `"#RRGGBB"` or theme name |
| `text_opa` | Number | int 0–255 |
| `text_font` | Enum(fonts) | **built-in** `MONTSERRAT_XX` or **custom font project name** — see below |
| `text_letter_space`,`text_line_space` | Number | int |
| `text_decor` | Enum (OR) | `NONE`, or `\|`-joined subset of `UNDERLINE,STRIKETHROUGH` |
| `text_align` | Enum | `AUTO｜LEFT｜CENTER｜RIGHT` |

### MISCELLANEOUS (`style-catalog.tsx:2783-2802`)

| key | type | value |
|---|---|---|
| `radius` | Number | int (or max-radius constant) |
| `radial_offset` | Number | int |
| `clip_corner` | Boolean | `true`/`false` |
| `opa` | Number | int 0–255 |
| `blend_mode` | Enum | `NORMAL, ADDITIVE, SUBTRACTIVE, MULTIPLY, REPLACE` |
| `base_dir` | Enum | `LTR｜RTL｜AUTO` |
| `anim` | String | e.g. `"delay=1000, repeat_delay=1000, repeat_count=3"` |
| `anim_time`,`anim_duration`,`anim_speed` | Number | int ms/speed |

**Not serialized** (commented out of `lvglProperties`): `color_filter_dsc`,
`color_filter_opa`, `bg_grad`, `transition`.

### `text_font` — exact format (critical)

`text_font` is an Enum whose items are project fonts first, then built-ins
(`style-catalog.tsx:2075-2101`). Stored value is the **bare id string**:

- **Built-in** → uppercase Montserrat name. `BUILT_IN_FONTS` (`style-catalog.tsx:55-77`) =
  `MONTSERRAT_8, _10, _12, _14, _16, _18, _20, _22, _24, _26, _28, _30, _32, _34, _36, _38,
  _40, _42, _44, _46, _48` (even sizes 8–48). At C-build → `&lv_font_montserrat_32`.
- **Custom** → the font's project `name` **verbatim**. E.g. `"text_font": "calibriBS"`.
  Resolution: not in `BUILT_IN_FONTS` → `findFont(project, value)`. At C-build →
  `&ui_font_<snake>`.

### localStyles (per-widget)

```jsonc
"localStyles": {
  "objID": "<FRESH-UUID>",
  "definition": {
    "MAIN":      { "DEFAULT": { "text_font": "calibriBS", "bg_color": "#1e88e5", "bg_opa": 255, "text_color": "#ffffff" } },
    "INDICATOR": { "DEFAULT": { "bg_opa": 128 } }
  }
}
```
Empty = `"localStyles": {}`. "Has modifications" iff `definition` has ≥1 key
(`style-definition.tsx:932-934`).

### Shared styles container (`lvglStyles`)

```jsonc
"lvglStyles": {
  "styles": [
    {
      "objID": "<FRESH-UUID>",
      "name": "PrimaryButton",
      "forWidgetType": "LVGLButtonWidget",
      "childStyles": [],
      "definition": {
        "objID": "<FRESH-UUID>",
        "definition": {
          "MAIN": { "DEFAULT": { "bg_color": "#1e88e5", "bg_opa": 255, "text_font": "calibriBS", "text_color": "#ffffff" } }
        }
      }
    }
  ],
  "defaultStyles": {}
}
```
- `name`: unique. `forWidgetType`: widget class name (default `"LVGLPanelWidget"`); only
  matching widgets may select the style. `childStyles`: nested `LVGLStyle[]` for inheritance
  (child inherits any prop it does not set from parent). `definition`: an
  `LVGLStylesDefinition` (own `objID`) with the same 3-level map.
- `defaultStyles`: `{ widgetType: styleName }`, e.g. `{"LVGLButtonWidget":"PrimaryButton"}`;
  `{}` if none.

Widget reference: `"useStyle": "PrimaryButton"` (an ObjectReference serialized as the style
name). A widget may carry both `useStyle` and `localStyles`; shared applied first, local on top.
A widget with no `useStyle` inherits `defaultStyles[widget.type]`.

(`style.tsx:100-172, 344-448, 687-734`; `widgets/Base.tsx:585-587, 902-915, 1037-1044`.)

---

## Parts and states

### PART keys (`lvgl-constants.ts:360-389`)
`MAIN`, `SCROLLBAR`, `INDICATOR`, `KNOB`, `SELECTED`, `ITEMS`, `CURSOR`,
`CUSTOM1` (alias `TEXTAREA_PLACEHOLDER`), `ANY`; **v8-only** `TICKS`; custom parts
`custom1`, `custom2`, … (lowercase; `getPartCode` maps `custom` + index → `CUSTOM1 + N-1`).
Default when unset: `MAIN`.

### STATE keys (`lvgl-constants.ts:343-354`)
`DEFAULT`, `CHECKED`, `PRESSED`, `CHECKED|PRESSED`, `DISABLED`, `FOCUSED`, `FOCUS_KEY`,
`EDITED`, `HOVERED`, `SCROLLED`. A state key may be a single name or a `\|`-OR combination
(e.g. `"CHECKED|PRESSED"`). Full bit map also includes `USER_1..USER_4`, `ANY`.
`DEFAULT` = `0x0000` (base state).

---

## Events and actions

### EventHandler entry (`flow/component.tsx:2480-2600`)

On a widget's `eventHandlers` array; **no separate `objID`** (identity from owning widget):

```jsonc
{ "eventName": "CLICKED", "handlerType": "action", "action": "myAction", "userData": 0 }
```
- `eventName` — enum (see list). `handlerType` — `"flow"` (default) or `"action"`.
  - `"action"` *(the no-flow path)* — `action` is an ObjectReference → `actions[].name`
    (present only for this handler type); the event dispatches to that native action.
  - `"flow"` *(the flow path)* — the event becomes a flow **output** on the widget's
    component, wired to downstream flow components via a `connectionLine` in the owning
    page/action's `connectionLines[]`. No `action` field.
- `userData` — int, default `0`.
- Legacy `trigger` → `eventName` on load.

### Valid `eventName` (LVGL 8.4, `LVGL_EVENTS_V8`, `lvgl-constants.ts:398-451`)
`PRESSED(1)`, `PRESSING(2)`, `PRESS_LOST(3)`, `SHORT_CLICKED(4)`, `LONG_PRESSED(5)`,
`LONG_PRESSED_REPEAT(6)`, `CLICKED(7)`, `RELEASED(8)`, `SCROLL_BEGIN(9)`, `SCROLL_END(10)`,
`SCROLL(11)`, `GESTURE(12)`, `KEY(13)`, `FOCUSED(14)`, `DEFOCUSED(15)`, `LEAVE(16)`,
`HIT_TEST(17)`, `COVER_CHECK(18)`, `REFR_EXT_DRAW_SIZE(19)`, `DRAW_MAIN_BEGIN(20)`,
`DRAW_MAIN(21)`, `DRAW_MAIN_END(22)`, `DRAW_POST_BEGIN(23)`, `DRAW_POST(24)`,
`DRAW_POST_END(25)`, `DRAW_PART_BEGIN(26)`, `DRAW_PART_END(27)`, `VALUE_CHANGED(28)`,
`INSERT(29)`, `REFRESH(30)`, `READY(31)`, `CANCEL(32)`, `DELETE(33)`, `CHILD_CHANGED(34)`,
`CHILD_CREATED(35)`, `CHILD_DELETED(36)`, `SCREEN_UNLOAD_START(37)`, `SCREEN_LOAD_START(38)`,
`SCREEN_LOADED(39)`, `SCREEN_UNLOADED(40)`, `SIZE_CHANGED(41)`, `STYLE_CHANGED(42)`,
`LAYOUT_CHANGED(43)`, `GET_SELF_SIZE(44)`.
Plus EEZ-synthetic `CHECKED(0x7E)` / `UNCHECKED(0x7F)` → mapped to `LV_EVENT_VALUE_CHANGED`
at build, guarded by `lv_obj_has_state(..., LV_STATE_CHECKED)`.

### Action entry (top-level `actions[]`, `features/action/action.tsx:172-421`)

`Action extends Flow`, so every action object carries `components[]`, `connectionLines[]`,
and `localVariables[]`. `implementationType` selects how the action is implemented:

**Native — `implementationType: "native"` *(no-flow-specific)*:**
```jsonc
{
  "objID": "<FRESH-UUID>",
  "name": "myAction",
  "implementationType": "native",
  "components": [],
  "connectionLines": [],
  "localVariables": []
}
```
Flow arrays are present but empty; the body is hand-written C. Generated declaration:
`extern void action_<snake>(lv_event_t * e);`.

**Flow — `implementationType: "flow"` (default):** same object shape, but `components[]` /
`connectionLines[]` / `localVariables[]` are populated with the visual flow graph
(`ActionComponent` subclasses wired by connection lines) — no native C stub required; the
`eez-framework` runtime executes it.

Optional on either: `id?` (number), `description?`, `usedIn?`, `userProperties?`.

---

## Fonts

### Font entry (`features/font/font.tsx:1450-1720`)

```jsonc
{
  "objID": "<FRESH-UUID>",
  "name": "Roboto16",
  "source": { "filePath": "fonts/Roboto-Regular.ttf", "size": 16 },
  "bpp": 4,
  "threshold": 128,
  "lvglRanges": "0x20-0x7F",
  "lvglSymbols": "",
  "lvglFallbackFont": "",
  "embeddedFontFile": "…base64…"
}
```
- `name` unique; this is what a style's `text_font` references verbatim.
- `source` = `{ filePath, size? }`. `bpp` ∈ {1,2,4,8}. `threshold` default 128.
- FreeType variants: `lvglUseFreeType`, `lvglFreeTypeFilePath`, `lvglFreeTypeRenderMode`,
  `lvglFreeTypeStyle`.

### Name → C variable
- `name` → `ui_font_<snake_lowercase>` (e.g. `Roboto16` → `ui_font_roboto16`).
- Style reference emits accessor: `&ui_font_<snake>` (compiled) or `ui_font_<snake>`
  (binary/FreeType). Registry `ext_font_desc_t fonts[]` pairs `{ "Roboto16", &ui_font_roboto16 }`.
- Built-in `MONTSERRAT_32` → `&lv_font_montserrat_32`.

---

## Name mappings

Core: `getName(prefix, name, convention)` (`project/assets.ts:208-234`): strip `$`, replace
every non-`[A-Za-z0-9_]` char with `_`, apply `UnderscoreLowerCase`/`UnderscoreUpperCase`,
prepend `prefix`.

| Source | Generated C |
|---|---|
| Widget `identifier` | `objects.<snake_lower>` (e.g. `startButton` → `objects.start_button`) |
| Widget w/o identifier (code-accessed) | auto `obj0`, `obj1`, … (`GENERATED_NAME_PREFIX="obj"`) |
| Action `name` (native / no-flow) | `action_<snake_lower>(lv_event_t *e)` |
| Font `name` | `ui_font_<snake_lower>` |
| Bitmap/image `name` | `img_<snake_lower>` (runtime `ui_image_<snake>` for binary) |
| Screen/page `name` | `objects.<snake>`, `create_screen_<snake>`, `tick_screen_<snake>`, `delete_screen_<snake>` |
| User-widget | `create_user_widget_<snake>`, `tick_user_widget_<snake>`; nested identifiers prefixed `<parent>__` |
| Variable (native / no-flow) | `get_var_<snake>` / `set_var_<snake>` (in flow projects these hooks are not hand-written; the runtime resolves variables) |
| Style fns | `add_style_<snake>`, `remove_style_<snake>`, `init_style_<snake>_<part>_<state>`, `get_style_<snake>_<part>_<state>` |
| Group `name` | `groups.<name>` |
| Screen enum | `SCREEN_ID_<UPPER>`; themes `THEME_ID_<UPPER>`; colors `COLOR_ID_<UPPER>` |
| Action property enum | `ACTION_<UPPER>_PROPERTY_<UPPER>` |

`widgetFlags` = `\|`-joined flag-name string (e.g. `"HIDDEN|CLICKABLE"`). Legacy `flags` →
`widgetFlags` on load. Flag codes: `LVGL_FLAG_CODES` (8.x) vs `LVGL_FLAG_CODES_90` (9.x) —
differ only in `OVERFLOW_VISIBLE` bit. Style state bits differ in v9.5.0
(`lvglStates_V9_5_0`). Keep new widgets consistent with the file's existing LVGL version.

---

## Source index

All paths under `packages/project-editor/`.

- Style 3-level shape & key path: `lvgl/style-definition.tsx:46-52, 83-86`
- Grid-align load migration: `lvgl/style-definition.tsx:100-131`
- Color validity (hex or theme name): `lvgl/style-definition.tsx:332-359`; `lvgl/style-helper.ts:100-115,136`
- Font resolution (built-in vs custom): `lvgl/style-definition.tsx:405-413,492-524`; `lvgl/style-catalog.tsx:2075-2101, 55-77`
- Enums stored bare: `lvgl/style-catalog.tsx:149-172`
- Booleans → true/false: `lvgl/style-definition.tsx:569-570, 746-747`
- Opacity raw int: `lvgl/style-helper.ts:171-181`
- Style property sections/order: `lvgl/style-catalog.tsx:2576-2803`
- PARTs: `lvgl/lvgl-constants.ts:360-389`; custom part parse `lvgl/style-helper.ts:24-27`
- STATEs: `lvgl/lvgl-constants.ts:343-354, 260-296`; `\|` split `lvgl/style-helper.ts:42-57`
- Widget base fields: `lvgl/widgets/Base.tsx:559-1061`; back-fill hook `1063-1199`
- Widget type list: `lvgl/widgets/index.ts:127-166`
- Component/Widget base: `flow/component.tsx:1746-2856`
- EventHandler + `trigger` migration: `flow/component.tsx:2480-2600`
- Events per version: `lvgl/lvgl-constants.ts:398-451`; `lvgl/lvgl-versions.ts`
- Event C emission: `lvgl/widgets/Base.tsx:1637-1812`; `lvgl/build.ts:1633-1710`
- Native actions: `features/action/action.tsx:172-421`; `lvgl/actions.tsx`
- Shared styles container: `lvgl/style.tsx:687-734, 884-899`
- LVGLStyle: `lvgl/style.tsx:100-172`; inheritance `344-448, 740-755`
- Fonts: `features/font/font.tsx:1450-1720`; `ui_font_` map `lvgl/build.ts:767-783, 2001-2012`
- Name funcs: `project/assets.ts:202-234`; identifiers `lvgl/identifiers.ts`; `lvgl/build.ts:227-387, 516-817`
- Top-level project keys / legacy split: `project/project.tsx:1424-1572`
- Page/screen shape: `features/page/page.tsx`; Flow base `flow/flow.tsx:55-75`
- Flow graph shape (`components`/`connectionLines`/`localVariables`): `flow/flow.tsx:65-71, 167-169`
- Flow components (`ActionComponent`): `flow/component.tsx:4366`
- `flowSupport` project trait: `project/project-type-traits.ts:94-96`
