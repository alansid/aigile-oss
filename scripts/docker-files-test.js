// 驗收測試：Docker 與 docker compose 一行啟動（檔案內容檢查；測試不跑 Docker）
// 實際 build 與啟動在開發時驗過：docker compose up 後 admin 登入、非 root、資料在 volume、重啟資料還在、ADMIN_PASSWORD、健康檢查
// 1. Dockerfile：Node 22 官方映像、非 root 執行、資料在 /data volume、啟動 server.js、有健康檢查
// 2. docker-compose.yml：3000 埠、volume、ADMIN_PASSWORD 等環境變數有設才帶
// 3. .dockerignore 排除 data、.aigile、node_modules、密鑰檔
// 4. README 的快速開始是 Docker，本機第二、Cloudflare 放後面
// 用法：node scripts/docker-files-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
try {
  const df = read('Dockerfile');
  assert.match(df, /^FROM node:22(-alpine|-slim)?\s*$/m, 'Node 22 官方映像');
  assert.match(df, /^USER node\s*$/m, '非 root 執行');
  assert.ok(df.indexOf('USER node') > df.indexOf('chown node:node /data'), '先把 /data 給 node 使用者再切換');
  assert.match(df, /DATA_DIR=\/data/, '資料放 /data');
  assert.match(df, /VOLUME \["\/data"\]/, '/data 是 volume');
  assert.match(df, /EXPOSE 3000/);
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/health/, '健康檢查');
  assert.match(df, /CMD \["node", "server\.js"\]/);
  assert.ok(!df.split(/\r?\n/).some(l => !l.trim().startsWith('#') && /npm (install|ci)/.test(l)), '零相依，不用 npm install');

  const dc = read('docker-compose.yml');
  assert.match(dc, /"\$\{HOST_PORT:-3000\}:3000"/, '3000 埠（可換）');
  assert.match(dc, /aigile-data:\/data/, '資料放 volume');
  assert.match(dc, /^volumes:\s*\n\s+aigile-data:/m, '宣告 volume');
  for (const v of ['ADMIN_PASSWORD', 'ROOM_CODE', 'OPEN_JOIN', 'UPDATE_CHECK']) assert.match(dc, new RegExp(`^\\s+- ${v}\\s*$`, 'm'), `${v} 有設才帶進容器`);
  assert.ok(!dc.split(/\r?\n/).some(l => !l.trim().startsWith('#') && /ADMIN_PASSWORD\s*[:=]\s*\S/.test(l)), 'compose 裡不寫死密碼');

  const di = read('.dockerignore').split(/\r?\n/).map(l => l.trim());
  for (const x of ['data/', '.aigile/', 'node_modules/', '.git/', '.env', '.dev.vars']) assert.ok(di.includes(x), '.dockerignore 排除 ' + x);

  const readme = read('README.md');
  assert.match(readme, /## 快速開始（Docker）[\s\S]*docker compose up -d[\s\S]*## 本機啟動[\s\S]*## 進階：部署到 Cloudflare/, 'README：Docker 第一、本機第二、Cloudflare 放後面');
  console.log('docker-files-test：全部通過');
} catch (e) {
  console.error('docker-files-test 失敗：', e.message);
  process.exitCode = 1;
}
