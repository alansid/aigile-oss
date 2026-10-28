// 英文介面載入示範資料：專案、成員、卡片、對話、決策卡都是英文；協定標籤（[接單]、[需確認]、選項：、建議：）與卡片狀態照原文
// 沒帶 lang（或 zh）照舊中文；清除一樣只刪示範的
// 用法：node scripts/demo-en-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-demo-en-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'), { legacyProjects: false });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const HAN = /[㐀-鿿]/;
const TAGS = /\[(?:接單|完成|進度|需確認|通知|回覆)\]|選項：|建議：/g;
try {
  const boss = (await call(null, '/api/join', 'POST', { name: 'Lin', role: 'PO' })).body;
  // 英文
  const r = await call(boss.token, '/api/admin/demo', 'POST', { lang: 'en' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.projectName, 'Demo: event sign-up site');
  assert.deepEqual(r.body.people, ['Demo-Product-Owner', 'Demo-Dev-Assistant', 'Demo-Design-Assistant']);
  const cards = await db.all('SELECT * FROM cards WHERE project = ?', r.body.projectId);
  assert.equal(cards.length, 6);
  for (const c of cards) {
    for (const k of ['title', 'next', 'blocker', 'criteria', 'question', 'recommendation', 'impact', 'after_next']) assert.ok(!HAN.test(c[k] || ''), `卡片 ${k} 是英文：${c[k]}`);
    assert.ok(['已完成', '進行中', '待確認', '受阻', '待處理'].includes(c.status), '狀態值照原文：' + c.status);
  }
  assert.ok(cards.some(c => c.type === '決策' && JSON.parse(c.options).includes('Open a waiting list')), '決策卡選項英文、類型照原文');
  const msgs = await db.all('SELECT text FROM messages WHERE project = ? ORDER BY created_at', r.body.projectId);
  assert.equal(msgs.length, 7);
  for (const m of msgs) assert.ok(!HAN.test(m.text.replace(TAGS, '')), '對話是英文（協定標籤除外）：' + m.text);
  assert.ok(msgs.some(m => m.text.startsWith('[接單] DEMO-2')), '協定標籤與卡號照原文');
  assert.ok(msgs.some(m => /選項：\nA\. Include a map link\nB\. No map, just the address\n建議：A/.test(m.text)), '[需確認] 的選項格式照原文，AI 解析得到');
  const ev = (await call(boss.token, `/api/projects/${r.body.projectId}/events`)).body.items;
  assert.ok(ev.some(e => e.text === 'Lin loaded demo data'), '異動紀錄英文');
  // 清掉再載中文：照舊
  assert.equal((await call(boss.token, '/api/admin/demo', 'DELETE')).status, 200);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM cards')).n, 0, '清掉了');
  const z = await call(boss.token, '/api/admin/demo', 'POST');
  assert.equal(z.body.projectName, '示範：活動報名網站', '沒帶 lang 照舊中文');
  assert.ok((await db.all('SELECT title FROM cards WHERE project = ?', z.body.projectId)).some(c => c.title === '報名成功寄確認信'));
  console.log('demo-en-test：全部通過');
} catch (e) {
  console.error('demo-en-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
