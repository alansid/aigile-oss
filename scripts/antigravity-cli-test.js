// 驗收測試：「我的 AI」支援 Antigravity CLI（接入＋自動叫醒）
// 1. 接入設定 tool=antigravity：自動待命（watcher + aigile-antigravity.mjs）、每輪用 MCP 工具、寫明不用 --dangerously-skip-permissions、字數 ≤ 6,500
// 2. onboarding-link tool=antigravity 有一行啟動（--tool antigravity）
// 3. 接入檢查 --tool antigravity：技能放 .agents/skills；規則放 .agents/rules/aigile.md（不動既有 AGENTS.md 與自訂規則）；
//    前景 hook 合併進 .agents/hooks.json；~/.gemini/config/mcp_config.json 加 aigile（保留原有 MCP、先備份、已有不改、空檔可初始化、壞 JSON 不碰）；
//    watcher.env 的 WAKE_CMD 指向 aigile-antigravity.mjs、SKILL_TOOL=antigravity
// 4. 一行啟動 --tool antigravity：完成首次簽到與游標、開 watcher、以 -i 帶接入提示開前景 agy（帶 AIGILE_AGENT／AIGILE_FOREGROUND），關閉時清 foreground.lock；第二次重新接上
// 5. 背景喚醒 aigile-antigravity.mjs：
//    - 以 --sandbox --settings <檔> --output-format json -p <提示> 執行（不含 --dangerously-skip-permissions）
//    - settings.json 的 permissions.allow 與平台 MCP 工具清單完全一致、deny 含 git commit/push/merge
//    - 抓 conversation_id、下一輪帶 --conversation 接續、auto 模式滿 --every 次換新對話、fresh 每次換新、keep 一直接續、舊對話失效自動重開
//    - 模型不可用時回退預設並記 WARN
//    - --hook busy／idle 更新 foreground-state.json；watcher 前景忙碌時等空閒，空閒後背景跑
// 6. 技能同步狀態認得 antigravity；中英文介面與文件已同步；全部用暫存資料夾與假的 agy（隔離 ~/.gemini 與 ~/.aigile）
// 用法：node scripts/antigravity-cli-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { mcpDispatch } from '../src/mcp.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const root = f => fileURLToPath(new URL('../' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-agy-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-antigravity|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const GEMINI_HOME = process.env.AIGILE_GEMINI_HOME;
assert.ok(GEMINI_HOME && GEMINI_HOME.startsWith(os.tmpdir()) && path.resolve(GEMINI_HOME) !== path.join(os.homedir(), '.gemini'), 'AIGILE_GEMINI_HOME 一定是暫存資料夾');
const FAKE = fileURLToPath(new URL('./fake-antigravity.mjs', import.meta.url));
const FAKE_LOG = path.join(dataDir, 'agy.log');
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const ENV = { AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', CLAUDE_PROJECT_DIR: '', AIGILE_ANTIGRAVITY_BIN: FAKE, FAKE_AGY_LOG: FAKE_LOG, AIGILE_CLAUDE_BIN: '' };
const run = (file, args, cwd, extraEnv = {}) => new Promise(ok => execFile(process.execPath, [file, ...args], { cwd, timeout: 120_000, env: { ...process.env, ...ENV, ...extraEnv } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
const runLine = (cwd, code) => new Promise(ok => execFile(process.execPath, ['-e', code], { cwd, timeout: 180_000, env: { ...process.env, ...ENV } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
const len = s => [...s].length;
const pidFiles = [];
const killPid = pid => { try { if (pid > 0) process.kill(pid); } catch {} };

let watcherChild, mockServer;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '反重力', duties: '寫程式', style: '簡潔', autonomy: '實作、測試', mustConfirm: 'commit、push、部署', handoff: '完成後回報' })).body;
  let aiTok = await testToken(db, ai.participantId);
  const agent = (await call(aiTok, '/api/me/watcher-env')).body.agent;

  // 1. 接入設定
  const ob = async q => (await call(boss.token, `/api/my-ais/${ai.participantId}/onboarding?tool=antigravity${q || ''}`)).body.text;
  const first = await ob('&autoStandby=1');
  assert.match(first, /## 五、待命：Antigravity CLI/, '第五節是 Antigravity CLI 待命');
  const sec5 = first.split('## 五、')[1].split('## 六、')[0];
  assert.match(sec5, /--tool antigravity/, '接入檢查帶 --tool antigravity');
  assert.match(sec5, /~\/\.gemini\/config\/mcp_config\.json/, '寫出 MCP 設定檔位置');
  assert.match(sec5, /不用開 --dangerously-skip-permissions/, '寫明不用 --dangerously-skip-permissions');
  assert.match(sec5, /開著視窗才會處理/, '寫明開著視窗才會處理、關掉就等下次打開');
  const round = first.split('## 三、每一輪怎麼做')[1].split('## 四、')[0];
  for (const t of ['aigile_me', 'aigile_inbox', 'aigile_ack', 'aigile_memory']) assert.ok(round.includes(t), `每輪用 MCP 工具 ${t}`);
  assert.ok(len(first) <= 6500, `初次接入 ${len(first)} 字，要 ≤ 6,500`);
  aiTok = await testToken(db, ai.participantId);
  assert.equal((await call(aiTok, '/api/me/state', 'PUT', { currentTask: { title: '測試' } })).status, 200);
  const again = await ob('&autoStandby=1');
  assert.match(again, /（重新接上）/);
  assert.ok(len(again) <= 6500, `重接 ${len(again)} 字，要 ≤ 6,500`);
  aiTok = await testToken(db, ai.participantId);
  const self = (await call(aiTok, '/api/me/reconnect?tool=antigravity&start=1')).text;
  assert.match(self, /## 五、待命：Antigravity CLI/, 'AI 自己拿重新接上設定也認得 antigravity');
  assert.ok(!self.includes(aiTok), '重新接上設定不含 Token');
  console.log(`✓ 1 接入設定：自動待命、MCP 每輪、無 --dangerously-skip-permissions（初次 ${len(first)}／重接 ${len(again)} 字）`);

  // 2. 一行啟動連結
  const ai2 = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '反重力二號', duties: '寫程式', style: '簡潔', autonomy: '實作、測試', mustConfirm: 'commit、push、部署', handoff: '完成後回報' })).body;
  const ai2Tok = await testToken(db, ai2.participantId);
  const agent2 = (await call(ai2Tok, '/api/me/watcher-env')).body.agent;
  const link = await (await fetch(`${BASE}/api/my-ais/${ai2.participantId}/onboarding-link`, { method: 'POST', headers: { Authorization: `Bearer ${boss.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'antigravity', autoStandby: true, start: true }) })).json();
  assert.ok(link.startLine?.startsWith('node -e "'), 'Antigravity CLI 有一行啟動');
  assert.ok(link.startLine.includes("'--tool','antigravity'"), '一行啟動帶 --tool antigravity');
  const code = link.startLine.slice('node -e "'.length, -1);
  assert.ok(!/["$%`]/.test(code), '一行裡沒有雙引號、$、%、反引號');
  console.log('✓ 2 一行啟動帶 --tool antigravity');

  // 3. 接入檢查（原有 MCP、既有 AGENTS.md、既有 hooks.json、壞 JSON、0 byte 空檔、新建）
  const W = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(W, '.aigile', agent), { recursive: true });
  fs.writeFileSync(path.join(W, '.aigile', agent, '.token'), aiTok);
  fs.writeFileSync(path.join(W, 'AGENTS.md'), '# My Existing Agents Rules\nDo not overwrite me.\n');
  fs.mkdirSync(path.join(W, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(W, '.agents', 'hooks.json'), JSON.stringify({ 'my-custom-hook': { Stop: [{ type: 'command', command: 'echo ok' }] } }, null, 2));
  const cfgDir = path.join(GEMINI_HOME, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'mcp_config.json');
  const mine = { mcpServers: { docs: { serverUrl: 'https://example.invalid/mcp' } }, extra: { keep: true } };
  fs.writeFileSync(cfgFile, JSON.stringify(mine, null, 2));

  let r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity', '--mode', 'auto'], W);
  assert.equal(r.code, 0, r.out.slice(-800));
  assert.match(r.out, /✓ 技能（antigravity → \.agents\/skills）/, '共用技能放 .agents/skills：' + r.out.slice(-800));
  assert.match(r.out, /Antigravity CLI 一律走前景/, '印出 Antigravity 前景待命說明');
  assert.match(r.out, /已在 .*mcp_config\.json 加好通用的 aigile/, r.out.slice(-800));
  const wenvTxt = fs.readFileSync(path.join(W, '.aigile', agent, 'watcher.env'), 'utf8');
  assert.match(wenvTxt, new RegExp(`^WAKE_CMD=node \\.aigile/watcher/aigile-antigravity\\.mjs --agent ${agent} --mode auto$`, 'm'), 'WAKE_CMD 指向 aigile-antigravity.mjs');
  assert.match(wenvTxt, /^SKILL_TOOL=antigravity$/m, 'SKILL_TOOL 記成 antigravity');
  assert.ok(fs.existsSync(path.join(W, '.aigile', 'watcher', 'aigile-antigravity.mjs')), '下載並核對 aigile-antigravity.mjs');
  assert.equal(fs.readFileSync(path.join(W, 'AGENTS.md'), 'utf8'), '# My Existing Agents Rules\nDo not overwrite me.\n', '既有 AGENTS.md 原樣不動');
  assert.match(fs.readFileSync(path.join(W, '.agents', 'rules', 'aigile.md'), 'utf8'), /<!-- aigile-managed -->/, '建立 .agents/rules/aigile.md');
  const hooks = JSON.parse(fs.readFileSync(path.join(W, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(hooks['my-custom-hook'] && hooks['aigile-foreground'], 'hooks.json 保留原有 hook 並加上 aigile-foreground');
  assert.match(hooks['aigile-foreground'].PreInvocation[0].command, /--hook busy/);
  assert.match(hooks['aigile-foreground'].Stop[0].command, /--hook idle/);

  let j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(j.mcpServers.docs, mine.mcpServers.docs, '原有 MCP 不動');
  assert.deepEqual(j.extra, mine.extra, '其他設定不動');
  const mcpPath = path.join(process.env.AIGILE_HOME, '.aigile', 'aigile-mcp.mjs').replace(/\\/g, '/');
  assert.deepEqual(j.mcpServers.aigile, { command: 'node', args: [mcpPath] }, 'aigile 指向家目錄轉接腳本');
  assert.ok(!fs.readFileSync(cfgFile, 'utf8').includes(aiTok), 'MCP 設定不含 Token');
  const baks = () => fs.readdirSync(cfgDir).filter(f => f.startsWith('mcp_config.json.aigile-bak-'));
  assert.equal(baks().length, 1, '改之前有備份');

  // 重跑：已有就不改、不重備份
  r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity'], W);
  assert.match(r.out, /Antigravity CLI 已有 aigile（.*不改）/, '已有就不改');
  assert.equal(baks().length, 1, '沒改就不備份');

  // 壞 JSON 不碰
  fs.writeFileSync(cfgFile, '{ broken');
  r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity'], W);
  assert.equal(r.code, 0, '壞 JSON 不讓接入檢查失敗');
  assert.match(r.out, /不是合法的 JSON，沒有改它/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{ broken', '壞檔原樣保留');

  // 0 byte 空檔可正常寫入
  fs.writeFileSync(cfgFile, '');
  r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity'], W);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.aigile.command, 'node', '0 byte 空檔可寫入');

  // 沒有設定檔：新建
  fs.rmSync(cfgFile);
  r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity'], W);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.aigile.command, 'node', '沒有設定檔就新建');
  console.log('✓ 3 接入檢查 --tool antigravity：MCP、規則、hook、WAKE_CMD 與壞檔保護全過');

  // 4. 一行啟動（假的 agy）
  const S = fs.mkdtempSync(path.join(dataDir, 's-'));
  const D = path.join(S, '.aigile', agent2);
  pidFiles.push(path.join(D, 'watcher.pid'));
  r = await runLine(S, code);
  assert.equal(r.code, 0, r.out.slice(-1200));
  assert.ok(fs.existsSync(path.join(D, '.token')), '存好 Token');
  assert.ok(fs.existsSync(path.join(D, 'state.json')), '一行啟動保存首次游標 state.json');
  assert.ok(!fs.existsSync(path.join(D, 'foreground.lock')), '前景結束後清除 foreground.lock');
  assert.ok(!fs.existsSync(path.join(D, 'foreground-state.json')), '前景結束後清除 foreground-state.json');
  assert.match(r.out, /首次簽到已送達/, '一行啟動完成首次簽到');
  let calls = fakeCalls();
  assert.equal(calls.length, 1, '開了一次前景 agy');
  assert.equal(calls[0].agent, agent2, '前景帶 AIGILE_AGENT');
  assert.equal(calls[0].foreground, '1', '前景帶 AIGILE_FOREGROUND=1');
  assert.equal(calls[0].args[0], '-i', '前景用 -i 帶接入提示');
  assert.match(calls[0].args[1], /一行啟動已完成首次簽到/);
  assert.ok(!calls[0].args.join(' ').includes(ai2Tok), '參數裡不含 Token');
  // 第二次貼同一行：重新接上
  r = await runLine(S, code);
  assert.equal(r.code, 0, r.out.slice(-1200));
  calls = fakeCalls();
  assert.equal(calls.length, 2, '第二次開前景 agy');
  assert.match(calls[1].args[1], /重新接上/, '第二次是重新接上');
  assert.ok(fs.readFileSync(path.join(D, 'reconnect.md'), 'utf8').includes('## 五、待命：Antigravity CLI'), 'reconnect.md 是 Antigravity 版');
  console.log('✓ 4 一行啟動 --tool antigravity：簽到、開 watcher、前景 -i、第二次重接全過');

  // 5. 背景喚醒腳本 aigile-antigravity.mjs（權限設定、對話接續與輪換、模型回退、hook 與 watcher 前景忙碌等待）
  const WK = fs.mkdtempSync(path.join(dataDir, 'wk-'));
  const WKD = path.join(WK, '.aigile', agent);
  fs.mkdirSync(WKD, { recursive: true });
  fs.writeFileSync(path.join(WKD, '.token'), aiTok);
  const wakeScript = pub('aigile-antigravity.mjs');
  const beforeWakeCalls = fakeCalls().length;

  // 第 1 輪：開新對話
  const c1Id = '11111111-1111-4111-8111-111111111111';
  r = await run(wakeScript, ['--agent', agent, '--mode', 'auto', '--every', '2'], WK, { FAKE_AGY_CONVO: c1Id });
  assert.equal(r.code, 0, r.out);
  let wCalls = fakeCalls().slice(beforeWakeCalls);
  assert.equal(wCalls.length, 1);
  assert.ok(wCalls[0].args.includes('--sandbox'), '背景喚醒啟用 --sandbox');
  assert.ok(!wCalls[0].args.includes('--dangerously-skip-permissions'), '不用 --dangerously-skip-permissions');
  assert.equal(wCalls[0].args.at(-2), '-p', '-p 與提示放最後');
  assert.equal(wCalls[0].wakeAgent, agent, '帶 AIGILE_WAKE_AGENT');
  assert.equal(wCalls[0].foreground, '0', '背景帶 AIGILE_FOREGROUND=0');
  const stJson = JSON.parse(wCalls[0].settings);
  assert.equal(stJson.enableTerminalSandbox, true);
  assert.equal(stJson.toolPermission, 'proceed-in-sandbox');
  assert.equal(stJson.allowNonWorkspaceAccess, false);
  const catalog = await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { me: { role_key: 'PG' } });
  const expectedAllows = [...catalog.result.tools.map(({ name }) => `mcp(aigile/${name})`), 'mcp(aigile/aigile_use)'].sort();
  assert.deepEqual([...stJson.permissions.allow].sort(), expectedAllows, 'allow 清單與平台 MCP 工具一致');
  assert.ok(stJson.permissions.deny.includes('command(git push)') && stJson.permissions.deny.includes('command(git commit)'), 'deny 擋 git commit/push');

  // 第 2 輪：接續同一個對話 (--conversation c1Id)
  r = await run(wakeScript, ['--agent', agent, '--mode', 'auto', '--every', '2'], WK, { FAKE_AGY_CONVO: '22222222-2222-4222-8222-222222222222' });
  assert.equal(r.code, 0, r.out);
  wCalls = fakeCalls().slice(beforeWakeCalls);
  assert.equal(wCalls[1].args[wCalls[1].args.indexOf('--conversation') + 1], c1Id, '第 2 輪接續同一對話');

  // 第 3 輪：滿 --every=2 換新對話
  const c2Id = '33333333-3333-4333-8333-333333333333';
  r = await run(wakeScript, ['--agent', agent, '--mode', 'auto', '--every', '2'], WK, { FAKE_AGY_CONVO: c2Id });
  assert.equal(r.code, 0, r.out);
  wCalls = fakeCalls().slice(beforeWakeCalls);
  assert.ok(!wCalls[2].args.includes('--conversation'), '滿 2 次後開新對話');
  assert.equal(JSON.parse(fs.readFileSync(path.join(WKD, 'antigravity.json'), 'utf8')).conversationId, c2Id);

  // 模型不可用自動重試（不帶 --model）
  const beforeModel = fakeCalls().length;
  r = await run(wakeScript, ['--agent', agent, '--mode', 'fresh'], WK, {
    AIGILE_ANTIGRAVITY_MODEL: 'bad-model',
    AIGILE_ANTIGRAVITY_EFFORT: 'low',
    FAKE_AGY_ERROR: 'unknown model bad-model',
  });
  assert.equal(r.code, 0, r.out);
  const mCalls = fakeCalls().slice(beforeModel);
  assert.equal(mCalls.length, 2, '模型不可用時回退重試一次');
  assert.ok(mCalls[0].args.includes('--model') && !mCalls[1].args.includes('--model'));
  assert.match(fs.readFileSync(path.join(WKD, 'wake.log'), 'utf8'), /WARN 背景模型 bad-model/);
  assert.ok(!fs.readFileSync(path.join(WKD, 'wake.log'), 'utf8').includes(aiTok), 'wake.log 不洩漏 Token');

  // 前景 hook + watcher 忙碌等待測試
  // 5. Antigravity 視窗關著時不 spawn 背景 agy，記「視窗沒開，等開視窗再處理」並保留通知
  const WK2 = fs.mkdtempSync(path.join(dataDir, 'wk2-'));
  const WKD2 = path.join(WK2, '.aigile', agent);
  fs.mkdirSync(WKD2, { recursive: true });
  fs.writeFileSync(path.join(WKD2, '.token'), aiTok);
  let wakes = 0;
  mockServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/notifications/count') return res.end(JSON.stringify({ pending: 1 }));
    if (u.pathname === '/api/notifications') return res.end(JSON.stringify({ items: [{ notificationId: 'notif_agy_1', wake: true }] }));
    if (u.pathname === '/api/me/wake') { wakes++; return res.end(JSON.stringify({ ok: true })); }
    res.end(JSON.stringify({}));
  });
  await new Promise(ok => mockServer.listen(0, '127.0.0.1', ok));
  const wLogBefore = fakeCalls().length;
  watcherChild = spawn(process.execPath, [pub('watcher.mjs')], {
    cwd: WK2,
    windowsHide: true,
    env: {
      ...process.env, ...ENV,
      AIGILE_BASE: `http://127.0.0.1:${mockServer.address().port}`,
      AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '', AIGILE_ME: 'p_test',
      SUPABASE_URL: '', SUPABASE_KEY: '', WATCH_ONLY: '', HEARTBEAT_MIN: '0.02',
      BELL_FILE: path.join(WKD2, 'bell.json'), PID_FILE: path.join(WKD2, 'watcher.pid'),
      WAKE_MAX_PER_HOUR: '5', WAKE_MAX_PER_DAY: '5',
      WAKE_FOREGROUND: 'off',
      WAKE_CMD: `"${process.execPath}" "${wakeScript}" --agent ${agent} --mode keep --foreground off`,
    },
  });
  let wOut = '';
  watcherChild.stdout.setEncoding('utf8').on('data', d => { wOut += d; });
  const waitFor = async re => {
    for (let i = 0; i < 100; i++) {
      if (re.test(wOut)) return;
      await new Promise(ok => setTimeout(ok, 100));
    }
    assert.fail('等待 watcher 輸出逾時：' + wOut);
  };
  await waitFor(/視窗沒開，等開視窗再處理/);
  assert.equal(wakes, 0, '視窗關著時不呼叫 /api/me/wake');
  assert.equal(fakeCalls().length, wLogBefore, '視窗關著時不 spawn 背景 agy');
  assert.equal(fs.existsSync(path.join(WKD2, 'watcher.sid')), false, 'Antigravity 不寫 watcher.sid');
  watcherChild.kill();
  await new Promise(ok => watcherChild.once('close', ok));
  watcherChild = null;
  mockServer.close();
  mockServer = null;

  // 5b. 前景開著跑 aigile-wait.mjs 時只響門鈴叫前景（0 次背景 agy）；關窗期間來訊保留，再開視窗時照樣拿到
  const HYB = fs.mkdtempSync(path.join(dataDir, 'hyb-'));
  const HYBD = path.join(HYB, '.aigile', agent);
  fs.mkdirSync(HYBD, { recursive: true });
  fs.writeFileSync(path.join(HYBD, '.token'), aiTok);
  let hybPending = [], hybWaitReady = false;
  mockServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/me/online') return res.end(JSON.stringify({ ok: true }));
    if (u.pathname === '/api/me/wake') return res.end(JSON.stringify({ ok: true, superseded: false }));
    if (u.pathname === '/api/notifications/count') {
      if (req.headers['x-aigile-source'] === 'wait') hybWaitReady = true;
      return res.end(JSON.stringify({ pending: hybPending.length, wake: hybPending.length }));
    }
    if (u.pathname === '/api/notifications') return res.end(JSON.stringify({ items: hybPending, total: hybPending.length }));
    res.end(JSON.stringify({}));
  });
  await new Promise(ok => mockServer.listen(0, '127.0.0.1', ok));
  const hybBase = `http://127.0.0.1:${mockServer.address().port}`;
  fs.writeFileSync(path.join(HYBD, 'watcher.env'), `AIGILE_BASE=${hybBase}\nAIGILE_ME=p_test\nAIGILE_TOKEN_FILE=.aigile/${agent}/.token\nBELL_FILE=.aigile/${agent}/bell.json\nPID_FILE=.aigile/${agent}/watcher.pid\nWAKE_CMD="${process.execPath}" "${wakeScript}" --agent ${agent} --mode keep\n`);
  const hybCallsBefore = fakeCalls().length;
  watcherChild = spawn(process.execPath, [pub('watcher.mjs')], {
    cwd: HYB, windowsHide: true,
    env: {
      ...process.env, ...ENV,
      AIGILE_BASE: hybBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '', AIGILE_ME: 'p_test',
      SUPABASE_URL: '', SUPABASE_KEY: '', WATCH_ONLY: '', HEARTBEAT_MIN: '0.02',
      BELL_FILE: path.join(HYBD, 'bell.json'), PID_FILE: path.join(HYBD, 'watcher.pid'),
      WAKE_MAX_PER_HOUR: '5', WAKE_MAX_PER_DAY: '5',
      WAKE_CMD: `"${process.execPath}" "${wakeScript}" --agent ${agent} --mode keep`,
    },
  });
  let hybWOut = '';
  watcherChild.stdout.setEncoding('utf8').on('data', d => { hybWOut += d; });
  const waitHyb = async re => {
    for (let i = 0; i < 100; i++) { if (re.test(hybWOut)) return; await new Promise(ok => setTimeout(ok, 100)); }
    assert.fail('等待 watcher 輸出逾時：' + hybWOut);
  };
  await waitHyb(/沒有待處理，不喚醒/);
  const waitProc = spawn(process.execPath, [pub('aigile-wait.mjs'), '--agent', agent, '--look-sec', '1'], {
    cwd: HYB, windowsHide: true, env: { ...process.env, ...ENV, AIGILE_BASE: hybBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '' },
  });
  let waitOut = '';
  waitProc.stdout.setEncoding('utf8').on('data', d => { waitOut += d; });
  for (let i = 0; i < 50 && (!fs.existsSync(path.join(HYBD, 'wait.pid')) || !hybWaitReady); i++) await new Promise(ok => setTimeout(ok, 100));
  assert.ok(fs.existsSync(path.join(HYBD, 'wait.pid')) && hybWaitReady, '前景 wait.pid 已建立並進入等門鈴狀態');
  hybPending = [{ notificationId: 'notif_hyb_1', messageId: 'msg_hyb_1', wake: true, ask: true, preview: '前景測試', sender: { name: '昱志' } }];
  await waitHyb(/前景等待腳本執行中，已寫門鈴檔交由前景處理/);
  const waitExit = await new Promise(ok => waitProc.once('close', ok));
  assert.equal(waitExit, 0, '前景 aigile-wait 醒來並以 exit 0 結束：' + waitOut);
  assert.match(waitOut, /PENDING 1/, '前景拿到 PENDING 1');
  assert.equal(fakeCalls().length, hybCallsBefore, '前景開著時不 spawn 背景 agy');
  hybPending = [{ notificationId: 'notif_hyb_2', messageId: 'msg_hyb_2', wake: true, ask: true, preview: '關窗保留測試', sender: { name: '昱志' } }];
  await waitHyb(/視窗沒開，等開視窗再處理/);
  assert.equal(fakeCalls().length, hybCallsBefore, '關窗期間不 spawn 背景 agy');
  const waitProc2 = spawn(process.execPath, [pub('aigile-wait.mjs'), '--agent', agent, '--look-sec', '1'], {
    cwd: HYB, windowsHide: true, env: { ...process.env, ...ENV, AIGILE_BASE: hybBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '' },
  });
  let waitOut2 = '';
  waitProc2.stdout.setEncoding('utf8').on('data', d => { waitOut2 += d; });
  const waitExit2 = await new Promise(ok => waitProc2.once('close', ok));
  assert.equal(waitExit2, 0, '重開視窗後 wait 立即拿到保留的通知：' + waitOut2);
  assert.match(waitOut2, /PENDING 1/, '重開視窗拿到 PENDING 1');
  watcherChild.kill();
  await new Promise(ok => watcherChild.once('close', ok));
  watcherChild = null;
  mockServer.close();
  mockServer = null;

  // 5c. onboarding-link 不帶 --foreground，setup 清掉舊 --foreground／WAKE_FOREGROUND，Codex 維持原樣
  const fgLinkAgy = await (await fetch(`${BASE}/api/my-ais/${ai.participantId}/onboarding-link`, { method: 'POST', headers: { Authorization: `Bearer ${boss.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'antigravity', foreground: 'off', autoStandby: true, start: true }) })).json();
  assert.equal(fgLinkAgy.startLine.includes('--foreground'), false, 'Antigravity 一行啟動不帶 --foreground');
  const fgLinkCx = await (await fetch(`${BASE}/api/my-ais/${ai.participantId}/onboarding-link`, { method: 'POST', headers: { Authorization: `Bearer ${boss.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'codex', foreground: 'off', autoStandby: true, start: true }) })).json();
  assert.equal(fgLinkCx.startLine.includes('--foreground'), false, 'Codex 一行啟動不帶 --foreground');
  const envFileW = path.join(W, '.aigile', agent, 'watcher.env');
  fs.writeFileSync(envFileW, fs.readFileSync(envFileW, 'utf8').replace(/^WAKE_CMD=.*$/m, `WAKE_CMD=node .aigile/watcher/aigile-antigravity.mjs --agent ${agent} --mode auto --foreground off`) + 'WAKE_FOREGROUND=off\n');
  r = await run(pub('aigile-setup.mjs'), ['--agent', agent, '--base', BASE, '--tool', 'antigravity'], W);
  assert.equal(r.code, 0, r.out);
  const cleanedEnv = fs.readFileSync(envFileW, 'utf8');
  assert.match(cleanedEnv, new RegExp(`^WAKE_CMD=node \\.aigile/watcher/aigile-antigravity\\.mjs --agent ${agent} --mode auto$`, 'm'), 'setup 清掉舊 --foreground off');
  assert.doesNotMatch(cleanedEnv, /^WAKE_FOREGROUND=/m, 'setup 移除舊 WAKE_FOREGROUND');
  const CXD = fs.mkdtempSync(path.join(dataDir, 'cxoff-'));
  const CXAD = path.join(CXD, '.aigile', agent);
  fs.mkdirSync(CXAD, { recursive: true });
  fs.writeFileSync(path.join(CXAD, '.token'), aiTok);
  const fakeCxBin = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
  r = await run(pub('aigile-codex.mjs'), ['--agent', agent, '--mode', 'fresh', '--foreground', 'off'], CXD, { AIGILE_CODEX_BIN: fakeCxBin, CODEX_BIN: fakeCxBin, FAKE_CODEX_THREAD: '44444444-4444-4444-8444-444444444444' });
  assert.equal(r.code, 0, 'Codex 視窗關著時背景執行正常：' + r.out);

  // 5d. WAKE_CMD=echo WAKE（Claude Code）不寫／不沿用 watcher.sid，開兩個 wait 時舊的必須判成 superseded
  const CCD1 = fs.mkdtempSync(path.join(dataDir, 'cc1-'));
  const CCA1 = path.join(CCD1, '.aigile', agent);
  const CCD2 = fs.mkdtempSync(path.join(dataDir, 'cc2-'));
  const CCA2 = path.join(CCD2, '.aigile', agent);
  fs.mkdirSync(CCA1, { recursive: true });
  fs.mkdirSync(CCA2, { recursive: true });
  fs.writeFileSync(path.join(CCA1, '.token'), aiTok);
  fs.writeFileSync(path.join(CCA2, '.token'), aiTok);
  fs.writeFileSync(path.join(CCA1, 'watcher.sid'), 'stale-sid-must-be-ignored');
  let ccPending = 0, ccOnlineSids = [], ccWaitCount = 0;
  mockServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (u.pathname === '/api/me/online') {
      const prev = ccOnlineSids.at(-1);
      ccOnlineSids.push(body.sid);
      return res.end(JSON.stringify({ ok: true, ...(prev ? { previous: { at: new Date().toISOString() } } : {}) }));
    }
    if (u.pathname === '/api/me/wake') {
      const latest = ccOnlineSids.at(-1);
      return res.end(JSON.stringify({ ok: true, superseded: !!latest && body.sid !== latest, since: Date.now() }));
    }
    if (u.pathname === '/api/notifications/count') {
      if (req.headers['x-aigile-source'] === 'wait') ccWaitCount++;
      return res.end(JSON.stringify({ pending: ccPending, wake: ccPending }));
    }
    if (u.pathname === '/api/notifications') return res.end(JSON.stringify({ items: ccPending ? [{ notificationId: 'notif_cc_1', messageId: 'msg_cc_1', wake: true, preview: '測試' }] : [], total: ccPending }));
    res.end(JSON.stringify({}));
  });
  await new Promise(ok => mockServer.listen(0, '127.0.0.1', ok));
  const ccBase = `http://127.0.0.1:${mockServer.address().port}`;
  for (const d of [CCA1, CCA2]) {
    fs.writeFileSync(path.join(d, 'watcher.env'), `AIGILE_BASE=${ccBase}\nAIGILE_ME=p_test\nAIGILE_TOKEN_FILE=.aigile/${agent}/.token\nBELL_FILE=.aigile/${agent}/bell.json\nPID_FILE=.aigile/${agent}/watcher.pid\nWAKE_CMD=echo WAKE\n`);
  }
  watcherChild = spawn(process.execPath, [pub('watcher.mjs')], {
    cwd: CCD1, windowsHide: true,
    env: {
      ...process.env, ...ENV,
      AIGILE_BASE: ccBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '', AIGILE_ME: 'p_test',
      SUPABASE_URL: '', SUPABASE_KEY: '', WATCH_ONLY: '', HEARTBEAT_MIN: '0.5',
      BELL_FILE: path.join(CCA1, 'bell.json'), PID_FILE: path.join(CCA1, 'watcher.pid'),
      WAKE_CMD: 'echo WAKE',
    },
  });
  let ccWOut = '';
  watcherChild.stdout.setEncoding('utf8').on('data', d => { ccWOut += d; });
  for (let i = 0; i < 80 && !/沒有待處理，不喚醒/.test(ccWOut); i++) await new Promise(ok => setTimeout(ok, 100));
  assert.match(ccWOut, /沒有待處理，不喚醒/, 'echo WAKE watcher 正常啟動：' + ccWOut);
  assert.equal(fs.existsSync(path.join(CCA1, 'watcher.sid')), false, 'echo WAKE watcher 不寫 watcher.sid 且清掉舊檔');
  fs.writeFileSync(path.join(CCA1, 'watcher.sid'), 'stale-sid-must-be-ignored');
  const w1 = spawn(process.execPath, [pub('aigile-wait.mjs'), '--agent', agent, '--look-sec', '1'], {
    cwd: CCD1, windowsHide: true, env: { ...process.env, ...ENV, AIGILE_BASE: ccBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '' },
  });
  let w1Out = '';
  w1.stdout.setEncoding('utf8').on('data', d => { w1Out += d; });
  for (let i = 0; i < 50 && (ccOnlineSids.length < 1 || ccWaitCount < 1); i++) await new Promise(ok => setTimeout(ok, 100));
  assert.equal(ccOnlineSids.length, 1, '第一個 wait 自己登記 /api/me/online');
  assert.notEqual(ccOnlineSids[0], 'stale-sid-must-be-ignored', 'WAKE_CMD=echo WAKE 時 wait 不沿用 watcher.sid');
  const w2 = spawn(process.execPath, [pub('aigile-wait.mjs'), '--agent', agent, '--look-sec', '1'], {
    cwd: CCD2, windowsHide: true, env: { ...process.env, ...ENV, AIGILE_BASE: ccBase, AIGILE_TOKEN: 'test-token', AIGILE_TOKEN_FILE: '' },
  });
  let w2Out = '';
  w2.stdout.setEncoding('utf8').on('data', d => { w2Out += d; });
  for (let i = 0; i < 50 && (ccOnlineSids.length < 2 || ccWaitCount < 2); i++) await new Promise(ok => setTimeout(ok, 100));
  assert.equal(ccOnlineSids.length, 2, '第二個 wait 登記新的 SID');
  assert.notEqual(ccOnlineSids[0], ccOnlineSids[1], '兩個 wait 的 SID 不同');
  ccPending = 1;
  const bellNow = new Date().toISOString();
  fs.writeFileSync(path.join(CCA1, 'bell.json'), JSON.stringify({ v: 1, seq: 99, pending: 1, bellAt: bellNow, heartbeatAt: bellNow, pid: watcherChild.pid }));
  fs.writeFileSync(path.join(CCA2, 'bell.json'), JSON.stringify({ v: 1, seq: 99, pending: 1, bellAt: bellNow, heartbeatAt: bellNow, pid: watcherChild.pid }));
  const [w1Code, w2Code] = await Promise.all([new Promise(ok => w1.once('close', ok)), new Promise(ok => w2.once('close', ok))]);
  assert.equal(w1Code, 51, '舊 wait 必須收到 SUPERSEDED（51）：' + w1Out);
  assert.match(w1Out, /SUPERSEDED/, '舊 wait 輸出 SUPERSEDED');
  assert.equal(w2Code, 0, '新 wait 正常接手（0）：' + w2Out);
  assert.match(w2Out, /PENDING 1/, '新 wait 拿到 PENDING 1');
  watcherChild.kill();
  await new Promise(ok => watcherChild.once('close', ok));
  watcherChild = null;
  mockServer.close();
  mockServer = null;
  console.log('✓ 5 背景喚醒、前景忙碌等待、混合模式、G（auto／off 雙模式含 Codex）與 Claude Code superseded 保護：全過');

  // 6. 技能同步狀態認得 antigravity；中英文文件與介面同步
  const st = await db.get('SELECT tool FROM skill_syncs WHERE ai_id = ?', ai.participantId);
  assert.equal(st?.tool, 'antigravity', '同步狀態記成 antigravity');
  assert.ok(fs.readFileSync(root('docs/connect-your-ai.md'), 'utf8').includes('Antigravity CLI'));
  assert.ok(fs.readFileSync(root('docs/connect-your-ai.en.md'), 'utf8').includes('Antigravity CLI'));
  assert.ok(fs.readFileSync(pub('i18n/en.js'), 'utf8').includes('Antigravity CLI'));
  console.log('antigravity-cli-test：全部通過');
} finally {
  if (watcherChild && watcherChild.exitCode === null) {
    watcherChild.kill();
    await new Promise(ok => watcherChild.once('close', ok));
  }
  mockServer?.close();
  for (const f of pidFiles) { try { killPid(Number(fs.readFileSync(f, 'utf8'))); } catch {} }
  server.close();
  db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
