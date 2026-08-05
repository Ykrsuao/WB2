# Docker 部署（纯 LLM API）

把 workbuddy2api 打包成单容器运行。**对话/模型/工具调用全部走直连引擎**，与本地
运行行为一致；镜像内附带 CodeBuddy CLI（`@tencent-ai/codebuddy-code`）**仅供
Web 面板的扫码/手机号登录流程使用**，日常对话不会 spawn 任何 CLI 进程。

## 文件清单

| 文件 | 说明 |
|---|---|
| `Dockerfile` | node:20-slim + CodeBuddy CLI（登录用）；只复制运行所需 |
| `docker-compose.yml` | 端口、环境变量、数据卷编排 |
| `entrypoint.sh` | 启动时自动解析 CLI 路径（bin 可能是 `codebuddy` 或 `cbc`） |
| `export-accounts.js` | 可选：在 Windows 上导出账号文件（不想面板登录时用） |
| `.dockerignore` | 构建上下文排除项（源码、密钥、测试脚本） |

## 快速开始

```bash
# 1. 配置环境变量（API Key 必填）
cat > .env <<'EOF'
WORKBUDDY2API_API_KEY=换成你的密钥
WORKBUDDY2API_MODEL=glm-5.1
WORKBUDDY2API_EFFORT=high
WORKBUDDY2API_LB=round-robin
EOF

# 2. 构建并启动
docker compose up -d --build

# 3. 验证
curl http://127.0.0.1:8787/v1/health \
  -H "Authorization: Bearer 换成你的密钥"
# → {"ok":true,"engine":"direct","cli":{},"accounts":2,...}
```

启动日志应看到：`[entrypoint] CodeBuddy CLI: ... — 用于面板登录`。

## 账号管理（两种方式，任选）

### 方式 A：Web 面板扫码/手机号登录（推荐，无需传文件）

1. 浏览器打开 `http://<服务器IP>:8787/panel`，填 API Key 进入
2. 账号页 →「登录新账号」→ 微信扫码 或 手机号登录
3. 登录完成自动注册账号，持久化到 `data/accounts.json`（挂载卷）

> 登录流程在容器内用隔离 HOME 短暂拉起 CLI，完成即关闭；对话请求不受影响。

### 方式 B：从本机导出账号

```bash
# 在装有 WorkBuddy 的 Windows 机器上执行
node deploy/docker/export-accounts.js --out data/accounts.json
# 把 data/accounts.json 传到服务器，与 compose 同目录的 data/ 下
```

### 方式 C：手动添加

登录面板 → 账号页 →「添加账号」→ 粘贴 refreshToken。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY2API_API_KEY` | 空 | **必填**，客户端 Bearer 鉴权 |
| `WORKBUDDY2API_MODEL` | `glm-5.1` | 默认模型 |
| `WORKBUDDY2API_EFFORT` | `high` | 默认思考强度（minimal~max） |
| `WORKBUDDY2API_LB` | `round-robin` | `first` / `round-robin` / `least-loaded` |
| `WORKBUDDY2API_ENDPOINT` | `https://copilot.tencent.com` | 后端直连地址 |
| `WORKBUDDY2API_ACCOUNTS_FILE` | `/data/accounts.json` | 账号文件（容器内固定，勿改） |

CLI 路径由 `entrypoint.sh` 自动解析（`WORKBUDDY2API_CLI_DIR/BIN`），一般无需手动设置。

## 客户端接入

```
Base URL:  http://<服务器IP>:8787          (OpenAI: /v1/chat/completions)
Key:       <WORKBUDDY2API_API_KEY>
Anthropic: http://<服务器IP>:8787/v1/messages   (Claude Code 用)
```

Claude Code：
```bash
export ANTHROPIC_BASE_URL="http://<服务器IP>:8787"
export ANTHROPIC_AUTH_TOKEN="<你的KEY>"
export ANTHROPIC_MODEL="glm-5.1"
```

## 数据与升级

- **账号文件**：`data/accounts.json`（挂载卷，容器重建不丢失，面板登录的账号也在里面）
- **系统设置**：通过 `.env` 管理（面板在容器内改的设置不持久化）
- **升级**：`git pull && docker compose up -d --build`

## 安全

- 默认只映射 `8787` 端口到宿主机；需要公网访问请加反向代理 + TLS（如
  `docker compose` 前套 Caddy/nginx）
- `data/accounts.json` 含 refreshToken，注意文件权限（`chmod 600`）
- API Key 是唯一鉴权手段，务必设置强随机值

## 常见问题

**健康检查返回 401？** `/v1/health` 也要求鉴权，curl 记得带 `Authorization` 头。

**面板登录失败？** 检查启动日志有没有 `未找到 CodeBuddy CLI` 警告；确认容器能访问
`registry.npmjs.org`（构建时已安装 CLI）。

**账户额度看不到？** `GET /v1/billing` 需要账号有有效 token，检查账号 refreshToken 是否过期。

**与 Ubuntu 裸机部署的区别？** `deploy/ubuntu/` 是裸机 + systemd 方案；Docker 方案
更轻、升级方便，同样支持面板扫码登录。
