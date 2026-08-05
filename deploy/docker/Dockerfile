# workbuddy2api — 纯 LLM API 镜像
#
# 无 CLI、无 agent 工具：只跑直连引擎（/v1/chat/completions、/v1/messages）。
# 运行时零外部依赖（仅 Node 内置模块），镜像约 200MB（node:20-alpine 基础）。

FROM node:20-alpine

# 时区/编码（中文内容无关，但保持环境干净）
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    WORKBUDDY2API_HOST=0.0.0.0

WORKDIR /app

# 只复制运行所需文件（.dockerignore 排除其余）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY web ./web

# 数据卷：挂载 accounts.json（含 refreshToken 的 manual 账号）
VOLUME ["/data"]
ENV WORKBUDDY2API_ACCOUNTS_FILE=/data/accounts.json

EXPOSE 8787

# 轻量启动检查：确保容器起来后健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/v1/health || exit 1

CMD ["node", "server.js"]
