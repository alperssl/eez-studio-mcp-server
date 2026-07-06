#!/usr/bin/env node
// learn.mjs — publish an eez-editor "learning".
//
// After the eez-editor agent has corrected its own guidance (the agent file and/or the
// eez-project-editor skill) and logged the change in the skill's LEARNINGS.md, run this to
// put the update into the running system AND into version control in one step:
//   1. sync `.claude/agents/eez-editor.md` + `.claude/skills/eez-project-editor/` into ~/.claude
//      (so the live agent/skill use it immediately), and
//   2. commit + push ONLY those files to GitHub.
//
//   node tools/learn.mjs "docs(skill): <summary>"      # sync + commit + push
//   node tools/learn.mjs "..." --no-push               # sync + commit, leave push to you
//   node tools/learn.mjs "..." --dry-run               # show what would happen, change nothing
//
// Scope guard: it only ever stages/commits the eez agent file and the eez skill folder, so a
// learning can never sweep unrelated working-tree changes into a commit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const AGENT_REL = ".claude/agents/eez-editor.md";
const SKILL_REL = ".claude/skills/eez-project-editor";

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const msg = args.find(a => !a.startsWith("--"));
const DRY = flags.has("--dry-run");
const NO_PUSH = flags.has("--no-push");

if (!msg || flags.has("--help") || flags.has("-h")) {
    console.log('usage: node tools/learn.mjs "<commit message>" [--no-push] [--dry-run]');
    process.exit(msg ? 0 : 1);
}

function git(cmd) {
    if (DRY) { console.log("   [dry-run] git " + cmd); return { ok: true, out: "" }; }
    const r = spawnSync("git " + cmd, { cwd: REPO, shell: true, stdio: "pipe", encoding: "utf8" });
    return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

// --- 1. sync repo agent + skill -> ~/.claude (the running system) --------------------
const agentSrc = path.join(REPO, AGENT_REL);
const agentDst = path.join(HOME, AGENT_REL);
const skillSrc = path.join(REPO, SKILL_REL);
const skillDst = path.join(HOME, SKILL_REL);
console.log("• sync eez-editor agent + skill -> ~/.claude");
if (!DRY) {
    fs.mkdirSync(path.dirname(agentDst), { recursive: true });
    fs.copyFileSync(agentSrc, agentDst);
    fs.mkdirSync(skillDst, { recursive: true });
    fs.rmSync(skillDst, { recursive: true, force: true });
    fs.cpSync(skillSrc, skillDst, { recursive: true });
}
console.log(`   agent -> ${agentDst}`);
console.log(`   skill -> ${skillDst}`);

// --- 2. commit + push ONLY the eez agent + skill -------------------------------------
console.log("• publish to git " + (NO_PUSH ? "(local commit only)" : "+ push"));
git(`add -- "${AGENT_REL}" "${SKILL_REL}"`);
const staged = git(`diff --cached --name-only -- "${AGENT_REL}" "${SKILL_REL}"`);
if (!DRY && !staged.out.trim()) {
    console.log("   nothing to commit — the agent/skill are unchanged. (Synced to ~/.claude anyway.)");
    process.exit(0);
}

const tmpMsg = path.join(os.tmpdir(), "eez-learn-commit-msg.txt");
if (!DRY) fs.writeFileSync(tmpMsg, msg + "\n");
// Pathspec-limited commit: only the two eez paths land in this commit, regardless of what
// else may be staged in the working tree.
const c = git(`commit -F "${tmpMsg}" -- "${AGENT_REL}" "${SKILL_REL}"`);
if (!c.ok && !DRY) { console.error("   ✗ commit failed:\n" + c.out); process.exit(1); }
const head = DRY ? "(dry-run)" : (git("rev-parse --short HEAD").out || "").trim();
console.log(`   committed ${head}: ${msg}`);

if (NO_PUSH) {
    console.log("   --no-push: commit left local. Push it yourself when ready.");
} else {
    const p = git("push origin HEAD");
    if (!p.ok && !DRY) { console.error("   ✗ push failed:\n" + p.out); process.exit(1); }
    console.log("   ✓ pushed to origin.");
}
console.log("✓ learning published.");
