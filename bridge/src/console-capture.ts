// Capture renderer console output (errors/warnings/logs) into a ring buffer so the
// agent can retrieve runtime/preview diagnostics — e.g. LVGL-WASM glyph/font-range
// failures that surface only as console messages, not as project-check validations.

export type ConsoleLevel = "log" | "info" | "warn" | "error";

export interface ConsoleEntry {
    ts: string;
    level: ConsoleLevel;
    text: string;
    count: number; // consecutive duplicates collapsed into one entry
}

const MAX_ENTRIES = 500;
const buffer: ConsoleEntry[] = [];
let installed = false;

const LEVEL_ORDER: Record<ConsoleLevel, number> = {
    log: 0,
    info: 1,
    warn: 2,
    error: 3
};

// The LVGL-WASM runtime prints tagged messages (e.g. "…[Warn]…", "…[Error]…") through
// console.log; reclassify by the embedded tag so real warnings/errors are not hidden
// behind the "log" level.
const WASM_ERROR = /\[Error\]|\bError:/i;
const WASM_WARN = /\[Warn(?:ing)?\]/i;

function effectiveLevel(method: ConsoleLevel, text: string): ConsoleLevel {
    if (method === "error" || WASM_ERROR.test(text)) return "error";
    if (method === "warn" || WASM_WARN.test(text)) return "warn";
    return method;
}

function formatArg(a: unknown): string {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || a.message;
    try {
        return JSON.stringify(a);
    } catch (e) {
        return String(a);
    }
}

/** Wrap console.{log,info,warn,error} to also record into the ring buffer. Idempotent. */
export function installConsoleCapture(): void {
    if (installed) return;
    installed = true;
    const levels: ConsoleLevel[] = ["log", "info", "warn", "error"];
    for (const level of levels) {
        const original = (console as any)[level]?.bind(console);
        (console as any)[level] = (...args: unknown[]) => {
            try {
                const text = args.map(formatArg).join(" ");
                const lvl = effectiveLevel(level, text);
                const last = buffer[buffer.length - 1];
                if (last && last.text === text && last.level === lvl) {
                    last.count++;
                    last.ts = new Date().toISOString();
                } else {
                    buffer.push({
                        ts: new Date().toISOString(),
                        level: lvl,
                        text,
                        count: 1
                    });
                    if (buffer.length > MAX_ENTRIES) buffer.shift();
                }
            } catch (e) {
                /* never let capture break logging */
            }
            if (original) original(...args);
        };
    }
}

/** Entries at or above `minLevel` (default "warn"), most-recent `limit` (default 100). */
export function getConsoleEntries(
    minLevel: ConsoleLevel = "warn",
    limit: number = 100
): ConsoleEntry[] {
    const min = LEVEL_ORDER[minLevel] ?? 0;
    const filtered = buffer.filter(e => (LEVEL_ORDER[e.level] ?? 0) >= min);
    return limit > 0 ? filtered.slice(-limit) : filtered;
}
