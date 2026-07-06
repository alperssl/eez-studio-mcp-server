#!/usr/bin/env node
// learn.mjs — apply / publish an eez-editor "learning".
//
// When the eez-editor corrects its own guidance (its agent file + the eez-project-editor skill) and
// logs the change in the skill's LEARNINGS.md, this puts the update to work:
//   node tools/learn.mjs                    # APPLY: sync the agent + skill into ~/.claude (no git)
//   node tools/learn.mjs --public "<msg>"   # PUBLISH: commit + push the agent + skill to GitHub
//
// APPLY copies `.claude/agents/eez-editor.md` + `.claude/skills/eez-project-editor/` into ~/.claude so
// the live agent/skill use the correction immediately; it never touches git. PUBLISH commits + pushes
// ONLY those two paths (scope-guarded, so a learning can't sweep unrelated changes into a commit).
// Options: --dry-run, --no-push (with --public).

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
const PUBLIC = flags.has("--public");
const NO_PUSH = flags.has("--no-push");

if (flags.has("--help") || flags.has("-h")) {
    console.log(
        "learn.mjs — apply or publish an eez-editor learning\n" +
        "  node tools/learn.mjs                    APPLY: sync agent + skill -> ~/.claude (no git)\n" +
        '  node tools/learn.mjs --public "<msg>"   PUBLISH: commit + push agent + skill to GitHub\n' +
        "  options: --dry-run, --no-push (with --public)"
    );
    process.exit(0);
}

const say = s => console.log(s);
function git(cmd) {
    if (DRY) { say("   [dry-run] git " + cmd); return { ok: true, out: "" }; }
    const r = spawnSync("git " + cmd, { cwd: REPO, shell: true, stdio: "pipe", encoding: "utf8" });
    return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

if (PUBLIC) {
    // --- PUBLISH: commit + push ONLY the tracked agent + skill --------------------------------------
    if (!msg) {
        console.error('usage: node tools/learn.mjs --public "<commit message>" [--no-push] [--dry-run]');
        process.exit(1);
    }
    say("• publish: commit + push the eez-editor agent + skill to GitHub");
    git(`add -- "${AGENT_REL}" "${SKILL_REL}"`);
    const staged = git(`diff --cached --name-only -- "${AGENT_REL}" "${SKILL_REL}"`);
    if (!DRY && !staged.out.trim()) {
        say("   nothing to commit — the agent/skill are unchanged.");
        process.exit(0);
    }
    const tmpMsg = path.join(os.tmpdir(), "eez-learn-commit-msg.txt");
    if (!DRY) fs.writeFileSync(tmpMsg, msg + "\n");
    const c = git(`commit -F "${tmpMsg}" -- "${AGENT_REL}" "${SKILL_REL}"`);
    if (!c.ok && !DRY) { console.error("   ✗ commit failed:\n" + c.out); process.exit(1); }
    const head = DRY ? "(dry-run)" : (git("rev-parse --short HEAD").out || "").trim();
    say(`   committed ${head}: ${msg}`);
    if (NO_PUSH) {
        say("   --no-push: commit left local. Push it yourself when ready.");
    } else {
        const p = git("push origin HEAD");
        if (!p.ok && !DRY) { console.error("   ✗ push failed:\n" + p.out); process.exit(1); }
        say("   ✓ pushed to origin.");
    }
    say("✓ learning published.");
} else {
    // --- APPLY: sync the agent + skill into ~/.claude (no git) --------------------------------------
    const agentSrc = path.join(REPO, AGENT_REL);
    const skillSrc = path.join(REPO, SKILL_REL);
    const agentDst = path.join(HOME, AGENT_REL);
    const skillDst = path.join(HOME, SKILL_REL);
    say("• apply: sync eez-editor agent + skill -> ~/.claude");
    if (!DRY) {
        fs.mkdirSync(path.dirname(agentDst), { recursive: true });
        fs.copyFileSync(agentSrc, agentDst);
        fs.mkdirSync(path.dirname(skillDst), { recursive: true });
        fs.rmSync(skillDst, { recursive: true, force: true });
        fs.cpSync(skillSrc, skillDst, { recursive: true });
    }
    say(`   agent -> ${agentDst}`);
    say(`   skill -> ${skillDst}`);
    say("✓ applied to ~/.claude. Nothing pushed (use --public to commit + push to GitHub).");
}
