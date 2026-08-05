#!/bin/sh
# workbuddy2api container entrypoint.
#
# The CodeBuddy CLI is installed in the image ONLY to power the web panel's
# scan-QR / phone sign-in flow (LoginManager spawns it in an isolated HOME).
# Normal chat/tool-calling requests use the direct engine and never spawn it.
#
# Resolve the CLI location dynamically (bin may be `codebuddy` or `cbc`)
# and expose it via the env vars the service reads.

set -e

BIN="$(command -v codebuddy 2>/dev/null || command -v cbc 2>/dev/null || true)"
if [ -n "$BIN" ]; then
  DIR="$(cd "$(dirname "$(readlink -f "$BIN" 2>/dev/null || echo "$BIN")")/.." 2>/dev/null && pwd || dirname "$BIN")"
  export WORKBUDDY2API_CLI_BIN="$BIN"
  export WORKBUDDY2API_CLI_DIR="$DIR"
  echo "[entrypoint] CodeBuddy CLI: $BIN (dir: $DIR) — 用于面板登录"
else
  echo "[entrypoint] 警告: 未找到 CodeBuddy CLI，面板扫码/手机号登录不可用（对话功能不受影响）"
fi

exec node server.js
