#!/usr/bin/env bash
# ============================================================
# workbuddy2api 一键部署脚本（Ubuntu + Docker）
#
# 用法（在服务器上执行其一）：
#   curl -fsSL https://raw.githubusercontent.com/Ykrsuao/WB2/main/deploy/docker/deploy.sh | bash
#   或
#   bash deploy/docker/deploy.sh
#
# 自动完成：装 Docker → 拉代码 → 生成 .env → 构建启动 → 打印面板链接和 Key
# ============================================================
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }

# ---------- 1. 安装 Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
else
  say "Docker 已安装: $(docker --version)"
fi

# ---------- 2. 拉取代码 ----------
if [ ! -d WB2 ]; then
  say "克隆代码..."
  git clone https://github.com/Ykrsuao/WB2.git
fi
cd WB2
git pull --ff-only 2>/dev/null || true

# ---------- 3. 生成 .env（已存在则保留） ----------
if [ ! -f .env ]; then
  say "生成 .env..."
  if [ -z "${WORKBUDDY2API_API_KEY:-}" ]; then
    WORKBUDDY2API_API_KEY="$(openssl rand -hex 24)"
  fi
  cat > .env <<EOF
WORKBUDDY2API_API_KEY=${WORKBUDDY2API_API_KEY}
WORKBUDDY2API_MODEL=glm-5.1
WORKBUDDY2API_EFFORT=high
WORKBUDDY2API_LB=round-robin
EOF
  say "已生成 .env（Key 已自动生成）"
else
  say ".env 已存在，保留现有配置"
fi

# ---------- 4. 构建并启动 ----------
say "构建并启动容器（首次约 1-3 分钟）..."
docker compose up -d --build

# ---------- 5. 等待就绪 ----------
say "等待服务就绪..."
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8787/v1/health 2>/dev/null; then break; fi
  sleep 2
done

# ---------- 6. 输出访问信息 ----------
KEY="$(grep WORKBUDDY2API_API_KEY .env | head -1 | cut -d= -f2- | tr -d ' \r')"
IP="$(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || echo '你的服务器IP')"

echo ""
echo "========================================================"
echo "  部署完成！"
echo ""
echo "  Web 面板:  http://${IP}:8787/panel"
echo "  API 地址:  http://${IP}:8787"
echo "  API Key:   ${KEY}"
echo ""
echo "  下一步：浏览器打开上面的面板地址 → 填 Key → 账号页扫码/手机号登录"
echo "  注意：云服务器安全组需放行 8787 端口"
echo "========================================================"
