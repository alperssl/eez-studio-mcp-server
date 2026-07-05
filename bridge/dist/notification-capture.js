"use strict";
// Capture EEZ Studio's toast notifications (eez-studio-ui/notification, a thin wrapper
// over react-toastify) into a ring buffer. This is where errors like
//   Font "roboto22" extraction failed: The value of "size" is out of range ... Received NaN
// surface — they go through notification.update(toastId, { render, type }), so they are
// invisible to both the console and the project checks. The agent reads them via
// get_notifications.
Object.defineProperty(exports, "__esModule", { value: true });
exports.installNotificationCapture = installNotificationCapture;
exports.getNotifications = getNotifications;
const MAX_ENTRIES = 300;
const buffer = [];
let installed = false;
const LEVEL_ORDER = {
    success: 0,
    info: 1,
    warning: 2,
    error: 3
};
function mapType(type) {
    if (type === "error")
        return "error";
    if (type === "warning")
        return "warning";
    if (type === "success")
        return "success";
    return "info";
}
// react-toastify content can be a string or a React node; extract readable text.
function toText(content) {
    if (typeof content === "string")
        return content;
    if (content == null)
        return "";
    const props = content.props;
    if (props && typeof props.children === "string")
        return props.children;
    try {
        return String(content);
    }
    catch (e) {
        return "";
    }
}
function record(level, text) {
    if (!text)
        return;
    const last = buffer[buffer.length - 1];
    if (last && last.text === text && last.level === level) {
        last.count++;
        last.ts = new Date().toISOString();
        return;
    }
    buffer.push({ ts: new Date().toISOString(), level, text, count: 1 });
    if (buffer.length > MAX_ENTRIES)
        buffer.shift();
}
/** Wrap the notification module's functions to also record into the buffer. Idempotent. */
function installNotificationCapture() {
    if (installed)
        return;
    installed = true;
    let mod;
    try {
        mod = require("eez-studio-ui/notification");
    }
    catch (e) {
        return;
    }
    const wrapSimple = (name, level) => {
        const original = mod[name];
        if (typeof original !== "function")
            return;
        try {
            mod[name] = (message, options) => {
                try {
                    record(level, toText(message));
                }
                catch (e) {
                    /* ignore */
                }
                return original(message, options);
            };
        }
        catch (e) {
            /* property not writable — capture unavailable for this fn */
        }
    };
    wrapSimple("error", "error");
    wrapSimple("warn", "warning");
    wrapSimple("info", "info");
    wrapSimple("success", "success");
    // update() carries the final render+type for toasts that start as a spinner and
    // resolve to success/error (this is how font extraction reports its result).
    const originalUpdate = mod.update;
    if (typeof originalUpdate === "function") {
        try {
            mod.update = (toastId, options) => {
                try {
                    if (options && options.render !== undefined) {
                        record(mapType(options.type), toText(options.render));
                    }
                }
                catch (e) {
                    /* ignore */
                }
                return originalUpdate(toastId, options);
            };
        }
        catch (e) {
            /* ignore */
        }
    }
}
/** Entries at or above `minLevel` (default "warning"), most-recent `limit` (default 100). */
function getNotifications(minLevel = "warning", limit = 100) {
    const min = LEVEL_ORDER[minLevel] ?? 0;
    const filtered = buffer.filter(e => (LEVEL_ORDER[e.level] ?? 0) >= min);
    return limit > 0 ? filtered.slice(-limit) : filtered;
}
