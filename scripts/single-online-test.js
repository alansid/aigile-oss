// 驗收測試：同一 AI 代號只留一個對話在線；建卡防重複
// 修正前：第 3 次舊 PO 視窗沒關，新舊兩個對話同時被叫醒，舊的建了重複卡 PJI-7（requestId 不同，擋不到）；
//         wait.pid 過期、PID 已被瀏覽器重用時，照 PID 判斷「還在跑」或照 PID 砍會誤殺
// 修正後：
//   A 本機：已有等待腳本在跑，第二個印 ALREADY_RUNNING 結束；--replace 才接手（先比對命令列）
//     跨電腦：啟動時向平台登記（後登記的算數），舊的要叫醒時印 SUPERSEDED 結束、不叫醒
//   B 建卡：requestId 相同回原卡（原本就有）；AI 30 分鐘內同專案同標題未結案也回原卡
//   C 取代舊等待腳本比對命令列；wait.pid 超過 5 分鐘沒更新＝舊檔（PID 可能被重用），不算在跑、絕不停它
// 用法：node scripts/single-online-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAIT = path.join(ROOT, 'public', 'aigile-wait.mjs'), HOOK = path.join(ROOT, 'public', 'aigile-hook.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p331-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const procs = [];
function runWait(work, agent, extra = []) {
  const p = spawn(process.execPath, [WAIT, '--agent', agent, ...extra], { cwd: work, env: { ...process.env, AIGILE_BASE: BASE }, stdio: 'pipe' });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const done = new Promise(res => p.on('exit', code => res({ code, lines: out.trim().split(/\r?\n/) })));
  const w = { p, out: () => out, done }; procs.push(w); return w;
}
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label); };
// 一個工作資料夾＋代號資料夾：Token、watcher 活著（用測試程序自己當 watcher）、門鈴檔心跳新鮮
function mkWork(agent, tok) {
  const work = fs.mkdtempSync(path.join(dataDir, 'w-')), dir = path.join(work, '.aigile', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.token'), tok);
  fs.writeFileSync(path.join(dir, 'watcher.pid'), String(process.pid));
  fs.writeFileSync(path.join(dir, 'watcher.env'), `AIGILE_BASE=${BASE}\nSKILL_TOOL=claude\n`);
  const bell = (seq, pending) => fs.writeFileSync(path.join(dir, 'bell.json'), JSON.stringify({ v: 1, seq, pending, heartbeatAt: new Date().toISOString(), pid: process.pid }));
  bell(0, 0);
  return { work, dir, bell };
}

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: 'PO', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: await testToken(db, a.participantId) }; };
  const po = await mk('產品助手');
  let k = 0;
  const ask = () => call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: `q-${++k}`, recipientIds: [po.id], replyFrom: [po.id], text: `[需確認] 第 ${k} 題\n選項：\nA. 好\nB. 不好` });

  // A 本機：第二個等待腳本 ALREADY_RUNNING
  const m1 = mkWork('PO', po.tok);
  const w1 = runWait(m1.work, 'PO');
  await until(() => fs.existsSync(path.join(m1.dir, 'wait.pid')) && fs.readFileSync(path.join(m1.dir, 'wait.pid'), 'utf8').trim() === String(w1.p.pid), 8000, '第一個等待腳本寫 wait.pid');
  await sleep(1500); // 等它登記完
  const w2 = runWait(m1.work, 'PO');
  let r = await w2.done;
  assert.equal(r.code, 50, '第二個結束碼 50：' + r.lines.join('|')); assert.equal(r.lines.at(-1), `ALREADY_RUNNING ${w1.p.pid}`);
  assert.match(r.lines.join('\n'), /不要再開；確定那個對話已關、要由這裡接手，才加 --replace/);
  assert.equal(w1.p.exitCode, null, '第一個還在跑');
  // --replace：比對命令列確定是等待腳本才停掉它
  const w3 = runWait(m1.work, 'PO', ['--replace']);
  r = await Promise.race([w1.done, sleep(60_000).then(() => null)]); // 最多等 60 秒，不卡到整支逾時
  assert.ok(r && (w1.p.exitCode !== null || w1.p.signalCode !== null), '舊的被停掉（Linux／macOS 是被訊號停掉，exitCode 為 null、signalCode 有值）：' + w3.out().slice(-300));
  await until(() => /--replace：已停掉舊的等待腳本/.test(w3.out()), 15000, '接手訊息');
  assert.equal(fs.readFileSync(path.join(m1.dir, 'wait.pid'), 'utf8').trim(), String(w3.p.pid), 'wait.pid 換成新的');

  // A 跨電腦：另一台（另一個資料夾）後登記 → 舊的被叫醒時 SUPERSEDED、不叫醒；新的照常 PENDING
  const m2 = mkWork('PO', po.tok);
  const w4 = runWait(m2.work, 'PO');
  await until(() => /先前有別的對話在待命/.test(w4.out()), 8000, '新的知道有舊的：' + w4.out());
  await ask();
  m1.bell(1, 1); m2.bell(1, 1);
  const [old, neu] = await Promise.all([w3.done, w4.done]);
  assert.equal(old.code, 51, '舊的結束碼 51：' + old.lines.join('|')); assert.equal(old.lines.at(-1), 'SUPERSEDED');
  assert.match(old.lines.join('\n'), /後來有別的對話接上.*不要重開。告訴所屬人類：「同代號已在別的對話接手，這個對話停止待命。」/);
  assert.equal(neu.code, 0); assert.equal(neu.lines.at(-1), 'PENDING 1', '新的照常叫醒');
  const me = (await call(po.tok, '/api/me')).body;
  // 平台：被取代的回報不算叫醒次數（只算新的那次）
  const wk = await db.get('SELECT wake_count FROM participants WHERE id = ?', po.id);
  assert.equal(wk.wake_count, 1, '只算一次叫醒');
  assert.ok(me.participantId === po.id);
  assert.equal((await call(po.tok, '/api/me/online', 'POST', { sid: 'x' })).status, 400, 'sid 格式要對');
  assert.equal((await call(liu.token, '/api/me/online', 'POST', { sid: 'abcdefgh' })).status, 403, '人類不能登記');
  assert.equal((await call(po.tok, '/api/me/wake', 'POST')).status, 200, '舊版沒帶 sid 照常');

  // watcher 和等待腳本分開登記，互不擠掉（修正前共用 online:<AI>，watcher 自動重開會讓跑到一半的等待腳本 SUPERSEDED，反過來 watcher 自己停掉）
  {
    const ai = await mk('分開登記助手');
    const post = async (src, p, body) => { const r = await app(new Request('http://localhost' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.tok}`, 'X-Aigile-Source': src }, body: JSON.stringify(body) }), 'http://localhost'); return r.json(); };
    const online = (src, sid, extra = {}) => post(src, '/api/me/online', { sid, ...extra });
    const wake = async (src, sid, extra = {}) => !!(await post(src, '/api/me/wake', { sid, ...extra })).superseded;
    assert.equal((await online('wait', 'wait-0001')).previous, null, '等待腳本第一次登記');
    assert.equal((await online('watcher', 'watch-0001')).previous, null, 'watcher 登記不算「先前有別的對話」');
    assert.equal(await wake('wait', 'wait-0001'), false, 'A watcher 後登記，等待腳本照樣叫醒（不 SUPERSEDED）');
    assert.equal(await wake('watcher', 'watch-0001'), false, 'A watcher 照樣叫醒');
    assert.ok((await online('watcher', 'watch-0002')).previous, 'watcher 自動重開：知道先前有別的 watcher');
    assert.equal(await wake('wait', 'wait-0001'), false, 'A watcher 重開不會讓等待腳本 SUPERSEDED');
    assert.equal(await wake('watcher', 'watch-0001'), true, '舊的 watcher 照樣被取代');
    assert.equal((await online('wait', 'wait-0001')).previous, null, 'B 同一個 sid 重新登記不算「先前有別的對話」');
    assert.ok((await online('wait', 'wait-0002')).previous, 'B 真的有別的對話接手：照樣告訴它');
    assert.equal(await wake('watcher', 'watch-0002'), false, 'A 等待腳本換人不會讓 watcher 停掉');
    assert.equal(await wake('wait', 'wait-0001'), true, 'B 被別的對話接手：照樣 SUPERSEDED');
    assert.equal(await wake('wait', 'watch-0002', { slot: 'watcher' }), false, 'Codex 混合模式：等待腳本共用 watcher 的 sid，比對 watcher 那一筆');
    assert.equal(await wake('wait', 'watch-0001', { slot: 'watcher' }), true, 'Codex 混合模式：舊 watcher 的 sid 照樣被取代');
    // 改版前的舊資料（沒有 kind，可能是 watcher 寫的）不拿來判定，也不算「先前有別的對話」
    await db.run('UPDATE app_settings SET value = ? WHERE key = ?', JSON.stringify({ sid: 'legacy-0001', at: new Date().toISOString() }), `online:${ai.id}`);
    assert.equal(await wake('wait', 'wait-0003'), false, '舊資料不判定取代');
    assert.equal((await online('wait', 'wait-0003')).previous, null, '舊資料不算「先前有別的對話」');
  }

  // C：wait.pid 指到別的程式（PID 重用）＋檔案很舊 → 不算在跑，正常啟動；--replace 也絕不停它
  const pend = (await call(po.tok, '/api/notifications?status=pending')).body.items.map(n => n.notificationId); // 先清掉，等待腳本才不會一啟動就結束
  if (pend.length) await call(po.tok, '/api/notifications/ack', 'POST', { notificationIds: pend });
  const m3 = mkWork('PO', po.tok);
  const wp = path.join(m3.dir, 'wait.pid');
  fs.writeFileSync(wp, String(process.pid)); const oldT = new Date(Date.now() - 10 * 60_000); fs.utimesSync(wp, oldT, oldT);
  const w5 = runWait(m3.work, 'PO');
  await until(() => { try { return fs.readFileSync(wp, 'utf8').trim() === String(w5.p.pid); } catch { return false; } }, 8000, '舊檔被接手');
  assert.equal(w5.p.exitCode, null, '沒有誤判成 ALREADY_RUNNING');
  w5.p.kill(); await w5.done;
  fs.writeFileSync(wp, String(process.pid)); // 新鮮的檔、但程序不是等待腳本
  const w6 = runWait(m3.work, 'PO', ['--replace']);
  try { await until(() => /命令列對不上），不停它/.test(w6.out()), 20000, '命令列比對'); } catch (e) { console.log('w6:', w6.out(), w6.p.exitCode); throw e; }
  assert.ok(process.kill(process.pid, 0), '測試程序（假裝的瀏覽器）沒被停掉');
  w6.p.kill(); await w6.done;

  // B：同一個資料夾重開等待腳本沿用 wait.sid，不再印「先前有別的對話在待命」；別的資料夾（另一台、另一個視窗）照樣印
  {
    const m4 = mkWork('PO', po.tok), sidF = path.join(m4.dir, 'wait.sid');
    const a = runWait(m4.work, 'PO');
    await until(() => fs.existsSync(sidF), 8000, '寫 wait.sid');
    const sid1 = fs.readFileSync(sidF, 'utf8').trim();
    await sleep(1500);
    a.p.kill(); await a.done;
    const b = runWait(m4.work, 'PO');
    await sleep(2500);
    assert.doesNotMatch(b.out(), /先前有別的對話在待命/, '同資料夾重開不印假訊息：' + b.out());
    assert.equal(fs.readFileSync(sidF, 'utf8').trim(), sid1, '沿用同一個 sid');
    const m5 = mkWork('PO', po.tok);
    const c = runWait(m5.work, 'PO');
    await until(() => /先前有別的對話在待命/.test(c.out()), 8000, '別的資料夾照樣印：' + c.out());
    assert.notEqual(fs.readFileSync(path.join(m5.dir, 'wait.sid'), 'utf8').trim(), sid1, '別的資料夾有自己的 sid');
    for (const w of [b, c]) { w.p.kill(); await w.done; }
  }
  // hook：舊檔不算等待腳本在跑 → 提醒重開；新鮮的檔才算
  const hook = () => new Promise(res => {
    const p = spawn(process.execPath, [HOOK, 'stop'], { cwd: m3.work, env: { ...process.env, CLAUDE_PROJECT_DIR: m3.work, AIGILE_AGENT: '' }, stdio: 'pipe' });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.on('exit', () => res(o)); p.stdin.end('{}');
  });
  fs.rmSync(path.join(m3.dir, 'wait-reminded'), { force: true });
  fs.writeFileSync(wp, String(process.pid)); fs.utimesSync(wp, oldT, oldT);
  assert.match(await hook(), /等待腳本不在/, 'wait.pid 太舊（PID 可能被重用）→ 提醒重開');
  fs.rmSync(path.join(m3.dir, 'wait-reminded'), { force: true });
  fs.writeFileSync(wp, String(process.pid));
  assert.equal((await hook()).trim(), '', '新鮮的 wait.pid＋程序在 → 不擋');

  // B：建卡防重複
  const card = { project: '預設專案', title: '修登入頁的重複卡測試', ownerId: po.id, status: '待處理' };
  const c1 = (await call(po.tok, '/api/cards', 'POST', { ...card, requestId: 'conv-a-1' }));
  assert.equal(c1.status, 201);
  const same = await call(po.tok, '/api/cards', 'POST', { ...card, requestId: 'conv-a-1' });
  assert.ok(same.status === 200 && same.body.duplicate && same.body.cardId === c1.body.cardId, '同 requestId 回原卡（原本就有）');
  const c2 = await call(po.tok, '/api/cards', 'POST', { ...card, requestId: 'conv-b-1' });
  assert.ok(c2.status === 200 && c2.body.duplicate && c2.body.cardId === c1.body.cardId, '另一個對話（requestId 不同）同標題回原卡');
  assert.match(c2.body.warnings[0], /30 分鐘內你已建過同標題的卡/);
  const c3 = await call(po.tok, '/api/cards', 'POST', { ...card, title: '另一張卡', requestId: 'conv-b-2' });
  assert.ok(c3.status === 201 && c3.body.cardId !== c1.body.cardId, '標題不同照常建');
  const h1 = await call(liu.token, '/api/cards', 'POST', { ...card, ownerId: undefined, requestId: 'h-1' });
  const h2 = await call(liu.token, '/api/cards', 'POST', { ...card, ownerId: undefined, requestId: 'h-2' });
  assert.ok(h1.status === 201 && h2.status === 201 && h1.body.cardId !== h2.body.cardId, '人類不套用（可能真的要兩張）');

  // 文件：接入設定寫明兩個新結束碼
  const rc = await (await app(new Request('http://localhost/api/me/reconnect', { headers: { Authorization: `Bearer ${po.tok}` } }), 'http://localhost')).text();
  assert.match(rc, /ALREADY_RUNNING＝這台已有等待腳本在跑：不要再開[^\n]*才加 --replace；SUPERSEDED＝別處後來接上：停止待命、不重開/);
  console.log('single-online-test：全部通過');
} catch (e) {
  console.error('single-online-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const w of procs) try { w.p.kill(); } catch {}
  server.close();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
