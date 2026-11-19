// 沒有通知時 aigile_ack 只帶 cursor＝只存游標、回成功；兩個都沒帶才報錯，錯誤訊息寫清楚要帶什麼。
// 本機暫存資料庫，不連正式站。用法：node scripts/ack-cursor-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p343-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let rpc = 0;
const tool = async (token, name, args) => {
  const r = (await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })).body;
  const text = r.error ? r.error.message : r.result.content.map(c => c.text).join('\n');
  const isError = !!(r.error || r.result.isError);
  let data = null; try { data = JSON.parse(text); } catch {}
  return { isError, text, data };
};
const NEED_ONE = 'notificationIds 和 cursor 至少帶一個';

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const L = boss.participant.participantId;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: 'PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.equal((await call(ai.token, '/api/me/state', 'PUT', { backlog: [], messagesCursor: 'cur_' + Buffer.from(JSON.stringify({ s: 0 })).toString('base64').replace(/=+$/, '') })).status, 200, '先有工作記憶');
  for (let i = 1; i <= 3; i++) assert.equal((await call(boss.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'm' + i, text: '[通知] 大家看一下 ' + i })).status, 201);
  const stateCursor = async () => (await call(ai.token, '/api/me/state')).body.state?.messagesCursor;

  // 收件匣：沒有找 AI 的通知，只有新訊息與 nextCursor
  const inbox = await tool(ai.token, 'aigile_inbox', {});
  assert.ok(!inbox.isError, inbox.text);
  assert.equal(inbox.data.notifications.length, 0, '沒有通知');
  const cur = inbox.data.nextCursor;
  assert.match(cur, /^cur_/);

  // A. MCP：只帶 cursor＝只存游標、回成功（Codex 原本在這裡被「notificationIds 至少 1 個」擋下）
  let r = await tool(ai.token, 'aigile_ack', { cursor: cur });
  assert.ok(!r.isError, 'A：只帶 cursor 不報錯：' + r.text);
  assert.deepEqual(r.data.confirmedIds, []);
  assert.equal(r.data.messagesCursor, cur, 'A：回存好的游標');
  assert.equal(await stateCursor(), cur, 'A：工作記憶的游標存到了');
  // A2. 帶空陣列＋cursor 也一樣
  r = await tool(ai.token, 'aigile_ack', { notificationIds: [], cursor: cur });
  assert.ok(!r.isError, 'A2：空陣列＋cursor 不報錯：' + r.text);
  assert.equal(r.data.messagesCursor, cur);

  // B. 兩個都沒帶：報錯，訊息說清楚要帶什麼
  for (const args of [{}, { notificationIds: [] }]) {
    r = await tool(ai.token, 'aigile_ack', args);
    assert.ok(r.isError, 'B：都沒帶要報錯：' + JSON.stringify(args));
    assert.ok(r.text.includes(NEED_ONE) && r.text.includes('nextCursor'), 'B：錯誤訊息寫清楚：' + r.text);
  }
  for (const body of [{}, { notificationIds: [] }, { notificationIds: null }]) {
    const x = await call(ai.token, '/api/notifications/ack', 'POST', body);
    assert.equal(x.status, 400, 'B：REST 都沒帶回 400：' + JSON.stringify(body));
    assert.ok(x.body.error.message.includes(NEED_ONE), 'B：REST 錯誤訊息：' + x.body.error.message);
  }

  // C. 格式錯照舊擋，而且不動游標
  assert.equal((await call(ai.token, '/api/notifications/ack', 'POST', { cursor: 'cur_壞掉' })).status, 400, 'C：壞游標 400');
  assert.equal((await call(ai.token, '/api/notifications/ack', 'POST', { notificationIds: 'notif_x', cursor: cur })).status, 400, 'C：notificationIds 不是陣列 400');
  r = await tool(ai.token, 'aigile_ack', { notificationIds: ['msg_abc'], cursor: cur });
  assert.ok(r.isError && r.text.includes('不是 messageId'), 'C：傳 messageId 照舊擋：' + r.text);
  assert.equal(await stateCursor(), cur, 'C：擋下時游標沒動');

  // D. 原本的用法不變：有通知就帶 notificationIds＋cursor
  assert.equal((await call(boss.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'm4', text: '[需確認] 請看', recipientIds: [ai.participantId] })).status, 201);
  const inbox2 = await tool(ai.token, 'aigile_inbox', {});
  const nid = inbox2.data.notifications[0]?.notificationId;
  assert.match(nid || '', /^notif_/, 'D：有一則通知');
  r = await tool(ai.token, 'aigile_ack', { notificationIds: [nid], cursor: inbox2.data.nextCursor });
  assert.deepEqual(r.data.confirmedIds, [nid], 'D：照常確認');
  assert.equal(await stateCursor(), inbox2.data.nextCursor, 'D：游標推進');
  // 只往前不往後：再用舊游標只帶 cursor，游標不倒退
  r = await tool(ai.token, 'aigile_ack', { cursor: cur });
  assert.ok(!r.isError);
  assert.equal(await stateCursor(), inbox2.data.nextCursor, 'D：舊游標不讓游標倒退');

  // E. 人類只帶 cursor：不報錯、沒有工作記憶可存
  const h = await call(boss.token, '/api/notifications/ack', 'POST', { cursor: cur });
  assert.equal(h.status, 200, 'E：人類只帶 cursor 不報錯');
  assert.deepEqual(h.body.confirmedIds, []);
  console.log('ack-cursor-test：全部通過');
} catch (e) {
  console.error('ack-cursor-test 失敗：', e.message, process.env.DEBUG ? e.stack : '');
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
