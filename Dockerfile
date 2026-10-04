# ---- 构建阶段 ----
FROM node:24-slim AS builder
WORKDIR /app

# 启用 pnpm（Node 24 镜像自带 corepack）
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY . .
# 构建期不需要真实数据库/密钥，给占位值避免报错
ENV DATABASE_PATH=/tmp/build-placeholder.db \
    JWT_SECRET=build-time-placeholder-not-used-at-runtime \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- 运行阶段 ----
FROM node:24-slim AS runner
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/wms.db

# 只带运行必需的文件
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

# 数据目录作为挂载点（务必挂持久卷，否则重启数据丢失）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3100

# 首次启动自动建表；seed 需手动执行一次以创建管理员
CMD ["sh", "-c", "node scripts/db-init.mjs && node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}"]
