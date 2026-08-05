# WorkBuddy 5.3.8 逆向分析报告

> 目标：`D:\workbuddy\WorkBuddy.exe`（SHA256 `2087ED674B142BCE377CF6F8692BC4068A141F9C76F50C941811599E9A8692BC`）
> 产出：2026-08-05 · 解包源码位于 `E:\workbuddy2api\_src\`，工具脚本位于 `E:\workbuddy2api\_tools\`

---

## 1. 目标识别

| 项 | 值 |
|---|---|
| 类型 | Electron 桌面应用（Chromium 壳，~195MB） |
| 产品 | WorkBuddy 5.3.8，腾讯 CodeBuddy 系 AI 编程助手 |
| 内部包名 | `@genie/workbuddy-desktop`（homepage: codebuddy.ai） |
| 核心代码位置 | `resources/app.asar`（279MB，含 main/renderer/preload/cli） |
| 配套子应用 | `WorkBuddyAI\WorkBuddyAI.exe`（另一份 Electron，结构相同） |

`WorkBuddy.exe` 本体只是 Electron 启动器；全部业务逻辑在 `app.asar` 内。asar 头部带 3 字节填充，文件偏移为**相对头部结束位置**（基准 4754440），已写入 `_tools/asar_extract.py`。

解包产物：`_src/main/`（主进程 + daemon）、`_src/preload/`、`_src/renderer/`（React + Vite bundle）、`_src/cli/dist/codebuddy.js`（CLI，22MB rspack bundle）。

## 2. 总体架构

```
WorkBuddy.exe (Electron 主进程, main/index.js)
 ├─ renderer（React UI, Vite 打包, VSCode 主题皮肤）
 │    └─ preload/index.js：contextBridge 暴露 workbuddyDesktop.invoke(command,args)
 │       通用 IPC 通道 WORKBUDDY_DESKTOP_INVOKE_CHANNEL（"__bootstrap" 引导）
 ├─ daemon app-server（独立 Node 子进程 daemon-app-server-entry.js --stdio）
 │    └─ 与主进程走 stdio JSON-RPC（createStdioDaemonRpcConnection）
 │       核心 = workbuddy-server（module.app-server.js），包含：
 │        · FileAuthenticationStorage 认证会话（文件 watcher + 原子写）
 │        · CloudAgentProvider 云端会话/对话 REST 客户端
 │        · ConnectorProxyServer 本地 MCP 代理（127.0.0.1 随机端口, Streamable HTTP MCP）
 │        · SidecarManager 拉起/管理 CLI 会话
 │        · ExpertPluginService（/api/v1/plugins/switch 打到本地 CLI）
 └─ sidecar（Windows 命名管道 \\.\pipe\sidecar-control / sidecar-data-*）
      └─ agent-cli（codebuddy, --port N 启动, ELECTRON_RUN_AS_NODE=1）
           · 本地 HTTP gateway：127.0.0.1:随机端口
           · 远端 LLM 调用（OpenAI 兼容 /chat/completions, SSE）
```

**聊天链路**：renderer → (IPC) → daemon → sidecar → CLI（ACP 协议），CLI 再调后端 LLM。
桌面 UI 通过 **ACP（Agent Client Protocol）StreamableHTTP** 连本地 CLI：`http://127.0.0.1:<port>/api/v1/acp`。

## 3. 认证与会话（重点）

### 3.1 协议
- **Keycloak OIDC**：issuer `https://www.codebuddy.cn/auth/realms/copilot`
- accessToken：JWT RS256，60 天（expiresIn 5184000）
- refreshToken：JWT HS512（`typ: Offline`），90 天（refreshExpiresIn 7776000）
- scope：`openid profile offline_access email`；azp: `console`

### 3.2 会话文件（本机已有登录态）
```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info      (主应用)
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info   (AI 子应用)
```
结构（已脱敏）：
```jsonc
{
  "account": { "uid": "c92879d1-…", "uin": "330100030944", "nickname": "13885693108",
               "type": "personal", "phoneNumber": "13885693108", … },
  "auth":   { "accessToken": "eyJ…(1266)", "refreshToken": "eyJ…(700)",
              "expiresIn": 5184000, "refreshExpiresIn": 7776000,
              "domain": "www.codebuddy.cn", "sessionState": "…", … },
  "accounts": [ …同上… ]
}
```
写入逻辑：`FileAuthenticationStorage.store()`（临时文件 + rename 原子写，带 logout marker `*.logout`）。CLI 子进程直接读同一文件或由 daemon 注入。

### 3.3 令牌刷新（后端）
```
POST {endpoint}/v2/plugin/auth/token/refresh
Headers: X-Refresh-Token: <refreshToken>
         X-Auth-Refresh-Source: plugin
         Authorization: Bearer <accessToken>   (enterprise 场景另带 X-Enterprise-Id)
```

### 3.4 请求鉴权头（所有后端请求）
```
Authorization: Bearer <accessToken>
X-User-Id: <account.uid>          # URL-encoded
X-Enterprise-Id / X-Tenant-Id     # 企业账号
X-Domain: <auth.domain>           # 如 www.codebuddy.cn
```
响应统一 envelope：`{ code, msg, requestId, data }`（`NormalResp`，`code!=0` 为业务错误）。

## 4. 后端 API（base = `https://copilot.tencent.com`，staging = `https://staging-copilot.tencent.com`）

### 会话 / 对话（CloudAgentProvider）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/console/as/conversations/{agentId}/session` | 建会话，返回 sandboxId / e2bEndpoint / token |
| GET | `/console/as/conversations/{agentId}` | 取会话状态 |
| POST | `/console/as/conversations/` | 创建会话 |
| POST | `/console/as/conversations/batch-get` | 批量取（body `{ids:[...]}`） |
| POST | `/console/as/conversations/v2` | v2 |
| POST | `/console/as/conversations/{id}/delete` `/archive` `/unarchive` `/pin` | 会话管理 |

### 认证（`prefixPath = /plugin`）
| 方法 | 路径 |
|---|---|
| POST | `/v2/plugin/auth/state?platform=…` |
| GET | `/v2/plugin/auth/token?state=…` |
| POST | `/v2/plugin/auth/token/refresh` |
| GET | `/v2/plugin/login/account?state=…` |
| POST | `/v2/plugin/accounts` |
| GET | `/console/accounts`，`/oauth/start`，`/auth/status`，`/auth/refresh`，`/auth/logout` |

### 其他业务
- 计费/额度：`/billing/meter/get-user-resource`、`/billing/meter/checkin-status`、`/billing/meter/daily-checkin`
- 插件：`/console/as/user/plugins/installed|install|toggle|uninstall`、`/console/as/marketplace/*`
- Connector（GitHub 等 OAuth）：`/console/as/connector/oauth/{name}/start|connect|status|revoke|accesstoken|repos`
- 网盘：`/v2/as/netdisk/upload|shares`、`/v2/as/p/tasks/share/{code}`
- 文件（agent manage）：`/api/v6/open/agent/manage/list_file|create_file|apply_upload|complete_upload|query_task|…`
- 知识库：`/openapi/knowledge_base/v1/get_knowledge_list|search_knowledge|add_knowledge|…`
- 语音：`/agenttool/v1/asr`；预签名：`/console/as/support/presigned_url`；上传：`codebuddy-platform-1258344699.cos.accelerate.myqcloud.com`（腾讯云 COS）

## 5. 本地接口（对做 API 封装最有用）

### 5.1 CLI gateway（`codebuddy --serve`，127.0.0.1 随机端口）
| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET/POST /api/v1/acp` | **免认证**（loopback 豁免） | ACP 会话（SSE + POST，`Acp-Connection-Id` 头） |
| `/api/v1/llm/completions` | **免认证** | OpenAI 兼容 completions，转发远端 |
| `/api/v1/process` `/api/v1/fs` `/api/v1/pty` `/api/v1/sessions` `/api/v1/plugins` `/api/v1/file-version` | `Authorization: Bearer <gatewaySecret>` | 进程/文件/终端/会话/插件 |
| `/internal/*`（hooks、services/invoke、plugin/*） | 免认证 | 内部服务 |

gateway secret：daemon 进程内生成（32B base64url），经 `CODEBUDDY_GATEWAY_PASSWORD` + `CODEBUDDY_GATEWAY_AUTH=password` 注入 CLI 环境。ACP 主通道与 `/internal/*` 不需要 secret。

### 5.2 CLI 启动环境（cli-process-env.js）
```
ELECTRON_RUN_AS_NODE=1
SERVER__PORT / SERVER__HOST=127.0.0.1
CODEBUDDY_SIDECAR_READY_SOCKET / _TOKEN / _SESSION_ID
CODEBUDDY_GATEWAY_AUTH=password / CODEBUDDY_GATEWAY_PASSWORD=<secret>
ACC_PRODUCT_CONFIG_V3 / ACC_PRODUCT_CONFIG_PATH  → product.json（endpoint 等）
```

## 6. 原生模块（app.asar.unpacked）

| 模块 | 作用 |
|---|---|
| `@tencent/qimei-node`（qimei.dll） | 腾讯设备指纹 `qimei36`（风控），经 `WORKBUDDY_QIMEI_APP_KEY` 初始化 |
| `@lydell/node-pty-win32-x64` | 伪终端（CLI 会话） |
| `better-sqlite3` | 本地库 `~/.workbuddy/workbuddy.db`（会话索引等） |
| `koffi` | FFI 绑定 |
| `wechat-copydata-decoder` | 微信复制数据解码 |
| `ripgrep`（rg.exe） | 代码搜索 |
| `sandbox/5.3.3/` | 沙箱运行时 |

## 7. 对 workbuddy2api 的三条可行路线

1. **复用会话文件直连后端**（最轻）：读 `workbuddy-desktop.info` 取 accessToken → 按需调 `/v2/plugin/auth/token/refresh` 续期 → 直接调 `/console/as/conversations/*`。注意用户态请求头 `X-User-Id` 必带。
2. **本地 ACP/LLM 端点**（能力最全）：启动 `codebuddy --serve --port N`，用免认证的 `/api/v1/acp` 或 `/api/v1/llm/completions` 拿完整 agent 能力（工具、sandbox、插件）。**已实现并验证**：见 `server.js`（workbuddy2api 服务）。
3. **走 daemon RPC**：spawn `daemon-app-server-entry.js --stdio`，用 stdio JSON-RPC 复用全部能力（侵入式，复杂度最高）。

> 实现状态（2026-08-05）：路线 2 已落地为 `E:\workbuddy2api` 下的零依赖 Node 服务
> （`node server.js`，默认 `http://127.0.0.1:8787`），详见 `README.md`。
> 实测要点：CLI 网关所有请求需 `X-CodeBuddy-Request: 1` 头；agent 执行 = `POST /api/v1/runs`
> （Gateway Protocol 消息，含 `sessionId` 续上下文）+ `GET /api/v1/runs/{id}/stream`（SSE）；
> 完整 96 端点 OpenAPI 规范在 `codebuddy-api-openapi.json`。

## 8. 关键文件速查
```
_src/main/index.js                                  # 主进程入口（窗口/daemon 管理）
_src/main/initialize.js                             # 全部 REST 客户端（CloudAgentProvider 等）
_src/main/module.app-server.js                      # workbuddy-server：会话/插件/Connector MCP
_src/main/file-authentication-storage.js            # 认证会话文件读写（原子写 + watcher）
_src/main/workbuddy-auth-product-coordinator.js     # 认证协调 + gateway secret
_src/main/runtime-http.js                           # 请求封装（endpoint + 鉴权头 + envelope 解析）
_src/main/cli-process-env.js                        # CLI 环境变量构建
_src/main/sidecar-entry.js                          # sidecar：拉 CLI、ACP 端点、命名管道
_src/main/qimei-helper.js                           # 设备指纹子进程
_src/cli/dist/codebuddy.js                          # CLI（agent runtime + 本地 gateway）
_src/preload/index.js                               # contextBridge 桥
_tools/asar_extract.py / asar_peek.py               # asar 解包/预览（已处理偏移）
```
