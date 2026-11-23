// 驗收測試：「我的 AI」支援 GitHub Copilot CLI（目前只接入，不自動叫醒）
// 1. 接入設定 tool=copilot：手動待命（不開 watcher、不開等待腳本）、每輪用 MCP 工具、寫 50 次提醒、字數 ≤ 6,500
// 2. onboarding-link tool=copilot 有一行啟動（--tool copilot）
// 3. 接入檢查 --tool copilot：技能放 .agents/skills；~/.copilot/mcp-config.json 加 aigile（保留原有 MCP、先備份、已有不改、壞 JSON 不碰）；不印 watcher 指令
// 4. 一行啟動 --tool copilot：用假的 copilot 執行檔，帶 AIGILE_AGENT、--additional-mcp-config（只放代號、沒有 Token）、-i 接入提示；不開 watcher
// 5. 網頁：工具多一個 Copilot CLI、有一行啟動、寫明不自動叫醒與每月 50 次
// 全部用暫存資料夾與假的 copilot（COPILOT_HOME 隔離，不碰真的 ~/.copilot、~/.aigile）
// 用法：node scripts/copilot-cli-test.js
import { stopServer } from './test-process.js';
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { ROLES } from '../src/roles.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-copilot-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
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
const api = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const COPILOT_HOME = process.env.COPILOT_HOME;
assert.ok(COPILOT_HOME && COPILOT_HOME.startsWith(os.tmpdir()) && path.resolve(COPILOT_HOME) !== path.join(os.homedir(), '.copilot'), 'COPILOT_HOME 一定是暫存資料夾');
// 假的 copilot：記下參數、AIGILE_AGENT、--additional-mcp-config 指的檔案內容
const FAKE = path.join(dataDir, 'fake-copilot.mjs'), FAKE_LOG = path.join(dataDir, 'copilot.log');
fs.writeFileSync(FAKE, `import fs from 'node:fs';
const a = process.argv.slice(2), i = a.indexOf('--additional-mcp-config');
const cfg = i >= 0 && a[i + 1].startsWith('@') ? fs.readFileSync(a[i + 1].slice(1), 'utf8') : null;
fs.appendFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ args: a, agent: process.env.AIGILE_AGENT || '', cfg }) + '\\n');
`);
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const ENV = { AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', CLAUDE_PROJECT_DIR: '', AIGILE_COPILOT_BIN: FAKE, AIGILE_CLAUDE_BIN: '' };
const run = (file, args, cwd) => new Promise(ok => execFile(process.execPath, [file, ...args], { cwd, timeout: 120_000, env: { ...process.env, ...ENV } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
const runLine = (cwd, code) => new Promise(ok => execFile(process.execPath, ['-e', code], { cwd, timeout: 180_000, env: { ...process.env, ...ENV } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
const len = s => [...s].length;
const killPid = pid => { try { if (pid > 0) process.kill(pid); } catch {} };
const pidFiles = [];

try {
  const boss = (await api(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const r0 = ROLES.find(x => x.key === 'PG');
  const mkAi = async name => (await api(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r0.role, name, duties: r0.duties, style: r0.style, autonomy: r0.autonomy, mustConfirm: r0.mustConfirm, handoff: r0.handoff })).body;
  const ai = await mkAi('副駕');
  const agent = (await api(await testToken(db, ai.participantId), '/api/me/watcher-env')).body.agent;

  // 1. 接入設定
  const ob = async () => (await api(boss.token, `/api/my-ais/${ai.participantId}/onboarding?tool=copilot&autoStandby=1`)).body.text;
  const first = await ob();
  assert.match(first, /（初次接入）/);
  assert.match(first, /## 五、待命：手動（Copilot CLI/, '第五節是 Copilot CLI 手動待命');
  const sec5 = first.split('## 五、')[1].split('## 六、')[0];
  assert.match(sec5, /不開 watcher、不開等待腳本/, '寫明不開 watcher、不開等待腳本');
  assert.match(sec5, /免費版每月 50 次/, '提醒免費版每月 50 次');
  assert.match(sec5, /--tool copilot/, '接入檢查帶 --tool copilot');
  assert.match(sec5, /~\/\.copilot\/mcp-config\.json/, '寫出 MCP 設定檔位置');
  assert.doesNotMatch(sec5, /aigile-wait\.mjs|watcher\.mjs/, '第五節沒有 watcher、等待腳本的啟動指令');
  const round = first.split('## 三、每一輪怎麼做')[1].split('## 四、')[0];
  for (const t of ['aigile_me', 'aigile_inbox', 'aigile_ack', 'aigile_memory']) assert.ok(round.includes(t), `每輪用 MCP 工具 ${t}`);
  assert.match(first, /說明你是手動模式（第五節），沒有在背景待命/, '回報手動模式（勾了自動待命也一樣）');
  assert.match(first, /請從第二節第 1 步開始，做到第 9 步。$/, '初次接入做到第 9 步，不用先問背景能力');
  assert.doesNotMatch(first, /交給你的卡直接做到待 commit/, '不是 Codex 的無人叫醒回合');
  assert.ok(len(first) <= 6500, `初次接入 ${len(first)} 字，要 ≤ 6,500`);
  const aiTok = await testToken(db, ai.participantId);
  assert.equal((await api(aiTok, '/api/me/state', 'PUT', { currentTask: { title: '測試' } })).status, 200);
  const again = await ob();
  assert.match(again, /（重新接上）/);
  assert.match(again, /之後等 王大明 叫你再跑一輪/, '重接版也是手動');
  assert.match(again, /4\. aigile_me 核對身分/, '重接版用 MCP 核對身分');
  assert.ok(len(again) <= 6500, `重接 ${len(again)} 字，要 ≤ 6,500`);
  const aiTok2 = await testToken(db, ai.participantId);
  const self = (await api(aiTok2, '/api/me/reconnect?tool=copilot&start=1')).text;
  assert.match(self, /## 五、待命：手動（Copilot CLI/, 'AI 自己拿重新接上設定也認得 copilot');
  assert.ok(!self.includes(aiTok2), '重新接上設定不含 Token');
  console.log(`✓ 1 接入設定：手動待命、MCP 每輪、50 次提醒（初次 ${len(first)}／重接 ${len(again)} 字）`);

  // 2. 一行啟動連結（另一隻還沒接過的 AI：第一隻已有工作記憶，會是重新接上）
  const ai2 = await mkAi('副駕二號');
  const agent2 = (await api(await testToken(db, ai2.participantId), '/api/me/watcher-env')).body.agent;
  const link = (await api(boss.token, `/api/my-ais/${ai2.participantId}/onboarding-link`, 'POST', { tool: 'copilot', autoStandby: true, start: true })).body;
  assert.ok(link.startLine?.startsWith('node -e "'), 'Copilot CLI 有一行啟動');
  assert.ok(link.startLine.includes("'--tool','copilot'"), '一行啟動帶 --tool copilot');
  const code = link.startLine.slice('node -e "'.length, -1);
  assert.ok(!/["$%`]/.test(code), '一行裡沒有雙引號、$、%、反引號');
  console.log('✓ 2 一行啟動帶 --tool copilot');

  // 3. 接入檢查（先放一份使用者原有的 MCP 設定）
  const W = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(W, '.aigile', agent), { recursive: true });
  const tok3 = await testToken(db, ai.participantId);
  fs.writeFileSync(path.join(W, '.aigile', agent, '.token'), tok3);
  pidFiles.push(path.join(W, '.aigile', agent, 'watcher.pid'));
  const cfgFile = path.join(COPILOT_HOME, 'mcp-config.json');
  const mine = { mcpServers: { github: { type: 'http', url: 'https://example.invalid/mcp', tools: ['*'] } }, extra: { keep: true } };
  fs.writeFileSync(cfgFile, JSON.stringify(mine, null, 2));
  const setupArgs = ['--agent', agent, '--base', BASE, '--tool', 'copilot'];
  let r = await run(pub('aigile-setup.mjs'), setupArgs, W);
  assert.equal(r.code, 0, r.out.slice(-800));
  assert.match(r.out, /✓ 技能（copilot → \.agents\/skills）/, '共用技能放 .agents/skills（Copilot CLI 會讀）：' + r.out.slice(-800));
  assert.match(r.out, /Copilot CLI 目前不自動叫醒/, '說明不自動叫醒');
  assert.doesNotMatch(r.out, /啟動 watcher：|等待腳本：node/, '不印 watcher、等待腳本的啟動指令');
  assert.match(r.out, /已在 .*mcp-config\.json 加好通用的 aigile/, r.out.slice(-800));
  let j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(j.mcpServers.github, mine.mcpServers.github, '原有的 MCP 不動');
  assert.deepEqual(j.extra, mine.extra, '其他設定不動');
  const mcpPath = path.join(process.env.AIGILE_HOME, '.aigile', 'aigile-mcp.mjs').replace(/\\/g, '/');
  assert.deepEqual(j.mcpServers.aigile, { type: 'local', command: 'node', args: [mcpPath], env: { AIGILE_AGENT: '${AIGILE_AGENT}' }, tools: ['*'] }, 'aigile 用家目錄的轉接腳本、代號從 AIGILE_AGENT 來');
  assert.ok(!fs.readFileSync(cfgFile, 'utf8').includes(tok3), 'MCP 設定裡沒有 Token');
  const baks = () => fs.readdirSync(COPILOT_HOME).filter(f => f.startsWith('mcp-config.json.aigile-bak-'));
  assert.equal(baks().length, 1, '改之前有備份');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(COPILOT_HOME, baks()[0]), 'utf8')), mine, '備份是原檔');
  assert.match(fs.readFileSync(path.join(W, '.aigile', agent, 'watcher.env'), 'utf8'), /^SKILL_TOOL=copilot$/m, '記住工具（之後按「同步」不用再帶 --tool）');
  r = await run(pub('aigile-setup.mjs'), setupArgs, W);
  assert.match(r.out, /Copilot CLI 已有 aigile（.*不改）/, '已有就不改');
  assert.equal(baks().length, 1, '沒改就不備份');
  // 壞掉的 JSON 不碰
  fs.writeFileSync(cfgFile, '{ broken');
  r = await run(pub('aigile-setup.mjs'), setupArgs, W);
  assert.equal(r.code, 0, '設定檔壞掉也不讓接入檢查失敗');
  assert.match(r.out, /不是合法的 JSON，沒有改它/);
  assert.match(r.out, /請自己在 .*mcp-config\.json 的 mcpServers 加 "aigile"/, '印出要自己加的設定');
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{ broken', '壞掉的檔案原樣保留');
  // mcpServers 不是物件：不碰
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: [] }));
  r = await run(pub('aigile-setup.mjs'), setupArgs, W);
  assert.match(r.out, /格式看不懂（要有 mcpServers 物件），沒有改它/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), JSON.stringify({ mcpServers: [] }), '看不懂的檔案原樣保留');
  // 沒有設定檔：新建
  fs.rmSync(cfgFile);
  r = await run(pub('aigile-setup.mjs'), setupArgs, W);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.aigile.command, 'node', '沒有設定檔就新建');
  console.log('✓ 3 接入檢查 --tool copilot：MCP 加進 mcp-config.json（保留原有、先備份、不重複、壞檔不碰）');

  // 4. 一行啟動（實際執行網頁給的那一行；假的 copilot）
  const S = fs.mkdtempSync(path.join(dataDir, 's-'));
  const D = path.join(S, '.aigile', agent2);
  pidFiles.push(path.join(D, 'watcher.pid'));
  r = await runLine(S, code);
  assert.equal(r.code, 0, r.out.slice(-1200));
  assert.ok(fs.existsSync(path.join(D, '.token')), '存好 Token');
  const tok4 = fs.readFileSync(path.join(D, '.token'), 'utf8').trim();
  assert.ok(!fs.existsSync(path.join(D, 'watcher.pid')), 'Copilot CLI 不開 watcher');
  assert.doesNotMatch(r.out, /watcher 已在背景啟動/, '不開 watcher');
  let calls = fakeCalls();
  assert.equal(calls.length, 1, '開了一次 copilot');
  let c = calls[0];
  assert.equal(c.agent, agent2, '帶 AIGILE_AGENT');
  const mi = c.args.indexOf('--additional-mcp-config');
  assert.ok(mi >= 0 && path.isAbsolute(c.args[mi + 1].slice(1)), '--additional-mcp-config 帶絕對路徑');
  const sess = JSON.parse(c.cfg);
  assert.equal(sess.mcpServers.aigile.env.AIGILE_AGENT, agent2, '這次對話的 aigile 直接用這隻 AI 的代號');
  assert.ok(!c.cfg.includes(tok4), '對話用的 MCP 設定裡沒有 Token');
  const pi = c.args.indexOf('-i');
  assert.ok(pi >= 0, '用 -i 開互動模式並帶入提示');
  assert.match(c.args[pi + 1], /初次接入/);
  assert.match(c.args[pi + 1], /Copilot CLI 目前不自動叫醒：不開 watcher、不開等待腳本/);
  assert.match(c.args[pi + 1], /aigile_me/);
  assert.ok(!c.args.join(' ').includes(tok4), '參數裡沒有 Token');
  assert.match(fs.readFileSync(path.join(D, 'onboarding.md'), 'utf8'), /## 五、待命：手動（Copilot CLI/, 'onboarding.md 是 Copilot CLI 版');
  // 第二次貼同一行：重新接上
  r = await runLine(S, code);
  assert.equal(r.code, 0, r.out.slice(-1200));
  calls = fakeCalls(); c = calls[1];
  assert.match(c.args[c.args.indexOf('-i') + 1], /重新接上/, '第二次是重新接上');
  assert.ok(fs.readFileSync(path.join(D, 'reconnect.md'), 'utf8').includes('## 五、待命：手動（Copilot CLI'), 'reconnect.md 是 Copilot CLI 版');
  assert.ok(!fs.existsSync(path.join(D, 'watcher.pid')), '第二次也不開 watcher');
  console.log('✓ 4 一行啟動 --tool copilot：帶代號開 copilot -i、不開 watcher；第二次重新接上');

  // 5. 技能同步狀態認得 copilot；網頁
  const st = await db.get('SELECT tool FROM skill_syncs WHERE ai_id = ?', ai.participantId);
  assert.equal(st?.tool, 'copilot', '接入檢查回報的同步狀態記成 copilot（主人的同步清單看得到）');
  const appJs = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(appJs, /\['copilot', 'Copilot CLI'\]/, '「我的 AI › 接入」工具有 Copilot CLI');
  assert.match(appJs, /const maHasLine = tool => [^\n]*'copilot'/, 'Copilot CLI 有「複製一行啟動」');
  assert.ok(appJs.includes('目前要人開視窗叫它做事，自動叫醒之後支援') && appJs.includes('免費版每月只有 50 次'), '畫面寫明不自動叫醒與每月 50 次');
  console.log('✓ 5 同步狀態記 copilot；網頁有 Copilot CLI');
  console.log('copilot-cli-test：全部通過');
} finally {
  for (const f of pidFiles) { try { killPid(Number(fs.readFileSync(f, 'utf8'))); } catch {} }
  await stopServer(server);
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
