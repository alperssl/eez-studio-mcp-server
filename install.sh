#!/usr/bin/env bash
# EEZ Studio MCP Server — one-command installer (macOS / Linux).
# Runs installer/setup.mjs: installs the bridge extension, builds + registers the MCP
# server with Claude Code, and copies the eez-editor agent + eez-project-editor skill.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "  [!] Node.js was not found on your PATH."
    echo "      Install Node.js 18 or newer from https://nodejs.org and run this again."
    echo ""
    exit 1
fi

exec node "$DIR/installer/setup.mjs" "$@"
