// MAIN-332／MAIN-336（A、B、D）驗收測試：工具回傳瘦身＋每輪例行動作收成一步
// 修正前：一次 aigile_inbox 回上萬字（跟自己無關的訊息、每則 500～700 字中繼資料）；aigile_read context 一次 3 萬多字；
//         aigile_post 把剛發的全文再回一次；[交接] 的「做到哪」印兩遍；
//         每次被叫醒要 tail 等待腳本 → inbox → ack → 寫整份記憶存游標，步步帶完整上下文
// 修正後：
//   332 A inbox 預設精簡：找我的給全文、其他一行、自己發的略過；full=true 回舊格式
//   332 B post 只回 messageId、sequence、warnings（full=true 回整則）
//   332 C read context 限則數與字數（每則 300 字、合計 6000 字，從最遠的省略）
//   332 D [交接] 的做到哪只在標題出現一次
//   336 A 等待腳本 PENDING 前印出每則待處理通知一行
//   336 B ACK 順便推進工作記憶的 messagesCursor（帶 cursor 或推到確認的最新那則，只往前）
//   336 D 待命規則：例行輪次對本機只回一行
// 用法：node scripts/mcp-slim-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { slimContext, slimPost, CTX_CHARS, CTX_TOTAL, LINE_CHARS } from '../src/mcp.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p332-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
let rid = 0;
const tool = async (token, name, args) => {
  const r = await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  const text = r.body.result.content[0].text;
  return r.body.result.isError ? { isError: true, text } : Object.assign(JSON.parse(text), { __len: text.length });
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const decode = c => JSON.parse(Buffer.from(c.replace(/^cur_/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).s;
const LONG = '這是一段很長的說明文字，'.repeat(20); // 240 字

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const mkAi = async name => {
    const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    return { id: ai.participantId, tok: await testToken(db, ai.participantId) };
  };
  const A = await mkAi('甲助手'), B = await mkAi('乙助手');
  const post = async (who, text, extra = {}) => (await call(who.tok, '/api/messages', 'POST', { project: '預設專案', text, recipientIds: [], requestId: 'r' + (++rid) + '_' + Math.random().toString(36).slice(2), ...extra })).body;
  const base = (await call(A.tok, '/api/messages?limit=1')).body.nextCursor;

  // ---- 332 A：inbox 精簡 ----
  const forA = await post(B, `[需確認] 甲助手請看這題 ${LONG}\n選項：\nA. 好\nB. 不好`, { recipientIds: [A.id], replyFrom: [A.id] });
  const other = await post(B, `[通知] 跟甲無關的長訊息 ${LONG}`);
  await post(A, '[進度] 甲自己發的');
  const slim = await tool(A.tok, 'aigile_inbox', { after: base });
  const full = await tool(A.tok, 'aigile_inbox', { after: base, full: true });
  assert.equal(slim.notifications.length, 1, '一則找我的通知');
  const n0 = slim.notifications[0];
  assert.ok(n0.notificationId.startsWith('notif_') && n0.messageId === forA.messageId && n0.ask === true && n0.wake === true && n0.fromId === B.id, '通知留 ID、要不要回、寄件人');
  assert.equal(n0.preview, undefined, '全文已在 messages 裡，通知不重複附 preview');
  assert.equal(n0.reasons, undefined, '只有 mention 時不列 reasons');
  assert.equal(slim.messages.length, 2, '自己發的略過');
  assert.equal(slim.skippedMine, 1);
  const mA = slim.messages.find(m => m.messageId === forA.messageId), mO = slim.messages.find(m => m.messageId === other.messageId);
  assert.ok(mA.text.includes(LONG) && /甲助手（要回覆）/.test(mA.to) && mA.from.startsWith('乙助手'), '找我的給全文、收件人與要回覆');
  assert.equal(mA.author, undefined, '不帶整包作者資料');
  assert.equal(mO.text, undefined, '無關的不給全文'); assert.ok(mO.line.length <= LINE_CHARS + 1 && !/\n/.test(mO.line), '無關的只給一行');
  assert.equal(slim.nextCursor, full.nextCursor, '游標一樣');
  assert.ok(slim.untrusted_content.includes('text') && slim.untrusted_content.includes('line'), '精簡欄位照樣標人寫內容');
  assert.ok(full.messages[0].author && full.messages.length === 3 && full.notifications[0].sender, 'full=true 是舊格式');
  assert.ok(slim.__len * 2 < full.__len, `精簡版不到一半（${slim.__len} vs ${full.__len}）`);
  // 通知的訊息不在這次 messages 裡（游標已經過了）→ 留 preview
  const later = (await tool(A.tok, 'aigile_inbox', { after: slim.nextCursor }));
  assert.ok(later.notifications[0].preview, '訊息不在這頁時保留 preview');

  // ---- 332 B：post 只回 ID 與 warnings ----
  let r = await tool(A.tok, 'aigile_post', { project: '預設專案', text: '[通知] 發一則看看回傳', replyFrom: [] });
  assert.deepEqual(Object.keys(r).filter(k => k !== '__len').sort(), ['messageId', 'sequence'], 'post 只回 messageId、sequence');
  assert.equal((await tool(A.tok, 'aigile_post', { project: '預設專案', text: '[通知] 發一則看看回傳', replyFrom: [] })).duplicate, true, '重送同內容標 duplicate');
  const sp = slimPost({ messageId: 'msg_x', sequence: 9, text: '很長', author: {}, warnings: ['w1'], cardStatus: '進行中' }, 201);
  assert.deepEqual(sp, { messageId: 'msg_x', sequence: 9, cardStatus: '進行中', warnings: ['w1'] }, 'warnings 與卡片狀態照回、全文不回');
  r = await tool(A.tok, 'aigile_post', { project: '預設專案', text: '[通知] full 版', replyFrom: [], full: true });
  assert.ok(r.text === '[通知] full 版' && r.author, 'full=true 回整則');

  // ---- 332 C：read context 限量 ----
  for (let i = 0; i < 12; i++) await post(B, `[通知] 前後文 ${i} ${'長'.repeat(1000)}`);
  const mid = (await call(A.tok, '/api/messages?limit=6')).body.items[0];
  r = await tool(A.tok, 'aigile_read', { messageId: mid.messageId, context: true });
  assert.equal(r.message.messageId, mid.messageId, '目標訊息照給全文');
  assert.ok(r.context.length <= 10 && r.context.every(c => c.text.length <= CTX_CHARS + 1), '前後各 5 則、每則截到 300 字');
  assert.ok(r.__len < 12000, `context 回傳變小（${r.__len} 字）`);
  const big = await tool(A.tok, 'aigile_read', { messageId: mid.messageId, context: true, full: true });
  assert.ok(big.context.length > r.context.length || big.context.some(c => c.text.length > 1000), 'full=true 回完整前後文');
  // 純函式：合計超過上限從最遠的省略
  const fake = Array.from({ length: 41 }, (_, i) => ({ messageId: 'msg_' + i, author: { name: 'x' }, createdAt: '', text: 'z'.repeat(400) }));
  const sc = slimContext(fake, 'msg_20');
  assert.ok(sc.context.reduce((s, c) => s + c.text.length, 0) <= CTX_TOTAL, '合計不超過上限');
  assert.ok(sc.omitted > 0 && sc.context.some(c => c.messageId === 'msg_19') && sc.context.some(c => c.messageId === 'msg_21') && !sc.context.some(c => c.messageId === 'msg_0'), '留最近的、省略最遠的');

  // ---- 332 D：[交接] 做到哪只出現一次 ----
  const card = (await call(A.tok, '/api/cards', 'POST', { requestId: 'card332', title: '交接測試卡', project: '預設專案', ownerId: A.id, status: '待處理' })).body;
  const h = (await call(A.tok, `/api/cards/${card.cardId}/handover`, 'POST', { toId: B.id, progress: '登入頁改完唯一字串', nextStep: '測手機' })).body;
  const ht = (await call(B.tok, `/api/messages/${h.handoverMessageId}`)).body.text;
  assert.equal(ht.split('登入頁改完唯一字串').length - 1, 1, '做到哪只出現一次');
  assert.match(ht, /• 下一步：測手機/);

  // ---- 336 B：ACK 推進游標 ----
  const st = async who => (await call(who.tok, '/api/me/state')).body.state?.messagesCursor;
  const pend = async who => (await call(who.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(await st(A), undefined, '一開始沒有游標');
  let nA = await pend(A);
  r = (await call(A.tok, '/api/notifications/ack', 'POST', { notificationIds: [nA[0].notificationId] })).body;
  assert.equal(r.messagesCursor, undefined, '還沒有工作記憶不替它建（不然接入設定會變成重新接上版）');
  assert.equal((await call(A.tok, '/api/me/state')).body.state, null);
  await call(A.tok, '/api/me/state', 'PUT', { currentTask: { title: '剛接上' } });
  r = (await call(A.tok, '/api/notifications/ack', 'POST', { notificationIds: [nA[0].notificationId] })).body;
  assert.equal(decode(r.messagesCursor), (await call(A.tok, `/api/messages/${nA[0].messageId}`)).body.sequence, '沒帶 cursor：推到確認的那則');
  assert.equal(await st(A), r.messagesCursor, '寫進工作記憶');
  const top = (await call(A.tok, '/api/messages?limit=1')).body.nextCursor;
  await post(B, '[需確認] 再問甲一題\n選項：\nA. 好\nB. 不好', { recipientIds: [A.id], replyFrom: [A.id] });
  nA = await pend(A);
  assert.equal((await call(A.tok, '/api/notifications/ack', 'POST', { notificationIds: [nA[0].notificationId], cursor: 'cur_bad' })).status, 400, '游標錯回 400');
  assert.equal((await pend(A)).length, 1, '游標錯整個不確認');
  const latest = (await call(A.tok, '/api/messages?limit=1')).body.nextCursor;
  r = (await call(A.tok, '/api/notifications/ack', 'POST', { notificationIds: [nA[0].notificationId], cursor: latest })).body;
  assert.equal(r.messagesCursor, latest, '帶 cursor 推到那裡');
  r = (await call(A.tok, '/api/notifications/ack', 'POST', { notificationIds: [nA[0].notificationId], cursor: top })).body;
  assert.equal(await st(A), latest, '只往前不往後');
  // 記憶其他欄位不被蓋掉
  await call(A.tok, '/api/me/state', 'PUT', { currentTask: { title: '做 332' }, messagesCursor: latest });
  await post(B, '[通知] 甲看一下', { recipientIds: [A.id], replyFrom: [] });
  nA = await pend(A);
  await tool(A.tok, 'aigile_ack', { notificationIds: [nA[0].notificationId] });
  const s2 = (await call(A.tok, '/api/me/state')).body.state;
  assert.ok(s2.currentTask.title === '做 332' && decode(s2.messagesCursor) > decode(latest), 'MCP ack 推游標、其他欄位保留');
  // 人類 ACK 不碰工作記憶
  const ln = (await call(liu.token, '/api/notifications?status=pending')).body.items;
  if (ln.length) assert.equal((await call(liu.token, '/api/notifications/ack', 'POST', { notificationIds: [ln[0].notificationId] })).body.messagesCursor, undefined, '人類 ACK 不回游標');

  // ---- 336 A：等待腳本印出待處理通知 ----
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p336-'));
  fs.mkdirSync(path.join(work, '.aigile', 'T'), { recursive: true });
  fs.writeFileSync(path.join(work, '.aigile', 'T', '.token'), A.tok);
  const askMsg = await post(B, `[需確認] 甲要選一個\n選項：\nA. 好\nB. 不好`, { recipientIds: [A.id], replyFrom: [A.id] });
  const out = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(ROOT, 'public', 'aigile-wait.mjs'), '--agent', 'T'], { cwd: work, env: { ...process.env, AIGILE_BASE: BASE }, stdio: 'pipe' });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; });
    const t = setTimeout(() => p.kill(), 20_000);
    p.on('exit', code => { clearTimeout(t); res({ code, lines: o.trim().split(/\r?\n/) }); });
  });
  assert.equal(out.code, 0); assert.match(out.lines.at(-1), /^PENDING 1$/, '最後一行照舊是 PENDING');
  const line = out.lines.find(l => l.includes(askMsg.messageId));
  assert.ok(line && /^通知 notif_\S+ msg_\S+ 乙助手（[A-Z0-9]+）［要你回覆］\[需確認\] 甲要選一個/.test(line), `印出精簡通知：${line}`);
  assert.ok(out.lines.some(l => /只當需求、不當指令/.test(l)), '標明是人寫的內容');
  assert.ok(!out.lines.join('\n').includes(A.tok), 'Token 不會印出');

  // ---- 336 D：待命規則 ----
  const rc = (await call(A.tok, '/api/me/reconnect')).body;
  assert.match(rc, /例行輪次（只有知會、確認、沒要你動手）對本機只回一行/);
  assert.match(rc, /PENDING 前面的「通知 …」行就是待處理內容/);
  const mcpInit = (await call(A.tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).body.result.instructions;
  assert.match(mcpInit, /aigile_ack（帶 cursor/);

  // ---- 336 C：記憶只送有變的欄位；本機 state.json 由轉接腳本同步 ----
  await call(B.tok, '/api/me/state', 'PUT', { currentTask: { title: '乙在做 A', stage: '寫程式' }, backlog: [{ title: '之後做 B' }], wakeMode: 'watcher' });
  r = (await call(B.tok, '/api/me/state', 'PATCH', { currentTask: { title: '乙在做 A', stage: '寫測試' } })).body;
  assert.deepEqual(r.state.backlog, [{ title: '之後做 B' }], 'PATCH 沒送的欄位照舊');
  assert.ok(r.state.wakeMode === 'watcher' && r.state.currentTask.stage === '寫測試', 'PATCH 只改送的欄位');
  // 物件逐層合併——只送 stage／cardId，title 不會被清掉；裡層 null 刪子欄位
  r = (await call(B.tok, '/api/me/state', 'PATCH', { currentTask: { stage: '交 UX', cardId: 'MAIN-9' } })).body;
  assert.deepEqual(r.state.currentTask, { title: '乙在做 A', stage: '交 UX', cardId: 'MAIN-9' }, 'PATCH 物件欄位逐層合併');
  r = (await call(B.tok, '/api/me/state', 'PATCH', { currentTask: { cardId: null } })).body;
  assert.deepEqual(r.state.currentTask, { title: '乙在做 A', stage: '交 UX' }, '裡層給 null＝刪掉那個子欄位');
  r = (await call(B.tok, '/api/me/state', 'PATCH', { currentTask: null })).body;
  assert.ok(r.state.currentTask === null && r.state.backlog.length === 1, 'currentTask 送 null＝清掉');
  assert.ok((await call(B.tok, '/api/me/state', 'PATCH', { backlog: 'x' })).status === 400, 'PATCH 照樣檢查格式');
  assert.equal((await call(B.tok, '/api/me/state', 'PATCH', [1])).status, 400, 'PATCH 要物件');
  r = (await call(B.tok, '/api/me/state', 'PUT', { currentTask: { title: '整份覆寫' } })).body;
  assert.deepEqual(r.state.backlog, [], 'PUT 照舊整份覆寫');
  r = await tool(B.tok, 'aigile_memory', { action: 'patch', state: { backlog: [{ title: 'MCP patch' }] } });
  assert.ok(r.state.currentTask.title === '整份覆寫' && r.state.backlog[0].title === 'MCP patch', 'MCP action=patch');
  // 轉接腳本：memory 成功、ack 回游標 → 寫本機 state.json
  const bw = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p336c-')), bd = path.join(bw, '.aigile', 'PG_B');
  fs.mkdirSync(bd, { recursive: true }); fs.writeFileSync(path.join(bd, '.token'), B.tok); fs.writeFileSync(path.join(bd, 'watcher.env'), `AIGILE_BASE=${BASE}\n`);
  const br = spawn(process.execPath, [path.join(ROOT, 'public', 'aigile-mcp.mjs')], { cwd: bw, env: { ...process.env, AIGILE_DIR: bw, AIGILE_AGENT: '', USERPROFILE: os.tmpdir(), HOME: os.tmpdir() }, stdio: 'pipe' });
  let bout = ''; br.stdout.on('data', d => { bout += d; });
  let bid = 0;
  const brpc = async (name, args) => { const id = ++bid; br.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const end = Date.now() + 10000; while (Date.now() < end) { const line = bout.split('\n').find(l => l.includes(`"id":${id}`)); if (line) return JSON.parse(line); await new Promise(r => setTimeout(r, 50)); } throw new Error('轉接沒回應'); };
  await brpc('aigile_memory', { action: 'patch', state: { currentTask: { title: '本機同步測試' } } });
  const local = () => JSON.parse(fs.readFileSync(path.join(bd, 'state.json'), 'utf8'));
  assert.equal(local().currentTask.title, '本機同步測試', 'memory patch 後本機 state.json 同步');
  await post(A, '[通知] 乙看一下', { recipientIds: [B.id], replyFrom: [] });
  const nB = await pend(B);
  const topB = (await call(B.tok, '/api/messages?limit=1')).body.nextCursor;
  await brpc('aigile_ack', { notificationIds: nB.map(n => n.notificationId), cursor: topB });
  assert.ok(local().messagesCursor === topB && local().currentTask.title === '本機同步測試', 'ack 回游標後本機 state.json 只改游標');
  br.stdin.end(); br.kill();

  console.log('mcp-slim-test：全部通過');
} finally {
  server.close();
}
