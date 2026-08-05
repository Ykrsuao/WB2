# workbuddy2api

把腾讯 WorkBuddy（CodeBuddy 桌面版）的账号额度包装成本地 **纯 LLM API**（OpenAI + Anthropic 兼容）。

**核心：不要 CLI、不要 agent 工具、不要文件写入——只要模型。**

`/v1/chat/completions` 与 `/v1/messages` 走**直连引擎**：直接用账号 token 请求
`POST https://copilot.tencent.com/v2/chat/completions`，全程只有一个 HTTP 请求，
**不 spawn 任何 CodeBuddy/agent-cli 子进程**，没有工具调用、没有文件系统访问。

> agent 型端点（`/v1/agent/runs`）保留但默认不启用：只有显式调用它们时才会拉起 CLI。
> 日常 LLM 对话完全不经过 CLI。

## 快速开始

```powershell
# 1. 启动服务（不拉起任何 CLI）
node server.js

# 2. 另开终端调用（需要 API Key，见 .env 的 WORKBUDDY2API_API_KEY）
curl http://127.0.0.1:8787/v1/health -H "Authorization: Bearer <你的KEY>"
```

## OpenAI 兼容对话（/v1/chat/completions）

非流式：

```powershell
curl http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer <你的KEY>" -H "Content-Type: application/json" `
  -d '{"model":"glm-5.1","messages":[{"role":"user","content":"用一句话介绍你自己"}]}'
```

流式 + 思考：

```powershell
curl -N http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer <你的KEY>" -H "Content-Type: application/json" `
  -d '{"model":"glm-5.1","stream":true,"thinking":"high","messages":[{"role":"user","content":"9.11 和 9.9 哪个大？"}]}'
```

- **思考过程**：流式 `delta.reasoning_content`，非流式 `message.reasoning_content`
- **思考档位**：请求体 `thinking`（`true`/`low`/`medium`/`high`/`max`/`disabled`），不传则用
  `WORKBUDDY2API_EFFORT`（.env 默认 `high`）
- **按请求切模型**：`model` 支持 `glm-5.1`、`kimi-k2.5` 等（`GET /v1/models` 全列表）
- **多轮**：客户端自己带历史 `messages` 即可，无需 session 管理

### 工具调用（function calling）

支持 OpenAI 风格工具调用——模型负责**选择工具并生成参数**，执行在客户端
（Cherry Studio、NextChat 等自己执行工具，再把结果以 `role:"tool"` 回传）：

```jsonc
// 第一轮：声明工具，模型返回 tool_calls
{
  "model": "glm-5.1",
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "查询指定城市的当前天气",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  }],
  "messages": [{ "role": "user", "content": "查询北京今天的天气。" }]
}
// → finish_reason: "tool_calls"，message.tool_calls = [{id, function:{name:"get_weather", arguments:"{\"city\":\"北京\"}"}}]

// 第二轮：带上工具执行结果，模型给出最终回答
{
  "messages": [
    { "role": "user", "content": "查询北京今天的天气。" },
    { "role": "assistant", "content": "", "tool_calls": [{ "id": "call_x1", "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\": \"北京\"}" } }] },
    { "role": "tool", "tool_call_id": "call_x1", "content": "{\"temperature\":32,\"condition\":\"晴\"}" }
  ]
}
// → 正常文本回答
```

流式同样支持：`delta.tool_calls` 分片透传（`arguments` 按 fragment 拼接）。
`tool_choice` 可传 `"auto"` / `"required"` / `{type:"function", function:{name}}`。

## Claude Code / Anthropic 客户端接入（/v1/messages）

提供 Anthropic Messages API 格式，Claude Code、Cline、Roo Code 等可直接对接：

```bash
# 环境变量（Claude Code）
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="<你的KEY>"
export ANTHROPIC_MODEL="glm-5.1"
```

```powershell
# 或直接调用
curl -N http://127.0.0.1:8787/v1/messages `
  -H "Authorization: Bearer <你的KEY>" -H "Content-Type: application/json" `
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1000,
       "system":"You are a concise assistant.",
       "messages":[{"role":"user","content":"用一句话介绍你自己"}],"stream":true}'
```

- `model` 里的 `claude-*` 会自动映射到默认模型（`WORKBUDDY2API_MODEL`，.env 默认 `glm-5.1`）
- 流式返回标准 Anthropic SSE：`message_start` / `content_block_delta`（含 `thinking_delta` 思考）/
  `message_delta` / `message_stop`，Claude Code 可直接消费
- **工具调用（tool use）**：`tools` 用 Anthropic 格式（`{name, description, input_schema}`）；
  模型返回 `tool_use` 内容块（流式为 `content_block_start` + `input_json_delta`），
  客户端执行后以 `tool_result` 块回传，`stop_reason` 为 `tool_use`。Claude Code
  的 MCP 工具 / Bash / Read 等工具可直接使用

## 端点一览

| 端点 | 说明 |
|---|---|
| `GET /v1/health` | 服务状态（`engine:"direct"`、CLI 实例数、账号数、登录态） |
| `GET /v1/models` | 模型列表（44 个） |
| `POST /v1/chat/completions` | OpenAI 兼容对话（流式/非流式/思考） |
| `POST /v1/messages` | Anthropic 兼容对话（Claude Code 等） |
| `GET /v1/billing` | 账号积分/套餐用量 |
| `GET /v1/checkin` | 每日签到状态（各账号 + 自动调度） |
| `POST /v1/checkin` | 立即对所有账号签到 |
| `POST /v1/checkin/{id}` | 立即对指定账号签到 |
| `GET /v1/accounts` / `POST` / `DELETE /v1/accounts/:id` | 账号管理 |
| `GET/POST /v1/config` | 系统设置（提示词、负载均衡等） |
| `POST /v1/auth/login` + `GET /v1/auth/login/:id` | Web 面板扫码/手机号登录 |
| `POST /v1/agent/runs` | **（可选）** 原生 agent 执行——只有调用它才拉 CLI |
| `GET /v1/agent/runs/{id}/stream` / `POST .../cancel` | agent 流式 / 取消 |
| `/panel` | Web 管理面板（浅色、顶部标签页：对话/账号/积分/设置） |

## 环境变量（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY2API_PORT` | `8787` | 对外端口 |
| `WORKBUDDY2API_HOST` | `127.0.0.1` | 绑定地址 |
| `WORKBUDDY2API_API_KEY` | 空 | 外层 API 鉴权（`Authorization: Bearer <key>`） |
| `WORKBUDDY2API_MODEL` | 无 | 默认模型（如 `glm-5.1`） |
| `WORKBUDDY2API_EFFORT` | 无 | 默认思考强度（`minimal`~`max`） |
| `WORKBUDDY2API_SYSTEM_PROMPT` | 无 | 替换系统提示词（见下） |
| `WORKBUDDY2API_ENDPOINT` | `https://copilot.tencent.com` | 后端直连地址 |
| `WORKBUDDY2API_LB` | `first` | 负载均衡策略（`first`/`round-robin`/`least-loaded`） |
| `WORKBUDDY2API_CHECKIN` | `1` | 每日自动签到开关（`0` 关闭） |
| `WORKBUDDY2API_CLI_DIR` | WorkBuddy 内置 | agent-cli 目录（仅 agent 端点用） |

## 每日自动签到

服务内置定时任务，每天对每个启用账号自动签到一次（每 30 分钟检查，服务重启
当天自动补签，已签到自动跳过）：

- 签到 API 逆向自桌面 App：`POST /v2/billing/meter/daily-checkin`（每账号每日 100 积分）
- `GET /v1/checkin` 查看各账号签到状态（连续天数/当日积分）
- `POST /v1/checkin` 或 `POST /v1/checkin/{accountId}` 手动触发
- Web 面板「积分」页有签到卡片：状态展示 + 一键签到按钮
- 关闭自动签到：`WORKBUDDY2API_CHECKIN=0`

## 多账号 + 负载均衡

- 注册表 `accounts.json`：`main`（桌面自动登录）+ 手动导入的账号（微信扫码/手机号/refreshToken）
- 请求头 `X-Account-Id: <id>` 显式选账号；不指定按负载均衡策略分发
- 多轮会话按 `session_id` 粘性绑定账号（12 小时），避免上下文串号
- `round-robin` 轮流摊薄额度；`least-loaded` 选在途请求最少的账号

## 自定义系统提示词（去掉 CodeBuddy 内置提示词）

直连引擎是裸模型端点，本身不带 CodeBuddy 品牌提示词。可通过环境变量注入你自己的
中性系统提示词（仅在客户端没传 `system` 消息时生效）：

```ini
# .env
WORKBUDDY2API_SYSTEM_PROMPT=You are a helpful AI assistant. When asked who you are, answer "I am an AI assistant." Never mention CodeBuddy/Tencent.
```

已实测：问"你是谁"回复"我是一个AI助手"，不再自称 CodeBuddy。

## 安全说明

- 服务默认绑定 `127.0.0.1`；设置了 `WORKBUDDY2API_API_KEY` 后所有端点需 Bearer 鉴权
- 不要直接暴露公网；远程访问请加反向代理 + TLS
- `accounts.json` 含 token，注意文件权限

## 依赖

零外部依赖，仅 Node.js 内置模块（>= 18）。

## 服务器部署

- **Docker（推荐，纯 API 单容器）**：见 [`deploy/docker/README.md`](deploy/docker/README.md)
  —— `docker compose up -d --build` 即跑；账号用 `deploy/docker/export-accounts.js` 从本机导出。
  镜像无 CLI，仅直连引擎。
- **Ubuntu 裸机**（systemd + nginx TLS + 扫码登录）：见
  [`deploy/ubuntu/README.md`](deploy/ubuntu/README.md)。
