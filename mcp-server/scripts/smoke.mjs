#!/usr/bin/env node
/**
 * Dependency-light raw-WebSocket smoke test for the EEZ Studio bridge.
 *
 * Validates the bridge WITHOUT a full MCP client: reads the handshake file,
 * connects, and calls ping -> get_project_info -> list_pages, printing results.
 *
 * Optional:  --render <pageName>  also calls render_page and writes the PNG to
 *            mcp-server/smoke-render.png
 *
 * Usage:
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --render Main
 *
 * Env overrides (match the bridge): EEZ_MCP_BRIDGE_PORT, EEZ_MCP_BRIDGE_TOKEN
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const DEFAULT_PORT = 38017;
const HANDSHAKE_FILENAME = "eez-studio-mcp-bridge.json";
const REQUEST_TIMEOUT_MS = 15000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const handshakePath = path.join(os.tmpdir(), HANDSHAKE_FILENAME);

function parseArgs(argv) {
  const args = { render: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--render") {
      args.render = argv[i + 1] ?? null;
      i++;
    }
  }
  return args;
}

function resolveTarget() {
  const envPort = process.env.EEZ_MCP_BRIDGE_PORT;
  const envToken = process.env.EEZ_MCP_BRIDGE_TOKEN;

  let filePort;
  let fileToken;
  try {
    const parsed = JSON.parse(readFileSync(handshakePath, "utf8"));
    filePort = parsed.port;
    fileToken = parsed.token;
    console.log(
      `Handshake: port=${parsed.port} pid=${parsed.pid ?? "?"} ` +
        `protocolVersion=${parsed.protocolVersion ?? "?"} eezStudioVersion=${parsed.eezStudioVersion ?? "?"}`
    );
  } catch (err) {
    if (!(envPort && envToken)) {
      if (err && err.code === "ENOENT") {
        console.error(
          "\nEEZ Studio with the MCP bridge is not running — launch it first.\n" +
            `No handshake file found at:\n  ${handshakePath}\n\n` +
            "If the bridge uses custom settings, set EEZ_MCP_BRIDGE_PORT and EEZ_MCP_BRIDGE_TOKEN."
        );
      } else {
        console.error(`\nCould not read handshake file at ${handshakePath}: ${err.message}`);
      }
      process.exit(1);
    }
  }

  const port = envPort ? Number(envPort) : filePort ?? DEFAULT_PORT;
  const token = envToken ?? fileToken;
  if (!token) {
    console.error(
      "\nNo bridge auth token available. Set EEZ_MCP_BRIDGE_TOKEN or ensure the handshake file has one."
    );
    process.exit(1);
  }
  return { port, token };
}

function connect({ port, token }) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

function request(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || msg.id !== id) return; // ignore events and other correlations
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`${method} failed [${msg.error?.code}]: ${msg.error?.message}`));
    }

    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }), (err) => {
      if (err) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(err);
      }
    });
  });
}

function print(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget();

  let ws;
  try {
    ws = await connect(target);
  } catch (err) {
    if (err && err.code === "ECONNREFUSED") {
      console.error(
        `\nCould not reach the bridge at 127.0.0.1:${target.port} — is EEZ Studio running with the MCP bridge enabled?`
      );
    } else if (/401/.test(err.message || "")) {
      console.error(
        "\nBridge rejected the token (HTTP 401). The handshake token may be stale — restart EEZ Studio."
      );
    } else {
      console.error(`\nConnection failed: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`Connected to bridge on 127.0.0.1:${target.port}`);

  try {
    print("ping", await request(ws, "ping"));
    print("get_project_info", await request(ws, "get_project_info"));
    print("list_pages", await request(ws, "list_pages"));

    if (args.render) {
      const rendered = await request(ws, "render_page", { page: args.render });
      const outPath = path.join(__dirname, "..", "smoke-render.png");
      writeFileSync(outPath, Buffer.from(rendered.pngBase64, "base64"));
      console.log(
        `\n=== render_page("${args.render}") ===\n` +
          `${rendered.width}x${rendered.height} PNG written to:\n  ${outPath}`
      );
    }

    console.log("\nSmoke test passed.");
  } catch (err) {
    console.error(`\nSmoke test failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
