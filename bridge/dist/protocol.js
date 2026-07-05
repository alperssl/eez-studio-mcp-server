"use strict";
// EEZ Studio MCP Bridge — shared constants & wire types (renderer side).
// See docs/PROTOCOL.md in the eez-studio-mcp repo for the authoritative contract.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeError = exports.HANDSHAKE_FILE = exports.DEFAULT_PORT = exports.PROTOCOL_VERSION = void 0;
const tslib_1 = require("tslib");
const os = tslib_1.__importStar(require("os"));
const path = tslib_1.__importStar(require("path"));
exports.PROTOCOL_VERSION = 1;
exports.DEFAULT_PORT = 38017;
exports.HANDSHAKE_FILE = path.join(os.tmpdir(), "eez-studio-mcp-bridge.json");
class BridgeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BridgeError";
    }
}
exports.BridgeError = BridgeError;
