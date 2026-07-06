// True end-to-end test THROUGH the MCP layer: spawns the eez-studio-mcp server over
// stdio (as an MCP client would), lists tools, and calls a few of them against a live
// EEZ Studio bridge. Project-agnostic: it discovers the project and uses its first page.
//
//   node scripts/mcp-e2e.mjs
//
// Requires EEZ Studio with the MCP Bridge extension running with a project open, and a
// prior `npm run build` in this package.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";

const log = (...a) => console.log("[mcp-e2e]", ...a);

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "eez-mcp-e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
log("connected to eez-studio-mcp over stdio");

const tools = await client.listTools();
log("tools exposed:", tools.tools.length, "->", tools.tools.map(t => t.name).join(", "));

function structured(res) {
    if (res.structuredContent) return res.structuredContent;
    const t = res.content?.find(c => c.type === "text");
    return t ? JSON.parse(t.text) : null;
}

const info = structured(await client.callTool({ name: "get_project_info", arguments: {} }));
log("get_project_info ->", info.name, `(LVGL ${info.lvglVersion}, ${info.pages.length} pages)`);
const page = info.pages[0];

const pages = structured(await client.callTool({ name: "list_pages", arguments: {} }));
log("list_pages ->", pages.pages.map(p => `${p.name}(${p.widgetCount}w)`).join(", "));

// Render through MCP: expect an image content block.
const render = await client.callTool({ name: "render_page", arguments: { page } });
const img = render.content?.find(c => c.type === "image");
if (!img || !img.data || img.mimeType !== "image/png") {
    console.error("render_page did NOT return a PNG image content block:", JSON.stringify(render).slice(0, 300));
    process.exit(1);
}
const outDir = path.resolve("e2e-out");
fs.mkdirSync(outDir, { recursive: true });
const outPng = path.join(outDir, `${page}.png`);
fs.writeFileSync(outPng, Buffer.from(img.data, "base64"));
log(`render_page("${page}") -> PNG ${Buffer.from(img.data, "base64").length} bytes -> ${outPng}`);

// A read of the tree, to exercise a structured tool.
const tree = structured(await client.callTool({ name: "get_page_tree", arguments: { page } }));
const count = (n) => 1 + (n.children || []).reduce((s, c) => s + count(c), 0);
log(`get_page_tree("${page}") -> root ${tree.root?.type}, ${tree.root ? count(tree.root) : 0} nodes`);

log("");
log("==== MCP E2E RESULT ====");
log("tools/list:      OK (" + tools.tools.length + " tools)");
log("get_project_info: OK");
log("list_pages:       OK");
log("render_page:      OK (image/png content block)");
log("get_page_tree:    OK");
await client.close();
process.exit(0);
