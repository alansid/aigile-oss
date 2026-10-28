// 驗收測試
//   - 同時建群只有一位拿到所有專案；離開群組撤銷裝置、清掉待處理通知；建卡中途失敗不留下半張卡
//   - 超過上限的請求不讀完本文就回 413；R2 已確認通知清單走索引、不整批排序
// 用法：node scripts/concurrency-limits-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const mkApp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
  const db = openNodeDb(path.join(dir, 'switch.db'));
  return { dir, db, app: createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } }) };
};
const caller = app => async (token, p, method = 'GET', body, extra = {}) => {
  const init = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra.headers || {}) } };
  if (extra.raw !== undefined) { init.body = extra.raw; init.duplex = 'half'; } else if (body) init.body = JSON.stringify(body);
  const r = await app(new Request('http://localhost' + p, init), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 會一直吐資料的串流，記下被讀走多少
function bigStream(total, chunk = 64 * 1024) {
  const s = { pulled: 0 };
  s.stream = new ReadableStream({
    pull(ctl) {
      if (s.pulled >= total) return ctl.close();
      s.pulled += chunk;
      ctl.enqueue(new Uint8Array(chunk).fill(0x61));
    },
  });
  return s;
}
const dirs = [];

try {
  // ---- B11：兩個人同時建群 ----
  {
    const { dir, app } = mkApp(); dirs.push(dir);
    const call = caller(app);
    const [a, b] = await Promise.all([
      call(null, '/api/join', 'POST', { name: '甲', role: 'PO' }),
      call(null, '/api/join', 'POST', { name: '乙', role: 'UX' }),
    ]);
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const allProj = [a, b].filter(x => x.body.participant.projects.length > 1);
    assert.equal(allProj.length, 1, `B11：同時建群只有一位拿到所有專案（實際 ${allProj.length} 位）`);
  }

  const { dir, db, app } = mkApp(); dirs.push(dir);
  const call = caller(app);
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const L = boss.participant.participantId;

  // ---- B11：離開群組撤銷裝置、清掉自己與自己 AI 的待處理通知 ----
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  const W = wang.participant.participantId;
  await call(boss.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['預設專案'] });
  const wCode = wang.token; // 註冊時拿到的登入碼原文
  const wDev = (await call(null, '/api/auth/code', 'POST', { code: wCode })).body.token;
  assert.match(wDev, /^dv_/);
  const wAi = (await call(wang.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '小明PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  await call(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '[回覆] 通知兩位', recipientIds: [W, wAi.participantId] });
  const pend = async ids => (await db.get(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending' AND recipient_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))).n;
  assert.ok(await pend([W, wAi.participantId]) >= 2, '離開前有待處理通知');
  assert.equal((await call(wDev, '/api/leave', 'POST', {})).status, 200);
  assert.equal(await pend([W, wAi.participantId]), 0, 'B11：離開後本人與他的 AI 沒有待處理通知');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM devices WHERE participant_id = ? AND revoked_at IS NULL', W)).n, 0, 'B11：離開後裝置都撤銷');

  // ---- B11：建卡中途失敗不留下半張卡 ----
  await db.run("CREATE TRIGGER c343_fail BEFORE INSERT ON card_log BEGIN SELECT RAISE(ABORT, 'c343 測試：寫紀錄失敗'); END");
  const origErr = console.error; console.error = () => {};
  const bad = await call(boss.token, '/api/cards', 'POST', { requestId: 't1_bad', title: '會失敗的卡', project: '預設專案' });
  console.error = origErr;
  await db.run('DROP TRIGGER c343_fail');
  assert.ok(bad.status >= 500, '寫紀錄失敗 → 建卡失敗');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM cards WHERE request_id = 't1_bad'")).n, 0, 'B11：中途失敗不留下沒有編號的卡');
  const ok = (await call(boss.token, '/api/cards', 'POST', { requestId: 't1_ok', title: '正常的卡', project: '預設專案' })).body;
  const okRow = await db.get("SELECT proj_no FROM cards WHERE request_id = 't1_ok'");
  assert.ok(ok.cardId && okRow.proj_no >= 1, 'B11：正常建卡有專案內編號');
  assert.ok((await call(boss.token, `/api/cards/${ok.cardId}`)).body.log.some(l => /建立卡片/.test(l.text)), 'B11：正常建卡有紀錄');

  // ---- S6：超過上限不讀完本文就回 413 ----
  const big = 'x'.repeat(300 * 1024);
  const r1 = await call(boss.token, '/api/messages', 'POST', undefined, { raw: JSON.stringify({ requestId: 'big', project: '預設專案', text: big }) });
  assert.equal(r1.status, 413, 'S6：JSON 超過 256 KB 回 413');
  const s1 = bigStream(20 * 1024 * 1024);
  const r2 = await call(boss.token, '/api/messages', 'POST', undefined, { raw: s1.stream });
  assert.equal(r2.status, 413, 'S6：沒帶長度的大串流回 413');
  assert.ok(s1.pulled <= 512 * 1024, `S6：只讀到上限附近就停（讀了 ${s1.pulled} bytes，總共 20 MB）`);
  const s2 = bigStream(20 * 1024 * 1024);
  const r3 = await call(boss.token, '/api/files?name=a.pdf&declared=true&project=all', 'POST', undefined, { raw: s2.stream, headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(r3.status, 413, 'S6：檔案超過 2 MB 回 413');
  assert.equal(r3.body.error?.code, 'FILE_TOO_LARGE');
  assert.ok(s2.pulled <= 3 * 1024 * 1024, `S6：檔案只讀到上限附近（讀了 ${s2.pulled} bytes）`);
  const r4 = await call(boss.token, '/api/me/avatar', 'PUT', undefined, { raw: new Uint8Array(300 * 1024), headers: { 'Content-Type': 'image/png' } });
  assert.equal(r4.status, 413, 'S6：頭像超過 200 KB 回 413');
  assert.equal((await call(boss.token, '/api/messages', 'POST', { requestId: 'small', project: '預設專案', text: '[回覆] 一般訊息' })).status, 201, 'S6：一般大小照常');

  // ---- R2：已確認通知清單走索引（不把整個人的已確認通知讀出來排序）----
  const plan = (await db.all("EXPLAIN QUERY PLAN SELECT n.* FROM notifications n WHERE n.recipient_id = ? AND n.status = 'acked' ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?", L, 51)).map(r => r.detail).join(' | ');
  assert.ok(/USING INDEX idx_notif_recipient/.test(plan) && !/TEMP B-TREE/.test(plan), `R2：走 idx_notif_recipient、不另外排序：${plan}`);
  const conf = await call(boss.token, '/api/notifications?status=confirmed&limit=5');
  assert.equal(conf.status, 200, 'R2：confirmed 清單照常可用');

  console.log('c343: all checks passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}
