# workbuddy2api — Ubuntu 服务器部署（多账号）

把 WorkBuddy/CodeBuddy 能力部署到 Ubuntu 服务器，支持**多账号隔离**。
每个账号跑一个独立的 agent-cli 进程，凭据互相隔离（`CODEBUDDY_AUTH_TOKEN` + 独立 HOME）。

## 架构

```
nginx (TLS, 可选) ──► workbuddy2api (systemd, 127.0.0.1:8787)
                        ├── 账号注册表 accounts.json（存 refresh token, chmod 600）
                        └── 每账号一个 agent-cli 实例（独立 HOME + 独立 token）
```

## 一、安装

```bash
# 拷贝本目录到服务器
rsync -av E:\workbuddy2api\ server:/opt/workbuddy2api/   # Windows→服务器（或用 scp）
# 在服务器上：
sudo bash /opt/workbuddy2api/deploy/ubuntu/install.sh
```

安装脚本会：装 Node 20 → `npm i -g @tencent-ai/codebuddy-code` → 建 `workbuddy` 用户 →
生成 `.env`（含随机 API key）→ 装 systemd 服务。

```bash
systemctl status workbuddy2api
journalctl -u workbuddy2api -f
```

## 二、添加账号（每个账号一次）

```bash
# 1) 在账号 A 的隔离 HOME 里登录一次（会打印登录链接/二维码，浏览器或微信扫码）
sudo -u workbuddy bash -c \
  'mkdir -p /var/lib/workbuddy2api/accounts/acct1 && \
   HOME=/var/lib/workbuddy2api/accounts/acct1 codebuddy --print "hi"'

# 2) 导入账号
sudo bash /opt/workbuddy2api/deploy/ubuntu/import-account.sh acct1
```

重复 `acct2`、`acct3` … 即可。每个账号一个 `X-Account-Id`。

也可以用 Web 面板添加：浏览器打开 `http://<服务器>:8787/panel`（或经 nginx TLS），
登录后「添加账号」填 ID / refresh token / 隔离 HOME 即可。

## 三、负载均衡

`.env` 加 `WORKBUDDY2API_LB=round-robin`（或 `least-loaded`）。不指定账号的请求会
按策略分发；客户端显式 `X-Account-Id` 永远优先。

## 四、客户端使用

```bash
# 指定账号
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "X-Account-Id: acct1" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'

# 不指定则用第一个启用的账号
```

| 用途 | 方式 |
|---|---|
| 选账号 | 请求头 `X-Account-Id: <id>`，或请求体 `account: <id>` |
| 账号列表 | `GET /v1/accounts` |
| 添加账号 | `POST /v1/accounts`（body: `{id, name, source:"manual", refreshToken, home?}`） |
| 删除账号 | `DELETE /v1/accounts/<id>` |

## 四、公网访问（强烈建议 TLS）

服务默认只监听 `127.0.0.1`。要公网访问，用 nginx 反代 + TLS（示例）：

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;          # 流式必须关
        proxy_read_timeout 3600s;     # 长对话
        client_max_body_size 50m;
    }
}
```

```bash
# 证书：sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d api.example.com
```

## 五、安全红线

- **绝对不要裸暴露 8787 到公网**。这套 API = 文件系统 + 进程执行 + 终端 + 你账号的 LLM 额度。
- 公网必须：TLS + 强 API key + 限流（nginx `limit_req`）。
- `accounts.json` 含 refresh token：确保 `chmod 600`、仅服务用户可读。
- 如只用对话，建议在 nginx 层只放行 `/v1/chat/completions`、`/v1/models`、`/v1/health`，
  拒绝 `/cli/*`（fs/process/pty 等 90 个危险端点）。
- 默认 CLI 以 `--dangerously-skip-permissions` 运行；如需审批模式：
  `.env` 加 `WORKBUDDY2API_CLI_ARGS=--permission-mode default`。

## 六、常见问题

| 问题 | 处理 |
|---|---|
| 账号显示未认证 | 重新 `codebuddy --print "hi"` 登录后重跑 import-account.sh |
| refresh token 过期（90 天） | 同上，重新登录导入 |
| 端口占用 | `.env` 改 `WORKBUDDY2API_PORT` |
| 想用别的模型 | `.env` 改 `WORKBUDDY2API_MODEL` / `WORKBUDDY2API_EFFORT`，或按请求 `model`/`thinking` 字段 |
