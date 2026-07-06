# Registering the MCP server with your agent

`eez-studio-mcp` is a **standalone MCP server** that your agent client (Claude Code, Claude
Desktop, etc.) launches over stdio. Registration happens on the **client side** — it is *not* a
setting inside EEZ Studio.

Two pieces, two places:

| Piece | Lives in | Configured how |
|---|---|---|
| **Bridge** | EEZ Studio with the bridge — install the **MCP Bridge extension** (`node extension/install.mjs`; see [`../extension/README.md`](../extension/README.md)) | Nothing to register — it auto-starts when a project is open, binds `127.0.0.1`, and writes a handshake file. Config: `<userData>/eez-mcp-bridge-config.json` = `{ enabled, port }`; env `EEZ_MCP_BRIDGE_PORT` / `EEZ_MCP_BRIDGE_TOKEN` / `EEZ_MCP_BRIDGE=0`. |
| **MCP server** | this repo (`mcp-server/`) | Registered with your agent client (below). Auto-discovers the bridge via the handshake file — no port/token needed normally. |

## Prerequisites

1. EEZ Studio **with the bridge** is running with a project open. Install the **MCP Bridge
   extension** — see [`../extension/README.md`](../extension/README.md). After installing and
   restarting EEZ Studio, launching it (or double-clicking a `.eez-project`) starts the bridge.
   (For bridge internals or rebuilding `bridge/dist`, see [`../bridge/README.md`](../bridge/README.md).)
2. The MCP server is built:
   ```bash
   cd mcp-server && npm install && npm run build
   ```

## Claude Code (CLI)

Global (available in every project):
```bash
claude mcp add eez-studio -s user -- node /ABSOLUTE/PATH/TO/mcp-server/dist/index.js
```
Project-scoped (only this repo/project): copy the sample and edit the path if needed:
```bash
cp .mcp.json.example .mcp.json
```

## Claude Desktop / other MCP clients

Add to the client's MCP config (`mcpServers`):
```json
{
  "mcpServers": {
    "eez-studio": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-server/dist/index.js"]
    }
  }
}
```

Optional env (only if you changed the bridge's port/token; normally omit — discovery is automatic):
```json
"env": { "EEZ_MCP_BRIDGE_PORT": "38017", "EEZ_MCP_BRIDGE_TOKEN": "<token>" }
```

## Verify

With EEZ Studio (bridge running) and a project open:
```bash
cd mcp-server
npm run smoke          # raw-WebSocket check: ping / get_project_info / list_pages
node scripts/mcp-e2e.mjs   # full MCP round-trip: tools/list + get_project_info + render_page
```
If the handshake file is missing, the server reports that EEZ Studio with the bridge is not
running — launch it first.
