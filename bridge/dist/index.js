"use strict";
// EEZ Studio MCP Bridge — entry point.
// Imported from the renderer bootstrap (packages/home/main.tsx) to start the
// localhost WebSocket bridge that the standalone eez-studio-mcp server connects to.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMcpBridge = void 0;
var bridge_1 = require("mcp-bridge/bridge");
Object.defineProperty(exports, "startMcpBridge", { enumerable: true, get: function () { return bridge_1.startMcpBridge; } });
