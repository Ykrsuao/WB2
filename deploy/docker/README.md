# Docker 部署（纯 LLM API）

把 workbuddy2api 打包成单容器运行。**容器内无 CLI、无 agent 工具**——对话/模型/
工具调用全部走直连引擎，与本地运行行为一致。

## 文件清单

| 文件 | 说明 |
|---|---|
| `Dockerfile` | node:20-alpine，只复制运行所需（server.js + lib + web） |
| `docker-compose.yml` | 端口、环境变量、数据卷编排 |
| `export-accounts.js` | 在 Windows/本机运行：导出 Docker 可用的账号文件 |
| `.dockerignore` | 构建上下文排除项（源码、密钥、测试脚本） |

## 快速开始

```bash
# 1. 准备账号文件（在装有 WorkBuddy 的 Windows 机器上执行）
node deploy/docker/export-accounts.js --out data/accounts.json

# 2. 配置环境变量（API Key 必填）
#    复制一份 .env 示例：
cat > .env <<'EOF'
WORKBUDDY2API_API_KEY=换成你的密钥
WORKBUDDY2API_MODEL=glm-5.1
WORKBUDDY2API_EFFORT=high
WORKBUDDY2API_LB=round-robin
EOF

# 3. 构建并启动
docker compose up -d --build

# 4. 验证
curl http://127.0.0.1:8787/v1/health \
  -H "Authorization: Bearer 换成你的密钥"
# → {"ok":true,"engine":"direct","cli":{},"accounts":2,...}
```

## 账号管理

容器内没有 WorkBuddy 桌面会话，因此**必须使用 manual 账号**（携带 refreshToken，
服务自动经认证 API 刷新 accessToken）。

三种获取方式：

1. **从本机导出（推荐）**：`node deploy/docker/export-accounts.js --out data/accounts.json`
   —— 自动把现有 manual 账号原样导出、桌面账号从会话文件提取 refreshToken 转成 manual。

2. **手动编写** `data/accounts.json`：
   ```json
   { "accounts": [ { "id": "myacct", "name": "我的账号",
                     "source": "manual", "refreshToken": "<从 CodeBuddy 会话 .info 提取>" } ] }
   ```

3. **面板添加**：登录 Web 面板 → 账号页 → "添加账号" → 粘贴 refreshToken。

> ⚠️ 容器内 Web 面板的"扫码/手机号登录"不可用（依赖 CLI 二进制，纯 API 镜像不含）。
> 需要扫码登录请在 Windows 本机完成后再导出账号。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY2API_API_KEY` | 空 | **必填**，客户端 Bearer 鉴权 |
| `WORKBUDDY2API_MODEL` | `glm-5.1` | 默认模型 |
| `WORKBUDDY2API_EFFORT` | `high` | 默认思考强度（minimal~max） |
| `WORKBUDDY2API_SYSTEM_PROMPT` | 空 | 替换系统提示词（去掉品牌身份） |
| `WORKBUDDY2API_LB` | `round-robin` | `first` / `round-robin` / `least-loaded` |
| `WORKBUDDY2API_ENDPOINT` | `https://copilot.tencent.com` | 后端直连地址 |
| `WORKBUDDY2API_ACCOUNTS_FILE` | `/data/accounts.json` | 账号文件（容器内固定，勿改） |

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

- **账号文件**：`data/accounts.json`（挂载卷，容器重建不丢失）
- **系统设置**：通过 `.env` 管理（面板在容器内改的设置不持久化）
- **升级**：`git pull && docker compose up -d --build`

## 安全

- 默认只映射 `8787` 端口到宿主机；需要公网访问请加反向代理 + TLS（如
  `docker compose` 前套 Caddy/nginx）
- `data/accounts.json` 含 refreshToken，注意文件权限（`chmod 600`）
- API Key 是唯一鉴权手段，务必设置强随机值

## 常见问题

**健康检查返回 401？** `/v1/health` 也要求鉴权，curl 记得带 `Authorization` 头。

**账户额度看不到？** `GET /v1/billing` 需要账号有有效 token，检查账号 refreshToken 是否过期。

**与 Ubuntu 裸机部署的区别？** `deploy/ubuntu/` 是裸机 + systemd 方案（会安装 Linux
版 CLI 以支持扫码登录和 agent 端点）；Docker 方案更轻、无 CLI，适合纯对话/工具调用场景。
