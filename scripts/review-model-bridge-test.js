// 測試：接上時回報模型
// A. 轉接腳本 aigile_use 帶 model：選身分、回報模型（平台記 via=checkin）；格式不對照實說「回報模型失敗」、身分照選；沒帶就不報
// B. 接入檢查 aigile-setup.mjs --model：回報模型；沒帶就不報
// 本機暫存資料庫＋本機伺服器，不連正式站；家目錄改到暫存資料夾。用法：node scripts/review-model-bridge-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rvmodelb-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
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
const home = path.join(dataDir, 'home'); fs.mkdirSync(home);
const ENV = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), AIGILE_HOME: path.join(home, '.aigile'), AIGILE_MCP_NO_MAIN: '', AIGILE_AGENT: '', AIGILE_WAKE_AGENT: undefined, AIGILE_BASE: '', AIGILE_TOKEN: '' };
const envOf = extra => { const e = { ...process.env, ...ENV, ...extra }; for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; };
const modelOf = async id => db.get('SELECT model, via FROM ai_models WHERE ai_id = ?', id);
let bridge;
try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AG = (await call(ai.token, '/api/me/watcher-env')).body.agent;

  // ---------- A 轉接腳本 aigile_use ----------
  const wd = path.join(dataDir, 'ws');
  fs.mkdirSync(path.join(wd, '.aigile', 'watcher'), { recursive: true }); fs.mkdirSync(path.join(wd, '.aigile', AG));
  fs.copyFileSync(new URL('../public/aigile-mcp.mjs', import.meta.url), path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs'));
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), ai.token + '\n');
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), `AIGILE_BASE=${BASE}\n`);
  const open = () => {
    const p = spawn(process.execPath, [path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs')], { cwd: wd, env: envOf({}) }); // 通用版（不帶 --agent）
    let out = '', err = '', rid = 0;
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    const rpc = async (method, params) => {
      const id = ++rid;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      for (const end = Date.now() + 15000; ;) {
        const hit = out.split('\n').slice(0, -1).filter(Boolean).map(l => JSON.parse(l)).find(l => l.id === id);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`轉接腳本沒回第 ${id} 則：${err}`);
        await new Promise(r => setTimeout(r, 30));
      }
    };
    const use = async args => { const r = await rpc('tools/call', { name: 'aigile_use', arguments: args }); return { text: r.result.content[0].text, isError: !!r.result.isError }; };
    return { p, rpc, use };
  };
  const b = open(); bridge = b.p;
  await b.rpc('initialize', { protocolVersion: '2025-06-18' });
  let r = await b.use({ agent: AG });
  assert.ok(!r.isError && !/模型/.test(r.text), 'A aigile_use 沒帶 model：不回報：' + r.text);
  assert.equal(await modelOf(ai.participantId), undefined, 'A 沒帶 model 平台沒有紀錄');
  r = await b.use({ agent: AG, model: 'claude-opus-5-5' });
  assert.match(r.text, /^目前身分：.+已回報模型 claude-opus-5-5。$/, 'A aigile_use 帶 model：回報成功：' + r.text);
  assert.deepEqual({ ...(await modelOf(ai.participantId)) }, { model: 'claude-opus-5-5', via: 'checkin' }, 'A 平台記下模型（接上）');
  r = await b.use({ agent: AG, model: 'bad model!' });
  assert.ok(!r.isError && /回報模型失敗：model 是你目前用的完整模型代號/.test(r.text), 'A 格式不對：照實說失敗、身分照舊：' + r.text);
  const list = (await b.rpc('tools/list', {})).result.tools;
  const use = list.find(t => t.name === 'aigile_use');
  assert.ok(!use || use.inputSchema.properties.model, 'A aigile_use 的參數有 model');
  b.p.kill(); bridge = null;
  // 資料夾有兩隻 AI 時，第一次選身分也一起回報
  const ai2 = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範PG2', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AG2 = (await call(ai2.token, '/api/me/watcher-env')).body.agent;
  fs.mkdirSync(path.join(wd, '.aigile', AG2));
  fs.writeFileSync(path.join(wd, '.aigile', AG2, '.token'), ai2.token + '\n');
  fs.writeFileSync(path.join(wd, '.aigile', AG2, 'watcher.env'), `AIGILE_BASE=${BASE}\n`);
  const b2 = open(); bridge = b2.p;
  await b2.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await b2.use({ agent: AG2, model: 'gpt-5.1-codex' });
  assert.match(r.text, /^已選定並鎖定 .+已回報模型 gpt-5\.1-codex。$/, 'A 兩隻 AI：選身分時一起回報：' + r.text);
  assert.equal((await modelOf(ai2.participantId)).model, 'gpt-5.1-codex', 'A 記在選定的那隻');
  b2.p.kill(); bridge = null;

  // ---------- B 接入檢查 --model ----------
  const run = args => new Promise(resolve => execFile(process.execPath, [new URL('../public/aigile-setup.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--agent', AG, '--base', BASE, '--tool', 'other', '--skills-only', ...args],
    { cwd: wd, env: envOf({}) }, (e, out, err) => resolve({ code: e ? e.code : 0, out: out + err })));
  await db.run('DELETE FROM ai_models');
  let s = await run([]);
  assert.equal(s.code, 0, 'B 沒帶 --model 照常完成：' + s.out);
  assert.ok(!/模型/.test(s.out), 'B 沒帶 --model 不提模型');
  assert.equal(await modelOf(ai.participantId), undefined, 'B 沒帶 --model 不回報');
  s = await run(['--model', 'claude-sonnet-5-5']);
  assert.equal(s.code, 0, 'B 帶 --model 完成：' + s.out);
  assert.match(s.out, /✓ 模型：claude-sonnet-5-5/, 'B 印出回報的模型');
  assert.deepEqual({ ...(await modelOf(ai.participantId)) }, { model: 'claude-sonnet-5-5', via: 'checkin' }, 'B 平台記下模型（接上）');
  s = await run(['--model', 'bad model!']);
  assert.equal(s.code, 0, 'B 模型格式不對不影響接入：' + s.out);
  assert.match(s.out, /! 模型沒回報成功（HTTP 400）/, 'B 照實說沒回報成功');
  assert.ok(!fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.codex')), 'B 沒有寫到家目錄');

  console.log('review-model-bridge-test：全部通過（aigile_use 帶 model 回報、格式不對照實說、兩隻 AI 選身分時回報、接入檢查 --model 回報、沒帶就不報）');
} finally {
  bridge?.kill();
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
