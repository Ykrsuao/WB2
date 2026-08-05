# workbuddy2api — 纯 LLM API 镜像（含登录辅助 CLI）
#
# 运行时对话/模型/工具调用全部走直连引擎（/v1/chat/completions、/v1/messages），
# 不 spawn CLI。镜像内附带 CodeBuddy CLI（@tencent-ai/codebuddy-code）仅供
# Web 面板的扫码/手机号登录流程使用（LoginManager 在隔离 HOME 中短暂拉起）。
# 零外部依赖（仅 Node 内置模块），基础镜像 node:20-slim（glibc，兼容 CLI 原生二进制）。

FROM node:20-slim

# 时区/编码（中文内容无关，但保持环境干净）
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    WORKBUDDY2API_HOST=0.0.0.0

WORKDIR /app

# 安装 CodeBuddy CLI（仅用于面板登录；对话走直连引擎）
RUN npm install -g @tencent-ai/codebuddy-code --no-audit --no-fund

# 只复制运行所需文件（.dockerignore 排除其余）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY web ./web
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 数据卷：挂载 accounts.json（面板登录的账号也会持久化到这里）
VOLUME ["/data"]
ENV WORKBUDDY2API_ACCOUNTS_FILE=/data/accounts.json

EXPOSE 8787

# 轻量启动检查：确保容器起来后健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/v1/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
