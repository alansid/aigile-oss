# Aigile-Switch：本機版（Node + SQLite，或設 DATABASE_URL 改用 Postgres）的容器。
# 用法：docker compose up -d，開 http://localhost:3000（帳號 admin、密碼 ADMIN_PASSWORD，沒設＝admin；第一次登入要先改）
# 連 Postgres：docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d（見 README「用 Postgres」）
FROM node:22-alpine

WORKDIR /app
# 照 package-lock 安裝 PDF 抽字套件與選用的 Postgres 驅動程式
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .

# 資料（SQLite 與專案文件）放 /data，用 volume 保存；用內建的 node 使用者執行，不用 root
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
