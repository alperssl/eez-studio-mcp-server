#!/usr/bin/env node
// EEZ Studio MCP Server — one-step setup.
//
// Does everything needed to use the MCP server against a live EEZ Studio:
//   1. builds the MCP server (also provides ws + tslib for the extension bundle),
//   2. installs the bridge as a drop-in EEZ Studio extension,
//   3. registers the MCP server with Claude Code (`claude mcp add`),
//   4. copies the eez-editor agent + eez-project-editor skill into ~/.claude.
//
// Usage:
//   node installer/setup.mjs               # install everything
//   node installer/setup.mjs --uninstall   # reverse all of the above
//   node installer/setup.mjs --dry-run     # print what would happen, change nothing
//   node installer/setup.mjs --scope local # MCP registration scope (default: user)
//   node installer/setup.mjs --skip-mcp    # don't touch the Claude Code config
//   node installer/setup.mjs --skip-agent  # don't copy the agent + skill
//
// On Windows, double-click install.cmd. On macOS/Linux, run ./install.sh.
// Only uses Node built-ins + the sibling extension/_assemble.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assembleInto, extensionsFolderPath, EXTENSION_ID } from "../extension/_assemble.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIR = path.join(REPO, "mcp-server");
const MCP_ENTRY = path.join(MCP_DIR, "dist", "index.js");
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const AGENT_SRC = path.join(REPO, ".claude", "agents", "eez-editor.md");
const AGENT_DST = path.join(CLAUDE_DIR, "agents", "eez-editor.md");
const SKILL_SRC = path.join(REPO, ".claude", "skills", "eez-project-editor");
const SKILL_DST = path.join(CLAUDE_DIR, "skills", "eez-project-editor");
const MCP_NAME = "eez-studio";

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

if (flag("--help") || flag("-h")) {
    printHelp();
    process.exit(0);
}

const UNINSTALL = flag("--uninstall") || flag("--revert");
const DRY = flag("--dry-run");
const SKIP_MCP = flag("--skip-mcp");
const SKIP_AGENT = flag("--skip-agent");
const SCOPE = opt("--scope", "user");

// --- pretty logging (honors NO_COLOR) --------------------------------------
const useColor = !process.env.NO_COLOR;
const c = (code) => (useColor ? code : "");
const C = {
    dim: c("\x1b[2m"), green: c("\x1b[32m"), yellow: c("\x1b[33m"),
    red: c("\x1b[31m"), cyan: c("\x1b[36m"), bold: c("\x1b[1m"), reset: c("\x1b[0m")
};
const say = (s = "") => console.log(s);
const step = (n, total, t) => say(`\n${C.bold}${C.cyan}[${n}/${total}]${C.reset} ${C.bold}${t}${C.reset}`);
const ok = (s) => say(`   ${C.green}✓${C.reset} ${s}`);
const warn = (s) => say(`   ${C.yellow}!${C.reset} ${s}`);
const errline = (s) => say(`   ${C.red}✗${C.reset} ${s}`);
const info = (s) => say(`   ${C.dim}${s}${C.reset}`);
const q = (s) => `"${s}"`;

function run(cmd, { cwd, quiet } = {}) {
    if (DRY) {
        info(`[dry-run] ${cmd}${cwd ? "   (cwd: " + path.relative(REPO, cwd) + ")" : ""}`);
        return { ok: true, code: 0, out: "" };
    }
    const r = spawnSync(cmd, { cwd, shell: true, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
    return { ok: r.status === 0, code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}
const have = (cmd) => spawnSync(cmd, { shell: true, stdio: "pipe", encoding: "utf8" }).status === 0;

const haveNpm = have("npm --version");
const haveClaude = have("claude --version");

banner();
if (UNINSTALL) uninstall();
else install();

// ---------------------------------------------------------------------------
function banner() {
    say(`${C.bold}EEZ Studio MCP Server — ${UNINSTALL ? "uninstall" : "setup"}${C.reset}` +
        (DRY ? ` ${C.yellow}(dry-run)${C.reset}` : ""));
    info(`repo: ${REPO}`);
}

function install() {
    const TOTAL = 4;

    // 1. Build the MCP server. Runs first because it populates node_modules with ws +
    //    tslib, which the extension bundle (step 2) copies in.
    step(1, TOTAL, "Build the MCP server");
    if (!haveNpm) {
        errline("npm was not found on PATH. Install Node.js 18+ (it bundles npm) from https://nodejs.org, then re-run.");
        process.exit(1);
    }
    info("Installing dependencies (first run downloads packages — this can take a minute)…");
    if (!run("npm install", { cwd: MCP_DIR }).ok) { errline("`npm install` failed in mcp-server/."); process.exit(1); }
    if (!run("npm run build", { cwd: MCP_DIR }).ok) { errline("`npm run build` failed in mcp-server/."); process.exit(1); }
    if (!DRY && !fs.existsSync(MCP_ENTRY)) { errline(`build did not produce ${MCP_ENTRY}`); process.exit(1); }
    ok(`built ${path.relative(REPO, MCP_ENTRY)}`);

    // 2. Install the bridge extension into EEZ Studio's user-data extensions folder.
    step(2, TOTAL, "Install the EEZ Studio bridge extension");
    const target = path.join(extensionsFolderPath(), EXTENSION_ID);
    if (DRY) {
        info(`[dry-run] assemble extension -> ${target}`);
    } else {
        try {
            const res = assembleInto(target);
            ok(`extension -> ${res.targetDir} (${res.bridgeModules} bridge modules, deps: ${res.bundledDeps.join(", ")})`);
        } catch (e) {
            errline(`extension install failed: ${e.message}`);
            process.exit(1);
        }
        if (!fs.existsSync(path.dirname(extensionsFolderPath()))) {
            warn("EEZ Studio's user-data folder didn't exist — created it. Install/launch EEZ Studio 0.28.x to load the bridge.");
        }
    }

    // 3. Register the MCP server with Claude Code.
    step(3, TOTAL, "Register the MCP server with Claude Code");
    if (SKIP_MCP) {
        info("--skip-mcp: leaving the Claude Code config untouched.");
        info(`Register it yourself:  claude mcp add --scope ${SCOPE} ${MCP_NAME} -- node ${q(MCP_ENTRY)}`);
    } else if (!haveClaude) {
        warn("Claude Code CLI (`claude`) not found on PATH — skipping registration.");
        info(`Register it yourself:  claude mcp add --scope ${SCOPE} ${MCP_NAME} -- node ${q(MCP_ENTRY)}`);
    } else {
        run(`claude mcp remove ${MCP_NAME}`, { quiet: true }); // idempotent; ignore result
        const r = run(`claude mcp add --scope ${SCOPE} ${MCP_NAME} -- node ${q(MCP_ENTRY)}`, { quiet: true });
        if (r.ok) {
            ok(`registered '${MCP_NAME}' (scope: ${SCOPE})`);
        } else {
            warn(`could not auto-register: ${(r.out.trim().split("\n").pop() || "unknown error")}`);
            info(`Register it yourself:  claude mcp add --scope ${SCOPE} ${MCP_NAME} -- node ${q(MCP_ENTRY)}`);
        }
    }

    // 4. Copy the eez-editor agent + eez-project-editor skill into ~/.claude.
    step(4, TOTAL, "Copy the eez-editor agent + eez-project-editor skill");
    if (SKIP_AGENT) {
        info("--skip-agent: not copying the agent/skill.");
    } else if (DRY) {
        info(`[dry-run] copy ${path.relative(REPO, AGENT_SRC)} -> ${AGENT_DST}`);
        info(`[dry-run] copy ${path.relative(REPO, SKILL_SRC)}/ -> ${SKILL_DST}/`);
    } else {
        fs.mkdirSync(path.dirname(AGENT_DST), { recursive: true });
        fs.copyFileSync(AGENT_SRC, AGENT_DST);
        fs.mkdirSync(path.dirname(SKILL_DST), { recursive: true });
        fs.rmSync(SKILL_DST, { recursive: true, force: true });
        fs.cpSync(SKILL_SRC, SKILL_DST, { recursive: true });
        ok(`agent -> ${AGENT_DST}`);
        ok(`skill -> ${SKILL_DST}`);
    }

    // Summary.
    say(`\n${C.green}${C.bold}✓ Setup complete.${C.reset}${DRY ? ` ${C.yellow}(dry-run — nothing changed)${C.reset}` : ""}`);
    say(`${C.bold}Next:${C.reset}`);
    say(`  1. Restart EEZ Studio (or open a .eez-project). A floating "MCP Bridge" panel`);
    say(`     appears in the bottom-right corner and the bridge autostarts.`);
    say(`  2. Restart Claude Code / start a new session so it picks up the '${MCP_NAME}' MCP server.`);
    say(`  3. Open a project in EEZ Studio, then drive it with the eez-studio-mcp tools`);
    say(`     (or the eez-editor agent).`);
}

function uninstall() {
    const TOTAL = 3;

    step(1, TOTAL, "Remove the EEZ Studio bridge extension");
    const target = path.join(extensionsFolderPath(), EXTENSION_ID);
    if (DRY) info(`[dry-run] remove ${target}`);
    else if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); ok(`removed ${target}`); }
    else info("extension was not installed.");

    step(2, TOTAL, "Unregister the MCP server from Claude Code");
    if (DRY) info(`[dry-run] claude mcp remove ${MCP_NAME}`);
    else if (haveClaude) {
        const r = run(`claude mcp remove ${MCP_NAME}`, { quiet: true });
        if (r.ok) ok(`unregistered '${MCP_NAME}'`);
        else info(`'${MCP_NAME}' was not registered.`);
    } else warn("claude CLI not found — skip.");

    step(3, TOTAL, "Remove the agent + skill from ~/.claude");
    if (DRY) info(`[dry-run] remove ${AGENT_DST} and ${SKILL_DST}`);
    else {
        if (fs.existsSync(AGENT_DST)) fs.rmSync(AGENT_DST, { force: true });
        if (fs.existsSync(SKILL_DST)) fs.rmSync(SKILL_DST, { recursive: true, force: true });
        ok("removed the agent + skill");
    }

    say(`\n${C.green}✓ Uninstalled.${C.reset} (mcp-server/dist + node_modules are left in place; delete the repo folder to remove them.)`);
}

function printHelp() {
    say(`EEZ Studio MCP Server — one-step setup

  node installer/setup.mjs [options]      (or double-click install.cmd / run ./install.sh)

Installs the bridge extension, builds + registers the MCP server with Claude Code,
and copies the eez-editor agent + eez-project-editor skill into ~/.claude.

Options:
  --uninstall, --revert   Reverse everything the installer did.
  --dry-run               Print the actions without changing anything.
  --scope <local|user|project>   MCP registration scope (default: user).
  --skip-mcp              Don't touch the Claude Code config.
  --skip-agent           Don't copy the agent + skill.
  -h, --help             Show this help.`);
}
