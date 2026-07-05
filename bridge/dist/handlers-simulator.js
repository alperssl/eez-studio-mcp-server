"use strict";
// EEZ Studio MCP Bridge — LVGL-WASM simulator / Run mode (F5) controls.
//
// Run mode is transient RUNTIME/UI state, NOT undo state: starting/stopping the
// runtime creates/destroys a RuntimeBase on store.runtime (index.ts:174,1250,1288)
// and flips mobx observables. None of it goes through addObject/updateObject and
// none is recorded by the undo manager — so these handlers never touch
// setCombineCommands/updateObject.
//
// store.setRuntimeMode/onSetEditorMode funnel through a 300ms debounce
// (index.ts:1206-1229), and doStartRuntime boots a Web Worker asynchronously, so
// start/stop handlers POLL store.runtime (bounded timeout) rather than assuming
// synchronous completion. "Running" == store.runtime != undefined (there is no
// isRuntimeMode getter). See research/source-v6/simulator.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.simulatorHandlers = void 0;
const protocol_1 = require("mcp-bridge/protocol");
const project_access_1 = require("mcp-bridge/project-access");
const RUN_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 50;
const STEP_SETTLE_MS = 4000;
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** Poll a predicate until it returns true or the timeout elapses. */
async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await delay(POLL_INTERVAL_MS);
    }
    return predicate();
}
function stripDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
/** The live Run-mode runtime, or throw NOT_FOUND if the simulator is not running. */
function requireRuntime(store) {
    const rt = store.runtime; // index.ts:174
    if (!rt) {
        throw new protocol_1.BridgeError("NOT_FOUND", "Simulator is not running. Call run_simulator first.");
    }
    return rt;
}
exports.simulatorHandlers = {
    // --- run_simulator: start Run mode (F5) ---------------------------------
    async run_simulator(params) {
        const store = (0, project_access_1.requireLvglStore)();
        // For no-flow LVGL the debugger flag has no flow queue to inspect; only
        // honour it for flow projects (project-type-traits.ts:211-213).
        const wantDebugger = params && params.debugger === true &&
            !!store.projectTypeTraits.hasFlowSupport;
        if (!store.runtime) {
            store.setRuntimeMode(wantDebugger); // index.ts:1231
        }
        // Wait out the 300ms debounce + doStartRuntime + worker boot; the worker
        // may null store.runtime on a build error (wasm-runtime.tsx:217-221).
        await waitFor(() => !!store.runtime && !store.runtime.error, RUN_TIMEOUT_MS);
        const rt = store.runtime;
        if (!rt) {
            throw new protocol_1.BridgeError("INTERNAL", "Simulator failed to start (build error or runtime aborted).");
        }
        if (rt.error) {
            throw new protocol_1.BridgeError("INTERNAL", `Simulator reported an error: ${rt.error}`);
        }
        return {
            running: true,
            mode: rt.isDebuggerActive ? "debugger" : "runtime", // runtime.ts:85
            selectedPage: rt.selectedPage?.name ?? null // runtime.ts:132,182
        };
    },
    // --- stop_simulator: return to editor (Shift+F5) ------------------------
    async stop_simulator() {
        const store = (0, project_access_1.requireLvglStore)();
        if (!store.runtime) {
            return { running: false, mode: "editor" };
        }
        store.onSetEditorMode(); // index.ts:1303 (Shift+F5 handler)
        await waitFor(() => !store.runtime, STOP_TIMEOUT_MS);
        return { running: false, mode: "editor" };
    },
    // --- get_simulator_status: pure read of store.runtime -------------------
    get_simulator_status() {
        const store = (0, project_access_1.requireLvglStore)();
        const rt = store.runtime; // index.ts:174
        if (!rt) {
            return {
                running: false,
                isDebugger: false,
                isPaused: false,
                selectedPage: null,
                error: null
            };
        }
        return {
            running: true,
            isDebugger: !!rt.isDebuggerActive, // runtime.ts:85
            isPaused: !!rt.isPaused, // runtime.ts:116
            selectedPage: rt.selectedPage?.name ?? null, // runtime.ts:132
            error: rt.error ?? null // runtime.ts:91
        };
    },
    // --- screenshot_simulator: capture the running framebuffer --------------
    async screenshot_simulator() {
        const store = (0, project_access_1.requireLvglStore)();
        const rt = requireRuntime(store);
        // Ensure at least one frame has arrived.
        await waitFor(() => !!rt.lastScreen, 2000);
        // Prefer the live painted display canvas when a WasmCanvas is mounted
        // (identical read to render.ts). wasm-runtime.tsx:129,686.
        const liveCanvas = rt.ctx?.canvas;
        if (liveCanvas && liveCanvas.width > 0 && liveCanvas.height > 0) {
            return {
                png: stripDataUrl(liveCanvas.toDataURL("image/png")),
                width: liveCanvas.width,
                height: liveCanvas.height,
                source: "simulator"
            };
        }
        // Headless: encode lastScreen ourselves (wasm-runtime.tsx:145,658,695).
        const w = rt.displayWidth; // wasm-runtime.tsx:130
        const h = rt.displayHeight; // wasm-runtime.tsx:131
        if (!rt.lastScreen || !w || !h) {
            throw new protocol_1.BridgeError("INTERNAL", "No simulator frame available yet; wait for the first frame.");
        }
        const off = document.createElement("canvas");
        off.width = w;
        off.height = h;
        const ctx = off.getContext("2d");
        if (!ctx) {
            throw new protocol_1.BridgeError("INTERNAL", "Could not create an offscreen canvas for the screenshot.");
        }
        ctx.putImageData(new ImageData(rt.lastScreen, w, h), 0, 0);
        return {
            png: stripDataUrl(off.toDataURL("image/png")),
            width: w,
            height: h,
            source: "simulator"
        };
    },
    // --- pause_simulator: flow-debugger pause (UNSUPPORTED for no-flow) ------
    pause_simulator() {
        const store = (0, project_access_1.requireLvglStore)();
        const rt = requireRuntime(store);
        if (!store.projectTypeTraits.hasFlowSupport) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Pause requires a flow project with an active debugger; this is a no-flow LVGL project (nothing to pause).");
        }
        rt.pause(); // remote-runtime.ts:386
        return { isPaused: !!rt.isPaused }; // runtime.ts:116
    },
    // --- resume_simulator: flow-debugger resume (UNSUPPORTED for no-flow) ----
    resume_simulator() {
        const store = (0, project_access_1.requireLvglStore)();
        const rt = requireRuntime(store);
        if (!store.projectTypeTraits.hasFlowSupport) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Resume requires a flow project with an active debugger; this is a no-flow LVGL project.");
        }
        if (rt.isDebuggerActive) {
            rt.toggleDebugger(); // remote-runtime.ts:352
        }
        else {
            rt.resume(); // remote-runtime.ts:372
        }
        return { isPaused: !!rt.isPaused }; // runtime.ts:116
    },
    // --- step_simulator: single-step (UNSUPPORTED for no-flow) --------------
    async step_simulator(params) {
        const store = (0, project_access_1.requireLvglStore)();
        const rt = requireRuntime(store);
        if (!store.projectTypeTraits.hasFlowSupport) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Single-step requires a flow project with an active debugger; this is a no-flow LVGL project (no flow queue to step).");
        }
        if (!rt.isDebuggerActive || !rt.isPaused) {
            throw new protocol_1.BridgeError("UNSUPPORTED", "Step is only valid while paused in the debugger; pause the simulator first.");
        }
        const kind = (params && params.kind) ? params.kind : "step-over";
        if (kind !== "step-into" &&
            kind !== "step-over" &&
            kind !== "step-out") {
            throw new protocol_1.BridgeError("BAD_PARAMS", `kind must be step-into|step-over|step-out (got "${kind}").`);
        }
        rt.runSingleStep(kind); // remote-runtime.ts:411
        await waitFor(() => !!rt.isPaused, STEP_SETTLE_MS);
        return {
            selectedPage: rt.selectedPage?.name ?? null, // runtime.ts:132
            isPaused: !!rt.isPaused // runtime.ts:116
        };
    }
};
