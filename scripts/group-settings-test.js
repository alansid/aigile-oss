// 管理頁直接改加入設定：開放註冊、群組密碼、群組名稱，存資料庫、立刻生效，不用重新部署
// 環境變數只在網頁沒改過時有效；網頁改過（含清除密碼）就以網頁為準。群組密碼不回傳到任何 API、不寫進日誌；每次改都留在群組異動紀錄
// 用法：node scripts/group-settings-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const SECRET = 'blue-sky-7781';
const ENV_CODE = 'env-code-5521';
const logs = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(' ')); orig(...a); }; }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-group-settings-'));
const seen = [];
const mk = (file, config) => {
  const db = openNodeDb(path.join(dataDir, file), {});
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000', ...config } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const text = await r.text();
    seen.push(text);
    let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };
};
try {
  // 環境變數：ROOM_CODE 有設、OPEN_JOIN 沒設（開）
  const call = mk('a.db', { roomCode: ENV_CODE });
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', roomCode: ENV_CODE })).body;
  assert.ok(boss.token, '第一位加入（測試模式＝管理員）');
  const h0 = (await call(null, '/api/health')).body;
  assert.equal(h0.roomCodeRequired, true); assert.equal(h0.openJoin, true);
  const s0 = await call(boss.token, '/api/group/settings');
  assert.equal(s0.status, 200, JSON.stringify(s0.body));
  assert.deepEqual({ openJoin: s0.body.openJoin, roomCodeSet: s0.body.roomCodeSet }, { openJoin: true, roomCodeSet: true });
  assert.equal(s0.body.source.roomCode, 'env', '還沒在網頁改過：照環境變數');
  assert.equal((await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'wrong' })).status, 403, '環境變數的群組密碼有效');
  // 沒填群組密碼：回「請輸入群組密碼」（不是「錯誤」），也不算猜錯；連續 12 次沒填，填對還是能加入
  for (let i = 0; i < 12; i++) {
    const r = await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', ...(i % 2 ? { roomCode: '  ' } : {}) });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'ROOM_CODE_REQUIRED'); assert.equal(r.body.error.message, '請輸入群組密碼');
  }
  const mate = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: ENV_CODE })).body;
  assert.ok(mate.token);

  // 只有管理員能看、能改
  assert.equal((await call(mate.token, '/api/group/settings')).status, 403, '一般成員不能看');
  assert.equal((await call(mate.token, '/api/group/settings', 'PUT', { openJoin: false })).status, 403, '一般成員不能改');
  assert.equal((await call(null, '/api/group/settings')).status, 401, '沒登入不能看');

  // 換群組密碼：立刻生效，舊的（環境變數）不能用
  const r1 = await call(boss.token, '/api/group/settings', 'PUT', { roomCode: SECRET });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.roomCodeSet, true); assert.equal(r1.body.source.roomCode, 'web');
  assert.equal((await call(null, '/api/join', 'POST', { name: '王小明', role: 'PG', roomCode: ENV_CODE })).status, 403, '環境變數的密碼不再有效');
  assert.equal((await call(null, '/api/join', 'POST', { name: '王小明', role: 'PG', roomCode: SECRET })).status, 201, '新密碼立刻能用');
  assert.equal((await call(boss.token, '/api/group/settings', 'PUT', { roomCode: 'ab' })).status, 400, '太短的密碼擋掉');

  // 重啟（同一個資料庫、環境變數不變）：還是網頁設的為準
  const call2 = mk('a.db', { roomCode: ENV_CODE });
  assert.equal((await call2(null, '/api/join', 'POST', { name: '張美玲', role: 'UX', roomCode: ENV_CODE })).status, 403, '重啟後環境變數不會蓋回去');

  // 清除群組密碼：不用密碼也能註冊
  const r2 = await call2(boss.token, '/api/group/settings', 'PUT', { roomCode: '' });
  assert.equal(r2.body.roomCodeSet, false);
  assert.equal((await call2(null, '/api/health')).body.roomCodeRequired, false, '登入頁不再要密碼');
  assert.equal((await call2(null, '/api/join', 'POST', { name: '張美玲', role: 'UX' })).status, 201, '清除後不用密碼');

  // 關閉開放註冊：立刻只能用邀請連結
  const r3 = await call2(boss.token, '/api/group/settings', 'PUT', { openJoin: false });
  assert.equal(r3.body.openJoin, false); assert.equal(r3.body.source.openJoin, 'web');
  assert.equal((await call2(null, '/api/health')).body.openJoin, false);
  assert.equal((await call2(null, '/api/join', 'POST', { name: '李志豪', role: 'PG' })).body.error?.code, 'JOIN_CLOSED', '關了就不能自己註冊');
  // 另一份程式（Workers 多個執行個體）也立刻生效
  const call3 = mk('a.db', { roomCode: ENV_CODE, openJoin: '1' });
  assert.equal((await call3(null, '/api/join', 'POST', { name: '李志豪', role: 'PG' })).status, 403, '別份程式也立刻關閉，環境變數 OPEN_JOIN=1 不會蓋回去');
  await call3(boss.token, '/api/group/settings', 'PUT', { openJoin: true });
  assert.equal((await call2(null, '/api/join', 'POST', { name: '李志豪', role: 'PG' })).status, 201, '重新打開');
  assert.equal((await call2(boss.token, '/api/group/settings', 'PUT', { openJoin: 'yes' })).status, 400, 'openJoin 要是 true／false');

  // 群組名稱：一樣在這裡改得到，也留紀錄
  assert.equal((await call2(boss.token, '/api/group', 'PUT', { name: '我們的團隊' })).status, 200);
  assert.equal((await call2(boss.token, '/api/group/settings', 'PUT', { name: '新團隊' })).body.name, '新團隊', '同一支 API 也能改名稱');
  assert.equal((await call2(null, '/api/group')).body.name, '新團隊');

  // 異動紀錄：每次改都有；寫了誰改的，但沒有密碼
  const ev = await call2(boss.token, '/api/group/events');
  assert.equal(ev.status, 200);
  const texts = ev.body.items.map(x => x.text);
  for (const k of ['設定群組密碼', '清除群組密碼', '關閉開放註冊', '開放自己註冊', '我們的團隊', '新團隊']) assert.ok(texts.some(t => t.includes(k)), `異動紀錄有「${k}」：` + JSON.stringify(texts));
  assert.ok(ev.body.items.length >= 6 && ev.body.items.every(x => x.actorId && x.at), '記了是誰、什麼時候改的');
  assert.ok(texts.every(t => t.includes('林志明')), '紀錄寫出管理員名字');
  assert.equal((await call2(mate.token, '/api/group/events')).status, 403, '一般成員看不到群組異動紀錄');

  // 群組密碼不出現在任何回應與日誌
  assert.ok(!seen.some(t => t.includes(SECRET)), '密碼沒有出現在任何 API 回應');
  assert.ok(!logs.some(t => t.includes(SECRET)), '密碼沒有寫進日誌');

  // 沒設 ROOM_CODE 的站：網頁設了密碼就要密碼
  const b = mk('b.db', {});
  const bb = (await b(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  assert.equal((await b(bb.token, '/api/group/settings')).body.roomCodeSet, false);
  await b(bb.token, '/api/group/settings', 'PUT', { roomCode: SECRET });
  assert.equal((await b(null, '/api/join', 'POST', { name: '陳大文', role: 'QA' })).body.error?.code, 'ROOM_CODE_REQUIRED', '網頁設了就要密碼（沒填：請輸入群組密碼）');
  assert.equal((await b(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'nope' })).status, 403, '填錯：群組密碼錯誤');
  console.log('group-settings-test：全部通過');
} catch (e) {
  console.error('group-settings-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
