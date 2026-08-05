#!/usr/bin/env bash
# 导入一个 CodeBuddy 账号到 workbuddy2api（多账号）
#
# 前置：先在账号的隔离 HOME 里完成一次 codebuddy 登录，例如：
#   sudo -u workbuddy bash -c 'HOME=/var/lib/workbuddy2api/accounts/acct1 codebuddy --print "hi"'
#   按提示扫码/打开链接登录后，会话文件会存在该 HOME 下。
#
# 用法:  sudo bash import-account.sh <accountId> [homeDir] [apiKey] [url]
#   accountId  账号 id（客户端用 X-Account-Id 选择）
#   homeDir    该账号登录时用的隔离 HOME（默认 /var/lib/workbuddy2api/accounts/<accountId>）
#   apiKey     服务 API key（默认读 /opt/workbuddy2api/.env）
#   url        服务地址（默认 http://127.0.0.1:8787）
set -euo pipefail

ACCT_ID="${1:?usage: import-account.sh <accountId> [homeDir] [apiKey] [url]}"
HOME_DIR="${2:-/var/lib/workbuddy2api/accounts/$ACCT_ID}"
URL="${4:-http://127.0.0.1:8787}"

# 读 API key
if [ -n "${3:-}" ]; then
  API_KEY="$3"
elif [ -f /opt/workbuddy2api/.env ]; then
  API_KEY="$(grep '^WORKBUDDY2API_API_KEY=' /opt/workbuddy2api/.env | cut -d= -f2-)"
else
  echo "ERROR: 需要提供 apiKey 或 /opt/workbuddy2api/.env" >&2
  exit 1
fi

# 找会话 .info 文件（含 refreshToken）
INFO="$(find "$HOME_DIR" -name '*.info' -path '*auth*' 2>/dev/null | head -1)"
if [ -z "$INFO" ]; then
  INFO="$(find "$HOME_DIR" -name '*.info' 2>/dev/null | head -1)"
fi
if [ -z "$INFO" ]; then
  echo "ERROR: 在 $HOME_DIR 下没找到会话文件。请先在该 HOME 完成一次 codebuddy 登录。" >&2
  exit 1
fi
echo "找到会话文件: $INFO"

# 用 node 提取 refreshToken 并注册
REFRESH="$(node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
console.log((d.auth&&d.auth.refreshToken)||'');
" "$INFO")"
if [ -z "$REFRESH" ]; then
  echo "ERROR: 会话文件里没有 refreshToken（可能已过期或不是登录会话）" >&2
  exit 1
fi

BODY=$(node -e "
const a={id:process.argv[1],name:process.argv[2],source:'manual',refreshToken:process.argv[3],home:process.argv[4]};
console.log(JSON.stringify(a));
" "$ACCT_ID" "$ACCT_ID" "$REFRESH" "$HOME_DIR")

echo "注册账号 $ACCT_ID ..."
RESP="$(curl -s -X POST "$URL/v1/accounts" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -d "$BODY")"
echo "$RESP"
echo "完成。客户端用 header 'X-Account-Id: $ACCT_ID' 使用该账号。"
