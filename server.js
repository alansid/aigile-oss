// 本機啟動：node server.js（零相依，Node 22.13+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/core.js';
import { openNodeDb } from './src/db-node.js';
import { PAGE_HEADERS } from './src/security-headers.js';
import { dbStorage } from './src/storage-db.js';
import { dirStorage } from './src/storage-dir.js'; // 本機的專案文件區（不需要 R2）
import { scriptHashes } from './scripts/script-hashes.mjs';
import { createLiveHub } from './src/live.js'; // 內建即時通道（不用 Supabase）

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

let db;
try {
  db = openNodeDb(path.join(DATA_DIR, 'switch.db'), { legacyProjects: process.env.AIGILE_TEST_PROJECTS === '1' }); // 測試才先建兩個專案
} catch (e) {
  // 資料庫升級失敗（或資料庫比程式新）：印出原因就停，不帶著壞資料啟動
  console.error(e.name === 'MigrationError' ? `\n${e.message}\n` : e);
  process.exit(1);
}
// 內建即時通道：LIVE=0 關掉（網頁與 watcher 會退回輪詢）
const live = process.env.LIVE === '0' ? null : createLiveHub({ maxConnections: Number(process.env.LIVE_MAX_CONNECTIONS) || 500 });
const handle = createApp({
  db,
  live,
  storage: dbStorage(db),
  docStorage: dirStorage(path.join(DATA_DIR, 'docs')),
  docText: fs.readFileSync(path.join(ROOT, 'docs', 'ai-integration.md'), 'utf8'),
  flowsText: fs.readFileSync(path.join(ROOT, 'docs', 'flows.md'), 'utf8'),
  scriptHashes: scriptHashes(), // 從 public/ 現算
  releases: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'releases.json'), 'utf8')); } catch { return null; } })(), // npm run releases 產生
  config: {
    roomCode: process.env.ROOM_CODE,
    openJoin: process.env.OPEN_JOIN, // 沒設＝開放自己註冊；設 0 才關（跟 Workers 一樣）
    defaultAdmin: process.env.AIGILE_TEST_PROJECTS === '1' ? '0' : '1', // 新站自動建預設管理員（測試模式不建，照舊第一位註冊＝管理員）
    adminPassword: process.env.ADMIN_PASSWORD,
    joinLimitPerHour: process.env.JOIN_LIMIT_PER_HOUR, // 每個 IP 每小時最多自己註冊幾個帳號（預設 20）
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY, turnstileSecret: process.env.TURNSTILE_SECRET, // 人機驗證：兩個都設才啟用
    turnstileAfterFails: process.env.TURNSTILE_AFTER_FAILS, turnstileVerifyUrl: process.env.TURNSTILE_VERIFY_URL, // 驗證網址只給測試換成假的
    authFailLimit: process.env.AUTH_FAIL_LIMIT,
    rateLimitPerMin: process.env.RATE_LIMIT_PER_MIN, // 只給本機測試用；正式環境固定每分鐘 120
    aiTokenTtlHours: process.env.AI_TOKEN_TTL_HOURS,
    humanTokenTtlHours: process.env.HUMAN_TOKEN_TTL_HOURS,
    fileTtlHours: process.env.FILE_TTL_HOURS,
    fileMaxTotalMb: process.env.FILE_MAX_TOTAL_MB,
    docMaxTotalMb: process.env.DOC_MAX_TOTAL_MB,
    staleMinutes: process.env.STALE_MINUTES,
    unansweredMinutes: process.env.UNANSWERED_MINUTES,
    teamCacheMs: process.env.TEAM_CACHE_MS,
    tokenWarnHours: process.env.TOKEN_WARN_HOURS,
    cardStaleHours: process.env.CARD_STALE_HOURS,
    archiveEveryMs: process.env.ARCHIVE_EVERY_MS,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    supabaseTopic: process.env.SUPABASE_TOPIC,
    updateCheck: process.env.UPDATE_CHECK ?? (process.env.AIGILE_TEST_PROJECTS === '1' ? '0' : undefined), // 管理頁查新版本；設 0 關掉（測試模式不連 GitHub）
  },
});

// 每 10 分鐘：清除過期文件、Token 到期提醒
const scheduled = () => handle.runScheduled().catch(e => console.error('scheduled', e));
scheduled();
setInterval(scheduled, 10 * 60_000).unref();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname, origin) {
  let rel;
  try { rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); } catch { rel = '/'; }
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file.startsWith(PUBLIC_DIR + path.sep) && !path.extname(file) && !fs.existsSync(file)) file = path.join(PUBLIC_DIR, 'index.html'); // /p/平台/訊息（起 /p/<代號>/messages） 等網頁路徑
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (path.extname(file) === '.html') { // 跟正式環境一樣：換上群組名與連結預覽
    return handle.pageHtml(fs.readFileSync(file, 'utf8'), origin).then(html => { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...PAGE_HEADERS }); res.end(html); });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...PAGE_HEADERS });
  fs.createReadStream(file).pipe(res);
}

// 公開部署：
// - TRUST_PROXY=1：前面有反向代理（nginx、Caddy、Cloudflare Tunnel…）時才信 X-Forwarded-For／-Proto；沒設就用連線本身的位址（用戶端送的 IP 標頭不算數）
// - APP_URL：對外網址（例 https://team.example.com）；有設就用它組邀請、接入連結，不看 Host 標頭
// - 請求內容超過 MAX_BODY_MB（預設 26，備份匯入的單一文件上限 25 MB）就 413，不整段讀進記憶體
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const APP_ORIGIN = (() => { try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : null; } catch { console.error('APP_URL 不是合法網址，先不用它'); return null; } })();
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 26) * 1048576;
const firstOf = v => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
const sendJson = (res, status, code, message) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { code, message } })); };

http.createServer(async (req, res) => {
  try {
    const proto = TRUST_PROXY && /^https?$/.test(firstOf(req.headers['x-forwarded-proto'])) ? firstOf(req.headers['x-forwarded-proto']) : 'http';
    let url;
    try { url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`); } catch { return sendJson(res, 400, 'BAD_REQUEST', '網址不合法'); }
    const base = APP_ORIGIN || url.origin;
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') return await serveStatic(res, url.pathname, base);

    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) { req.resume(); return sendJson(res, 413, 'PAYLOAD_TOO_LARGE', '請求內容過大'); }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return sendJson(res, 413, 'PAYLOAD_TOO_LARGE', '請求內容過大'); }
      chunks.push(c);
    }
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    // 使用者 IP：一律由這裡決定（登入失敗次數、註冊次數、人機驗證都看它）
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const ip = (TRUST_PROXY && (firstOf(req.headers['cf-connecting-ip']) || firstOf(req.headers['x-forwarded-for']))) || req.socket.remoteAddress || 'unknown';
    headers.delete('x-forwarded-for');
    headers.set('cf-connecting-ip', ip);
    const abort = new AbortController();
    res.on('close', () => abort.abort()); // 用戶端斷線：即時通道收掉這條連線
    const request = new Request(url, { method: req.method, headers, body, signal: abort.signal });
    const response = await handle(request, base);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if ((response.headers.get('content-type') || '').startsWith('text/event-stream') && response.body) { // 即時通道：一段一段送，不等結束
      res.flushHeaders?.();
      const reader = response.body.getReader();
      res.on('close', () => reader.cancel().catch(() => {}));
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch {}
      return res.end();
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    // 任何意外都只讓這個請求失敗，不讓整個程式當掉
    console.error(`500 ${req.method} ${req.url}`, e);
    try { sendJson(res, 500, 'INTERNAL', '伺服器錯誤'); } catch {}
  }
}).listen(PORT, () => {
  console.log(`Aigile-Switch 已啟動：http://localhost:${PORT}`);
  if (process.env.ROOM_CODE) console.log('已啟用群組密碼 (ROOM_CODE)');
  if (!process.env.ADMIN_PASSWORD && process.env.AIGILE_TEST_PROJECTS !== '1') console.warn('⚠ 沒有設 ADMIN_PASSWORD：新站的管理員帳號密碼是 admin／admin。放到網路上之前一定要先設（例：.env 寫 ADMIN_PASSWORD=你的密碼），否則誰先打開網址誰就拿到管理員。');
  if (!TRUST_PROXY && !process.env.APP_URL) console.log('提示：放在反向代理（nginx、Caddy、Cloudflare Tunnel…）後面時，請設 TRUST_PROXY=1 與 APP_URL=https://你的網址');
});
