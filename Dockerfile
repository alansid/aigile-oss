# Aigile-Switch：本機版（Node + SQLite）的容器。零相依，不用 npm install。
# 用法：docker compose up -d，開 http://localhost:3000（帳號 admin、密碼 ADMIN_PASSWORD，沒設＝admin；第一次登入要先改）
FROM node:22-alpine

WORKDIR /app
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
