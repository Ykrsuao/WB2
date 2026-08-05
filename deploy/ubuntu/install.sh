#!/usr/bin/env bash
# workbuddy2api  Ubuntu 安装脚本
# 用法:  sudo bash install.sh   (在 Ubuntu 22.04/24.04 上)
set -euo pipefail

APP_DIR="${WORKBUDDY2API_DIR:-/opt/workbuddy2api}"
RUN_USER="${WORKBUDDY2API_USER:-workbuddy}"
PORT="${WORKBUDDY2API_PORT:-8787}"

echo "==> 1/5 安装 Node.js 20 LTS (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node: $(node -v), npm: $(npm -v)"

echo "==> 2/5 安装 CodeBuddy CLI (@tencent-ai/codebuddy-code)"
npm install -g @tencent-ai/codebuddy-code
CLI_BIN="$(command -v codebuddy || command -v cbc || true)"
if [ -z "$CLI_BIN" ]; then
  echo "ERROR: codebuddy 命令未找到，请检查 npm 全局安装" >&2
  exit 1
fi
CLI_DIR="$(cd "$(dirname "$(readlink -f "$CLI_BIN")")/.." && pwd)"
echo "    CLI_BIN=$CLI_BIN"
echo "    CLI_DIR=$CLI_DIR"

echo "==> 3/5 创建运行用户与目录"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$RUN_USER" -s /bin/bash "$RUN_USER"
mkdir -p "$APP_DIR" "/var/lib/workbuddy2api/accounts"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "/var/lib/workbuddy2api"

echo "==> 4/5 生成 .env"
if [ ! -f "$APP_DIR/.env" ]; then
  API_KEY="wb2api-$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  cat > "$APP_DIR/.env" <<EOF
# 外层 API 鉴权 key（所有请求需 Authorization: Bearer <key>）
WORKBUDDY2API_API_KEY=$API_KEY
WORKBUDDY2API_HOST=127.0.0.1
WORKBUDDY2API_PORT=$PORT
# CodeBuddy CLI（Ubuntu 用 npm 安装的 Linux 版本）
WORKBUDDY2API_CLI_DIR=$CLI_DIR
WORKBUDDY2API_CLI_BIN=$CLI_BIN
# 默认模型与思考档位（可按请求覆盖）
WORKBUDDY2API_MODEL=glm-5.1
WORKBUDDY2API_EFFORT=high
# 账号数据文件
WORKBUDDY2API_ACCOUNTS_FILE=/var/lib/workbuddy2api/accounts.json
# 每账号隔离的运行时 HOME 根目录（账号登录会话存这里）
WORKBUDDY2API_ACCOUNTS_HOME=/var/lib/workbuddy2api/accounts
EOF
  chmod 600 "$APP_DIR/.env"
  echo "    已生成 API key: $API_KEY  (保存好，客户端要用)"
  echo "    .env 路径: $APP_DIR/.env"
else
  echo "    已存在 .env，跳过"
fi

echo "==> 5/5 安装 systemd 服务"
cat > /etc/systemd/system/workbuddy2api.service <<EOF
[Unit]
Description=workbuddy2api - WorkBuddy OpenAI-compatible API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=on-failure
RestartSec=5
# 账号数据 + 服务目录可写
ReadWritePaths=$APP_DIR /var/lib/workbuddy2api
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable workbuddy2api
systemctl restart workbuddy2api || true

echo
echo "======================================================"
echo " 安装完成。"
echo "  - 服务:  systemctl status workbuddy2api"
echo "  - 日志:  journalctl -u workbuddy2api -f"
echo "  - 本机验证:"
echo "      curl http://127.0.0.1:$PORT/v1/health \\"
echo "        -H \"Authorization: Bearer $API_KEY\""
echo "  - 添加账号: 见 README.md 的「账号管理」章节"
echo "======================================================"
