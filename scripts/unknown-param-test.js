// 驗收測試：訊息與通知 API 收到不認得的查詢參數回 400，不再默默忽略
// 修正前：GET /api/messages?cursor=…（正確是 after）不報錯，直接從頭回舊訊息，AI 容易把歷史訊息當新任務
// 修正後：/api/messages、/api/notifications、/api/notifications/count 帶不認得的參數回 400 UNKNOWN_PARAM，
//         錯誤訊息寫出不認得哪個、這個端點收哪些；網頁、watcher、等待腳本、poll、MCP、規格實際帶的組合照常；英文介面翻得到
// 用法：node scripts/unknown-param-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { loadEn } from './i18n-scan.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-unknown-param-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docText: read('docs/ai-integration.md'), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json() };
};
// 在 node 裡跑 public/i18n/i18n.js（假的瀏覽器環境），拿到英文的 aigileI18n
function loadI18nEn() {
  const src = read('public/i18n/i18n.js');
  const script = {}, win = {};
  const doc = { documentElement: { lang: '', classList: { add() {}, remove() {} } }, addEventListener() {}, createElement: () => script, head: { append() {}, querySelector: () => null }, body: null };
  new Function('window', 'document', 'localStorage', 'navigator', 'location', 'MutationObserver', src)(
    win, doc, { getItem: () => 'en', setItem() {} }, { language: 'en' }, { reload() {} }, class { observe() {} });
  win.AIGILE_EN = loadEn(); script.onload();
  return win.aigileI18n;
}

try {
  const P = '預設專案';
  const boss = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const ai = (await req(boss.token, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const m = (await req(boss.token, '/api/messages', 'POST', { project: P, text: '@程式助手 測試', recipientIds: [ai.participantId], requestId: 'req_unknown_param' })).body;
  const cur = (await req(ai.token, '/api/messages?limit=1')).body.nextCursor;
  assert.ok(m.messageId && cur, '前置：有訊息與游標');

  // 各參數的合法值（呼叫端的 ${…} 換成這些）
  const val = { limit: '5', after: cur, before: cur, beforeId: m.messageId, span: '1', min: '1', project: P, brief: '1', status: 'pending', order: 'desc', wake: '1' };
  const ok = async (ep, keys, who) => {
    const qs = keys.map(k => { assert.ok(k in val, `${who} 帶了測試沒列的參數 ${k}（要加進白名單或測試）`); return `${k}=${encodeURIComponent(val[k])}`; }).join('&');
    const r = await req(ai.token, `${ep}${qs ? '?' + qs : ''}`);
    assert.equal(r.status, 200, `${who}：${ep}?${qs} 要照常 200，實際 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  };

  // 1) 從呼叫端原始碼抽出實際帶的參數組合，逐一照常
  const sources = ['public/app.js', 'public/watcher.mjs', 'public/aigile-wait.mjs', 'public/poll.mjs', 'public/aigile-opencode.mjs', 'public/aigile-setup.mjs',
    'docs/ai-integration.md', 'docs/connect-your-ai.md', 'docs/connect-your-ai.en.md', 'README.md', 'README.en.md'];
  let combos = 0;
  for (const f of sources) {
    const text = read(f).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const [, ep, q] of text.matchAll(/(\/api\/(?:messages|notifications)(?:\/count)?)\?([A-Za-z][^'"`\s)|]*)/g)) {
      const keys = [...new Set(q.split('&').map(kv => kv.split('=')[0]).filter(Boolean))];
      await ok(ep, keys, f); combos++;
    }
  }
  // MCP 用 qs({ … }) 組參數
  const mcp = read('src/mcp.js');
  for (const [, ep, obj] of mcp.matchAll(/`(\/api\/(?:messages|notifications))\$\{qs\(\{([^}]*)\}\)\}`/g)) {
    const keys = obj.split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
    await ok(ep, keys, 'src/mcp.js'); combos++;
  }
  assert.ok(combos >= 10, `抽到的呼叫組合太少（${combos}），正規式可能失效`);
  // 特別點名：MCP 對通知帶 brief=1、等待腳本 wake=1、舊 watcher 什麼都不帶
  await ok('/api/notifications', ['status', 'limit', 'brief'], 'MCP aigile_inbox');
  await ok('/api/notifications/count', ['wake'], '等待腳本');
  await ok('/api/notifications/count', [], '舊版 watcher');
  await ok('/api/messages', [], '不帶參數');
  await ok('/api/notifications', [], '不帶參數');
  const empty = await req(ai.token, '/api/messages?after=&brief=1');
  assert.equal(empty.status, 200, '空值的合法參數照常（after= 空字串＝不帶游標）');

  // 2) 打錯回 400 UNKNOWN_PARAM，訊息寫出不認得哪個、收哪些
  const errs = [];
  let r = await req(ai.token, `/api/messages?cursor=${encodeURIComponent(cur)}&brief=1`);
  assert.equal(r.status, 400, 'messages 帶 cursor= 回 400');
  assert.equal(r.body.error.code, 'UNKNOWN_PARAM');
  assert.ok(r.body.error.message.includes('cursor') && r.body.error.message.includes('游標請用 after'), '錯誤訊息點名 cursor、提示用 after：' + r.body.error.message);
  assert.ok(r.body.error.message.includes('只收 limit、after、before、beforeId、span、min、project、brief'), '列出這個端點收哪些');
  errs.push(r.body.error);
  r = await req(ai.token, '/api/notifications?status=pending&foo=1&bar=2');
  assert.equal(r.status, 400, 'notifications 打錯回 400');
  assert.ok(r.body.error.code === 'UNKNOWN_PARAM' && r.body.error.message.includes('foo、bar') && r.body.error.message.includes('status、limit、order、brief'), '通知列出不認得的與收的：' + r.body.error.message);
  assert.ok(!r.body.error.message.includes('游標請用 after'), '通知端點不提 after');
  errs.push(r.body.error);
  r = await req(ai.token, '/api/notifications/count?wakeup=1');
  assert.ok(r.status === 400 && r.body.error.code === 'UNKNOWN_PARAM' && r.body.error.message.includes('wakeup') && r.body.error.message.includes('只收 wake'), 'count 打錯回 400');
  errs.push(r.body.error);
  r = await req(ai.token, `/api/messages?cursor=${encodeURIComponent(cur)}&lim=5&limit=5`);
  assert.ok(r.status === 400 && r.body.error.message.includes('不認得參數 cursor、lim；'), '同時打錯兩個，兩個都列出來：' + r.body.error.message);
  r = await req(ai.token, '/api/messages?Limit=5');
  assert.equal(r.status, 400, '大小寫不同也算不認得（Limit≠limit）');

  // 3) 英文介面：兩種句子都翻成英文，參數名照原文
  const en = loadI18nEn();
  const [cursorErr, notifErr] = errs.map(e => en.err(e.code, e.message));
  assert.ok(/does not recognize parameter cursor; this endpoint only accepts limit/.test(cursorErr) && cursorErr.endsWith('(use after for the cursor)'), '英文：提示用 after 的句子 → ' + cursorErr);
  assert.ok(/^GET \/api\/notifications does not recognize parameter foo、bar; this endpoint only accepts status、limit、order、brief$/.test(notifErr), '英文：一般句子 → ' + notifErr);

  // 4) 打錯不會有副作用：通知還在待處理
  const pend = (await req(ai.token, '/api/notifications/count')).body.pending;
  assert.equal(pend, 1, '打錯參數不影響待處理通知');

  console.log(`unknown-param: all checks passed（呼叫端組合 ${combos} 個）`);
} finally {
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
