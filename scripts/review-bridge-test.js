// 審查者測試：aigile-mcp.mjs 轉接腳本替 aigile_review_request 讀本機 diff 檔（diffPath）
// 另有 readDiffFile 單元測試（短讀、開檔後變大、fd 型別與大小、Windows 大小寫、路徑邊界）
// aigile_review_request（自動核准）只收版本與說明；附 diff 用 aigile_review_diff（要人核准），watcher 叫醒的回合兩種附件都在轉接腳本擋下、內容不送出
// 讀檔前：要有 declared: true、專案開了「送審可以上傳 diff」；只讀工作區內的 .diff／.patch／.txt，不碰 .aigile、.git，最多 2 MB
// 本機暫存資料庫＋本機伺服器，不連正式站。用法：node scripts/review-bridge-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rvbridge-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const seen = []; // 伺服器收到的每個請求內容：用來確認被擋的 diff 沒有送出去
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  seen.push(req.url + '\n' + Buffer.concat(chunks).toString('utf8'));
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let bridge;
try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mkAi = async (name, tool) => {
    const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    await db.run('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tool);
    return a;
  };
  const pg = await mkAi('示範PG', 'claude');
  await mkAi('示範Codex', 'codex');
  const SET = `/api/projects/${encodeURIComponent('預設專案')}/review-settings`;
  await call(liu.token, SET, 'PUT', { cards: 'code', diffUpload: false });
  const K = (await call(pg.token, '/api/cards', 'POST', { project: '預設專案', title: '報價單匯出加上幣別欄', ownerId: pg.participantId, requestId: 'c1' })).body.cardId;

  // 工作區：.aigile/<代號>/.token＋watcher.env，轉接腳本從工作區啟動
  const wd = path.join(dataDir, 'ws'), AG = 'PG_TEST';
  fs.mkdirSync(path.join(wd, '.aigile', 'watcher'), { recursive: true }); fs.mkdirSync(path.join(wd, '.aigile', AG));
  fs.copyFileSync(new URL('../public/aigile-mcp.mjs', import.meta.url), path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs'));
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), pg.token + '\n');
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), `AIGILE_BASE=${BASE}\nAIGILE_ME=${pg.participantId}\n`);
  const DIFF = 'diff --git a/x b/x\n+幣別\n';
  fs.writeFileSync(path.join(wd, 'ok.diff'), DIFF);
  fs.writeFileSync(path.join(wd, 'big.diff'), Buffer.alloc(2 * 1048576 + 1, 0x61));
  fs.writeFileSync(path.join(wd, 'code.js'), 'x');
  fs.writeFileSync(path.join(wd, 'bin.diff'), Buffer.from([0x61, 0, 0x62]));
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'leak.txt'), 'token');
  fs.writeFileSync(path.join(dataDir, 'outside.diff'), DIFF);

  // 單元測試 readDiffFile：短讀要讀完整、開檔後變大要擋、型別與大小看 fd、Windows 保留目錄不分大小寫、路徑邊界
  process.env.AIGILE_MCP_NO_MAIN = '1';
  const { readDiffFile } = await import(new URL('../public/aigile-mcp.mjs', import.meta.url).href);
  const u = path.join(dataDir, 'unit');
  fs.mkdirSync(path.join(u, '.Git'), { recursive: true }); fs.mkdirSync(path.join(u, '.AIGILE'), { recursive: true }); fs.mkdirSync(path.join(u, 'sub'));
  const LONG = 'diff --git a/x b/x\n' + '+一行改動\n'.repeat(30);
  fs.writeFileSync(path.join(u, 'long.diff'), LONG);
  fs.writeFileSync(path.join(u, '.Git', 'x.diff'), LONG); fs.writeFileSync(path.join(u, '.AIGILE', 'y.diff'), LONG); fs.writeFileSync(path.join(u, '..notes.diff'), LONG);
  const shortRead = { ...fs, readSync: (fd, buf, off, len, pos) => fs.readSync(fd, buf, off, Math.min(len, 7), pos) };
  assert.equal(readDiffFile(u, 'long.diff', { io: shortRead }), LONG, '短讀：一次只回 7 位元組也要讀到 EOF、內容完整');
  const growing = { ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), isFile: () => true, size: 5 }) };
  assert.throws(() => readDiffFile(u, 'long.diff', { io: growing, max: 16 }), /超過 2 MB/, '開檔時看起來小、讀的時候變大：讀到超過上限就擋');
  assert.throws(() => readDiffFile(u, 'long.diff', { max: 16 }), /超過 2 MB/, 'fd 的大小超過上限：不讀');
  const notFile = { ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), isFile: () => false }) };
  assert.throws(() => readDiffFile(u, 'long.diff', { io: notFile }), /一般檔案/, '型別看開啟的 fd');
  for (const p of ['.Git/x.diff', '.AIGILE/y.diff', 'sub/../.Git/x.diff']) assert.throws(() => readDiffFile(u, p, { win: true }), /不能讀 \.aigile 或 \.git/, 'Windows 不分大小寫：' + p);
  assert.equal(readDiffFile(u, '..notes.diff'), LONG, '檔名開頭是兩個點：仍在工作區內');
  assert.throws(() => readDiffFile(u, '../outside.diff'), /要在工作區資料夾裡/, '.. 跳出工作區');
  assert.throws(() => readDiffFile(u, path.join(dataDir, 'outside.diff')), /要在工作區資料夾裡/, '絕對路徑在工作區外');
  assert.throws(() => readDiffFile(u, 'no-such.diff'), /讀不到 diff 檔/, '不存在');

  // 轉接腳本兩種入口：一般對話（要人核准）、watcher 叫醒的回合（AIGILE_WAKE_AGENT）
  const open = env => {
    const p = spawn(process.execPath, [path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs'), '--agent', AG], { cwd: wd, env: { ...process.env, AIGILE_MCP_NO_MAIN: '', ...env } }); // 單元測試設的開關不要帶給真的轉接腳本
    let out = '', err = '', rid = 0;
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    const rpc = async (method, params) => {
      const id = ++rid;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const end = Date.now() + 15000;
      for (;;) {
        const hit = out.split('\n').slice(0, -1).filter(Boolean).map(l => JSON.parse(l)).find(l => l.id === id);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`轉接腳本沒回第 ${id} 則：${err}`);
        await new Promise(r => setTimeout(r, 30));
      }
    };
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: { cardId: K, version: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', ...args } });
      const text = r.result?.content?.[0]?.text || r.error?.message || '';
      return r.result?.isError || r.error ? { error: text } : JSON.parse(text);
    };
    return { p, rpc, call };
  };
  const manual = open({});
  bridge = manual.p;
  await manual.rpc('initialize', { protocolVersion: '2025-06-18' });
  const send = args => manual.call('aigile_review_diff', args);
  const docs = async () => (await call(liu.token, `/api/projects/${encodeURIComponent('預設專案')}/docs`)).body.items.length;
  const MARK = 'WATCHER-SECRET-' + Date.now();
  fs.writeFileSync(path.join(wd, 'secret.diff'), 'diff --git a/y b/y\n+' + MARK + '\n');
  const leaked = () => seen.some(x => x.includes(MARK));

  // 送審（自動核准）只收中繼資料：帶 diff／diffPath 在轉接腳本就擋，內容不送出
  assert.match((await manual.call('aigile_review_request', { note: 'x', diff: 'diff --git\n+' + MARK })).error, /只送版本與說明/, '送審帶 diff 文字：轉接腳本擋');
  assert.match((await manual.call('aigile_review_request', { note: 'x', diffPath: 'secret.diff' })).error, /只送版本與說明/, '送審帶 diffPath：轉接腳本擋、不讀檔');
  assert.ok(!leaked(), '送審帶的 diff 沒送到伺服器');

  // aigile_review_diff：專案沒開時，就算檔案不存在也先回「沒有開」（還沒讀檔）
  assert.match((await send({ diffPath: 'no-such.diff', declared: true })).error, /沒有開「送審可以上傳 diff」/, '沒開上傳：讀檔前就擋');
  await call(liu.token, SET, 'PUT', { diffUpload: true });
  assert.match((await send({ diffPath: 'no-such.diff', declared: false })).error, /declared: true/, '沒聲明：讀檔前就擋');
  assert.match((await send({ diffPath: path.join(dataDir, 'outside.diff'), declared: true })).error, /要在工作區資料夾裡/, '工作區外的檔案不讀');
  assert.match((await send({ diffPath: '../outside.diff', declared: true })).error, /要在工作區資料夾裡/, '用 .. 跳出工作區也不讀');
  assert.match((await send({ diffPath: `.aigile/${AG}/leak.txt`, declared: true })).error, /不能讀 \.aigile 或 \.git/, '.aigile（Token 所在）不讀');
  assert.match((await send({ diffPath: 'code.js', declared: true })).error, /只收 \.diff、\.patch、\.txt/, '副檔名不對不讀');
  assert.match((await send({ diffPath: 'big.diff', declared: true })).error, /超過 2 MB/, '超過 2 MB 不送');
  assert.match((await send({ diffPath: 'bin.diff', declared: true })).error, /不是文字檔/, '二進位檔不送');
  assert.equal(await docs(), 0, '以上都沒有上傳任何檔案');

  // watcher 叫醒的回合：送審只帶版本與說明可以；兩種附件（diff 文字、diffPath）都在轉接腳本擋下，內容不送出
  const woke = open({ AIGILE_WAKE_AGENT: AG });
  await woke.rpc('initialize', { protocolVersion: '2025-06-18' });
  try {
    assert.match((await woke.call('aigile_review_diff', { diff: 'diff --git\n+' + MARK, declared: true })).error, /watcher 叫醒的回合不上傳程式差異/, 'watcher：diff 文字擋下');
    assert.match((await woke.call('aigile_review_diff', { diffPath: 'secret.diff', declared: true })).error, /watcher 叫醒的回合不上傳程式差異/, 'watcher：diffPath 擋下、不讀檔');
    assert.match((await woke.call('aigile_review_request', { note: 'x', diff: 'diff --git\n+' + MARK })).error, /只送版本與說明/, 'watcher：送審夾 diff 也擋');
    assert.ok(!leaked(), 'watcher 回合被擋的 diff 沒送到伺服器');
    assert.equal(await docs(), 0, 'watcher 回合沒有上傳任何檔案');
    const plain = await woke.call('aigile_review_request', { note: '報價單匯出多一欄幣別；跑了 export-test，全過。' });
    assert.ok(plain.messageId && !plain.diffDocId, 'watcher：只帶版本與說明的送審可以：' + JSON.stringify(plain));
  } finally { const closed = new Promise(r => woke.p.once('close', r)); woke.p.kill(); await closed; }

  // 一般對話（有人核准）：先上傳 diff 拿 diffDocId，再帶進送審
  const up = await send({ diffPath: 'ok.diff', declared: true });
  assert.ok(up.diffDocId, '工作區內的 diff 檔：讀檔、上傳：' + JSON.stringify(up));
  assert.equal(await docs(), 1, '存進專案文件');
  const sent = await manual.call('aigile_review_request', { note: '附 diff', diffDocId: up.diffDocId });
  assert.equal(sent.diffDocId, up.diffDocId, '送審帶 diffDocId');
  console.log('review-bridge-test：全部通過（送審只收版本與說明、附 diff 另一個工具、watcher 回合兩種附件都擋且不送出、讀檔前檢查聲明與專案開關、只讀工作區內的 diff 檔、2 MB 上限）');
} catch (e) {
  console.error('review-bridge-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  if (bridge && bridge.exitCode === null) { const closed = new Promise(r => bridge.once('close', r)); bridge.kill(); await closed; }
  await new Promise(r => server.close(r));
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
