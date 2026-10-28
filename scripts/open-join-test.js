// 開放自己註冊：沒設 OPEN_JOIN 就開；設 0 只能用邀請連結；設了 ROOM_CODE 每個人註冊都要輸入
// 第二位以後自己註冊的人沒有專案：讀不到專案的訊息與卡片，只看得到「全部專案」的公告，等管理員指派或自己申請加入
// 用法：node scripts/open-join-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-openjoin-'));
const mk = (name, config) => {
  const db = openNodeDb(path.join(dataDir, name));
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
try {
  // 1. 沒設 OPEN_JOIN＝開放；第一位是管理員、在所有專案
  const call = mk('open.db', {});
  assert.equal((await call(null, '/api/health')).status, 200);
  const first = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const boss = first.body;
  assert.ok((await call(boss.token, '/api/me')).body.projects.includes('預設專案'), '第一位在所有專案');
  assert.equal((await call(null, '/api/health')).body.openJoin, true, '沒設 OPEN_JOIN：網頁看到的是開放註冊');

  // 管理員在預設專案發訊息、建卡，另發一則「全部專案」公告
  const inPj = (await call(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '[通知] 只有專案成員看得到' })).body;
  const toAll = (await call(boss.token, '/api/messages', 'POST', { requestId: 'm2', project: 'all', text: '[通知] 全部專案公告：歡迎新成員' })).body;
  const card = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '專案內的卡' })).body;
  assert.ok(inPj.messageId && toAll.messageId && card.cardId, '資料建好：' + JSON.stringify({ inPj, toAll, card }).slice(0, 200));

  // 2. 第二位自己註冊：可以，但沒有專案
  const second = await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' });
  assert.equal(second.status, 201, '開放註冊：第二位也能自己加入：' + JSON.stringify(second.body));
  const mate = second.body;
  assert.deepEqual((await call(mate.token, '/api/me')).body.projects, [], '(1) 自己註冊的人沒有專案');
  const seen = (await call(mate.token, '/api/messages?limit=50')).body.items.map(m => m.messageId);
  assert.ok(!seen.includes(inPj.messageId), '(2) 讀不到預設專案的訊息');
  assert.ok(seen.includes(toAll.messageId), '(3) 看得到「全部專案」公告');
  assert.equal((await call(mate.token, `/api/cards/${card.cardId}`)).status, 403, '(2) 讀不到預設專案的卡');
  assert.ok(!(await call(mate.token, '/api/cards?limit=200')).body.items.some(c => c.cardId === card.cardId), '(2) 卡片清單也沒有');
  assert.equal((await call(mate.token, '/api/messages', 'POST', { requestId: 'm3', project: '預設專案', text: '[進度] 試試看' })).body.error?.code, 'PROJECT_FORBIDDEN', '不能發到預設專案');
  // 管理員指派後就看得到
  await call(boss.token, `/api/participants/${mate.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  assert.equal((await call(mate.token, `/api/cards/${card.cardId}`)).status, 200, '管理員指派後讀得到卡');

  // 3. OPEN_JOIN=0：只有第一位能自己加入
  const closed = mk('closed.db', { openJoin: '0' });
  assert.equal((await closed(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).status, 201, '第一位照樣能建群');
  assert.equal((await closed(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body.error?.code, 'JOIN_CLOSED', 'OPEN_JOIN=0：其他人要邀請連結');
  assert.equal((await closed(null, '/api/health')).body.openJoin, false, 'OPEN_JOIN=0：網頁看到的是關閉');

  // 4. ROOM_CODE：每個人註冊都要輸入
  const coded = mk('coded.db', { roomCode: 'abc123' });
  assert.equal((await coded(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body.error?.code, 'ROOM_CODE_REQUIRED', '第一位也要代碼（沒填：請輸入群組密碼）');
  assert.equal((await coded(null, '/api/join', 'POST', { name: '林志明', role: 'PO', roomCode: 'abc123' })).status, 201);
  assert.equal((await coded(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body.error?.code, 'ROOM_CODE_REQUIRED', '第二位沒代碼擋');
  assert.equal((await coded(null, '/api/join', 'POST', { name: '王小明', role: 'UX', roomCode: 'nope' })).status, 403, '代碼錯：群組密碼錯誤');
  assert.equal((await coded(null, '/api/join', 'POST', { name: '王小明', role: 'UX', roomCode: 'abc123' })).status, 201, '第二位有代碼可以');
  console.log('open-join-test：全部通過');
} catch (e) {
  console.error('open-join-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows 上資料庫檔還開著時刪不掉，留給系統暫存清理
}
