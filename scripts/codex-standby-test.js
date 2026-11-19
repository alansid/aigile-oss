// 驗收測試：Codex 待命改成有事才叫醒，不再前景常駐
// 修正前：Codex 照規格 3.12 前景跑等待腳本、對話保持進行中；時間到就重跑、每次重讀整段對話，沒有卡片也一直耗用量
// 修正後：watcher 在背景，有待處理才執行 aigile-codex.mjs，開 codex exec 跑一輪就結束
// 全部用假的 codex（CODEX_BIN 指向這裡寫的小腳本）與本機記憶體資料庫，不跑真的 Codex、不連正式庫
// 用法：node scripts/codex-standby-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const CX = pub('aigile-codex.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codex-standby-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})), text: '' };
};
let countCalls = 0;
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  if (req.url.startsWith('/api/notifications/count')) countCalls++;
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 假的 codex：記下參數；新對話印 thread.started（或照設定不印、改寫 Codex 對話檔）；也模擬 AI 把 Token 印出來
const FAKE = path.join(dataDir, 'fake-codex.mjs');
fs.writeFileSync(FAKE, `import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const a = process.argv.slice(2);
fs.appendFileSync('codex-calls.jsonl', JSON.stringify(a) + '\\n');
fs.writeFileSync('codex-env.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GIT_|GCM_|SSH_ASKPASS)/.test(k)))));
const prompt = a[a.length - 1];
const leak = [process.env.AIGILE_TOKEN || ''];
try { for (const d of fs.readdirSync('.aigile')) { try { leak.push(fs.readFileSync(path.join('.aigile', d, '.token'), 'utf8')); } catch {} } } catch {}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'token=' + leak.join(',') } }));
if (a[0] === 'exec' && a[1] !== 'resume') {
  const id = crypto.randomUUID();
  if (!process.env.FAKE_NO_ID) console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  else if (!process.env.FAKE_NO_FILE) {
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '13'); fs.mkdirSync(dir, { recursive: true });
    const line = (sid, p) => JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: process.cwd(), base_instructions: 'x'.repeat(120000) } }) + '\\n' + JSON.stringify({ type: 'response_item', payload: { content: [{ text: p }] } }) + '\\n';
    fs.writeFileSync(path.join(dir, 'rollout-a-' + id + '.jsonl'), line(id, prompt));
    // 同資料夾別的 AI 稍後開的對話（較新），不能被接走
    const other = crypto.randomUUID(); fs.writeFileSync(path.join(dir, 'rollout-b-' + other + '.jsonl'), line(other, prompt.replace(/agent \\S+\\./, 'agent QA_OTHER.')));
    fs.writeFileSync('last-file-id.txt', id);
  }
}
if (process.env.FAKE_BLOCKED) console.error('ERROR codex_core::tools::router: error=exec_command failed: Rejected: blocked by policy');
console.log(JSON.stringify({ type: 'turn.completed' }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
const BIN = `"${process.execPath}" "${FAKE}"`;
const wake = (cwd, agent, mode, env = {}) => new Promise(r => execFile(process.execPath, [CX, '--agent', agent, '--mode', mode], { cwd, env: { ...process.env, CODEX_BIN: BIN, AIGILE_CODEX_BIN: BIN, CODEX_HOME: path.join(cwd, 'codex-home'), AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: '', ...env } }, e => r(e ? e.code : 0)));
const calls = d => { try { return fs.readFileSync(path.join(d, 'codex-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const sessOf = c => (c[1] === 'resume' ? c[c.length - 2] : 'NEW');
const newDir = (...agents) => { const d = fs.mkdtempSync(path.join(dataDir, 'w-')); for (const ag of agents) { fs.mkdirSync(path.join(d, '.aigile', ag), { recursive: true }); fs.writeFileSync(path.join(d, '.aigile', ag, '.token'), `tok_${ag}_SECRET_0123456789abcdef`); } return d; };
const st = (d, ag) => JSON.parse(fs.readFileSync(path.join(d, '.aigile', ag, 'codex.json'), 'utf8'));

try {
  // 1. 太長才換新：前 10 次同一個對話，第 11 次開新對話
  const d1 = newDir('PG');
  for (let i = 0; i < 11; i++) assert.equal(await wake(d1, 'PG', 'auto'), 0);
  const c1 = calls(d1);
  assert.equal(c1.length, 11);
  const first = st(d1, 'PG');
  assert.deepEqual(c1.map(sessOf).slice(0, 10).filter(x => x === 'NEW').length, 1, '前 10 次只開一個新對話');
  assert.equal(sessOf(c1[10]), 'NEW', '第 11 次開新對話');
  assert.equal(first.wakes, 1, '換新後重新數');
  const s1 = c1.slice(1, 10).map(sessOf);
  assert.equal(new Set(s1).size, 1, '第 2～10 次接同一個對話：' + s1.join(','));
  assert.match(s1[0], /^[0-9a-f-]{36}$/, '用 codex 印出的對話編號');
  // 指令：exec／exec resume、--json、沙盒只開網路、不讓人按同意；不用 --last、不開完全權限
  for (const c of c1) {
    assert.equal(c[0], 'exec');
    for (const k of ['--json', '--skip-git-repo-check', 'sandbox_mode=workspace-write', 'sandbox_workspace_write.network_access=true', 'approval_policy=never']) assert.ok(c.includes(k), `帶 ${k}：${JSON.stringify(c)}`);
    for (const k of ['--last', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access']) assert.ok(!c.join(' ').includes(k), `不帶 ${k}`);
    assert.match(c[c.length - 1], /^You are Aigile agent PG\. /, '提示帶代號');
    assert.match(c[c.length - 1], /do not git commit, push, merge or deploy/, '提示寫明叫醒的這一輪不 commit／push／部署');
  }
  // Token 不進 wake.log、codex.json
  const log1 = fs.readFileSync(path.join(d1, '.aigile/PG/wake.log'), 'utf8');
  assert.ok(!log1.includes('tok_PG_SECRET'), 'wake.log 找不到 Token');
  assert.ok(log1.includes('[TOKEN]'), 'Token 換成 [TOKEN]');
  assert.ok(!fs.readFileSync(path.join(d1, '.aigile/PG/codex.json'), 'utf8').includes('SECRET'), 'codex.json 沒有 Token');
  assert.match(log1, /接續對話 .*（第 10 次，滿 10 次換新）/); assert.match(log1, /開新對話（方式 auto，舊對話叫醒 10 次）/);
  // watcher 傳進來的環境變數 Token 也過濾
  const d1b = newDir('PG');
  await wake(d1b, 'PG', 'fresh', { AIGILE_TOKEN: 'envtok_ABCDEFGHIJKLMNOP' });
  assert.ok(!fs.readFileSync(path.join(d1b, '.aigile/PG/wake.log'), 'utf8').includes('envtok_ABCDEFGHIJKLMNOP'), '環境變數的 Token 也過濾');

  // 2. 每次新對話：從不 resume
  const d2 = newDir('PG');
  for (let i = 0; i < 3; i++) await wake(d2, 'PG', 'fresh');
  assert.deepEqual(calls(d2).map(sessOf), ['NEW', 'NEW', 'NEW'], 'fresh 每次新對話');
  // 3. 一直接續：已有對話就一直 resume
  const d3 = newDir('PG');
  fs.writeFileSync(path.join(d3, '.aigile/PG/codex.json'), JSON.stringify({ session: '11111111-2222-3333-4444-555555555555', wakes: 50 }));
  for (let i = 0; i < 12; i++) await wake(d3, 'PG', 'keep');
  assert.deepEqual([...new Set(calls(d3).map(sessOf))], ['11111111-2222-3333-4444-555555555555'], 'keep 一直用同一個');

  // 4. 同資料夾兩個代號：各接各的
  const d4 = newDir('PG', 'QA');
  for (const ag of ['PG', 'QA', 'PG', 'QA']) await wake(d4, ag, 'auto');
  const c4 = calls(d4), pgId = st(d4, 'PG').session, qaId = st(d4, 'QA').session;
  assert.notEqual(pgId, qaId);
  assert.deepEqual(c4.map(sessOf), ['NEW', 'NEW', pgId, qaId], '同資料夾兩個 AI 不接錯');
  assert.match(c4[2].at(-1), /agent PG\./); assert.match(c4[3].at(-1), /agent QA\./);

  // 5. 拿不到編號：到 Codex 對話資料夾找自己的（同資料夾別的 AI 較新的不拿）；再找不到就下次開新對話
  const d5 = newDir('PG');
  await wake(d5, 'PG', 'auto', { FAKE_NO_ID: '1' });
  assert.equal(st(d5, 'PG').session, fs.readFileSync(path.join(d5, 'last-file-id.txt'), 'utf8'), '從對話檔找到自己的編號');
  await wake(d5, 'PG', 'auto');
  assert.equal(sessOf(calls(d5)[1]), st(d5, 'PG').session, '下次接續找到的對話');
  const d6 = newDir('PG');
  await wake(d6, 'PG', 'auto', { FAKE_NO_ID: '1', FAKE_NO_FILE: '1' });
  assert.equal(st(d6, 'PG').session, null);
  assert.match(fs.readFileSync(path.join(d6, '.aigile/PG/wake.log'), 'utf8'), /WARN 找不到新對話的編號，下次叫醒會再開新對話/);
  await wake(d6, 'PG', 'auto');
  assert.deepEqual(calls(d6).map(sessOf), ['NEW', 'NEW'], '找不到就下次再開新對話');
  // PO 退回：沙盒有開網路，Git 認證管理員的帳密還拿得到 → 開 codex 時清掉 credential helper、不跳輸入框、SSH 一律失敗
  const genv = JSON.parse(fs.readFileSync(path.join(d1, 'codex-env.json'), 'utf8'));
  assert.equal(genv.GIT_TERMINAL_PROMPT, '0'); assert.equal(genv.GCM_INTERACTIVE, 'never'); assert.equal(genv.GIT_SSH_COMMAND, 'false');
  assert.match(genv.GIT_CONFIG_PARAMETERS, /'credential\.helper='$/, '清掉 credential helper（放最後，原本的值有 helper 也清掉）');
  assert.ok(!Object.keys(genv).some(k => /KEY|SECRET|TOKEN/i.test(k)), 'Codex 會濾掉名稱含 KEY／SECRET／TOKEN 的變數，不能靠它們：' + Object.keys(genv));
  // 用假的 credential helper（不碰這台電腦真的帳密）：不帶設定拿得到，帶 codex 收到的設定就拿不到
  const gdir = fs.mkdtempSync(path.join(dataDir, 'git-'));
  fs.writeFileSync(path.join(gdir, 'gitconfig'), '[credential]\n\thelper = "!f() { echo username=u; echo password=LEAKED_PW; }; f"\n');
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GCM_)/.test(k))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(gdir, 'gitconfig'), HOME: gdir, GIT_TERMINAL_PROMPT: '0' };
  const fill = extra => new Promise(r => { const p = execFile('git', ['credential', 'fill'], { cwd: gdir, env: { ...gitEnv, ...extra }, timeout: 20_000 }, (e, out, err) => r({ code: e ? e.code : 0, out: out + err })); p.stdin.end('protocol=https\nhost=github.com\n\n'); });
  const ctl = await fill({});
  assert.match(ctl.out, /password=LEAKED_PW/, '對照：不帶設定拿得到帳密（測試本身有效）');
  const blocked = await fill(genv);
  assert.ok(!/LEAKED_PW/.test(blocked.out) && blocked.code !== 0, 'codex 收到的設定：git 拿不到帳密：' + blocked.out);
  // 實測：Windows 沒設 Codex 沙盒時指令全被拒 → wake.log 留 WARN 請所屬人類設定
  const d7 = newDir('PG'); await wake(d7, 'PG', 'fresh', { FAKE_BLOCKED: '1' });
  assert.match(fs.readFileSync(path.join(d7, '.aigile/PG/wake.log'), 'utf8'), /WARN 有 1 行「blocked by policy」.*\[windows\] sandbox/, '沙盒全擋時留 WARN');
  // codex 失敗：結束碼照實傳給 watcher
  assert.equal(await wake(newDir('PG'), 'PG', 'fresh', { FAKE_EXIT: '3' }), 3, '結束碼照實傳回');
  console.log('codex-standby-test：喚醒腳本通過');

  // 6. 接入檢查 --tool codex：WAKE_CMD 設成 Codex 喚醒腳本；不印前景等待腳本
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = await testToken(db, ai.participantId);
  const AG = (await call(tok, '/api/me/watcher-env')).body.agent;
  const wd = fs.mkdtempSync(path.join(dataDir, 's-'));
  fs.mkdirSync(path.join(wd, '.aigile', AG), { recursive: true });
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), tok);
  const setup = (...extra) => new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, ...extra],
    { cwd: wd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: process.env.AIGILE_TEST_CODEX_HOME, AIGILE_CLAUDE_BIN: path.join(dataDir, 'no-claude.mjs') } }, (e, out) => ok({ code: e ? e.code : 0, out })));
  const wakeCmd = () => /^WAKE_CMD=(.*)$/m.exec(fs.readFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), 'utf8'))[1];
  let r = await setup('--tool', 'codex', '--mode', 'fresh');
  assert.equal(r.code, 0, r.out);
  assert.equal(wakeCmd(), `node .aigile/watcher/aigile-codex.mjs --agent ${AG} --mode fresh`, 'WAKE_CMD 指向 Codex 喚醒腳本');
  assert.ok(fs.existsSync(path.join(wd, '.aigile/watcher/aigile-codex.mjs')), '喚醒腳本一起下載核對');
  assert.match(r.out, /Codex 不用前景等待：watcher 有待處理才執行 WAKE_CMD=/);
  assert.ok(!/aigile-wait\.mjs --agent/.test(r.out), 'Codex 不印前景等待腳本');
  r = await setup('--tool', 'codex', '--mode', 'auto');
  assert.match(wakeCmd(), /--mode auto$/, '換接續方式跟著改');
  r = await setup('--tool', 'codex');
  assert.match(wakeCmd(), /--mode auto$/, '沒帶 --mode 沿用');
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), fs.readFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), 'utf8').replace(/^WAKE_CMD=.*$/m, 'WAKE_CMD=my-own-wake.cmd'));
  await setup('--tool', 'codex', '--mode', 'keep');
  assert.equal(wakeCmd(), 'my-own-wake.cmd', '自己寫的 WAKE_CMD 不動');
  const wd2 = fs.mkdtempSync(path.join(dataDir, 's-')); fs.mkdirSync(path.join(wd2, '.aigile', AG), { recursive: true }); fs.writeFileSync(path.join(wd2, '.aigile', AG, '.token'), tok);
  r = await new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, '--tool', 'claude'], { cwd: wd2, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_CLAUDE_BIN: path.join(dataDir, 'no-claude.mjs') } }, (e, out) => ok({ out })));
  assert.match(fs.readFileSync(path.join(wd2, '.aigile', AG, 'watcher.env'), 'utf8'), /^WAKE_CMD=echo WAKE$/m, 'Claude Code 照舊 echo');
  assert.match(r.out, /等待腳本：node/, 'Claude Code 照舊印等待腳本');

  // 7. 一整天沒事叫醒 0 次：watcher 用 Codex 喚醒腳本，巡檢 96 次（15 分鐘一次×24 小時，這裡縮成 0.1 秒一次）都沒有待處理就不執行
  const env = { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: `.aigile/${AG}/.token`, AIGILE_ME: ai.participantId, SUPABASE_URL: '', SUPABASE_KEY: '',
    HEARTBEAT_MIN: String(0.1 / 60), WAKE_CMD: `node "${CX}" --agent ${AG} --mode auto`, CODEX_BIN: BIN, AIGILE_CODEX_BIN: BIN, CODEX_HOME: path.join(wd, 'codex-home'), PID_FILE: '', BELL_FILE: '' };
  for (const n of (await call(tok, '/api/notifications?limit=50')).body.notifications || []) await call(tok, '/api/notifications/ack', 'POST', { notificationIds: [n.notificationId] });
  fs.rmSync(path.join(wd, 'codex-calls.jsonl'), { force: true });
  countCalls = 0;
  const w = spawn(process.execPath, [pub('watcher.mjs')], { cwd: wd, env });
  let wout = ''; w.stdout.on('data', d => { wout += d; }); w.stderr.on('data', d => { wout += d; });
  const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label + '\n' + wout.slice(-800)); };
  try {
    await until(() => countCalls >= 97, 60_000, '巡檢 96 次');
    assert.equal(calls(wd).length, 0, `一整天（${countCalls} 次巡檢）沒事：叫醒 0 次`);
    assert.ok(!/喚醒：/.test(wout), 'watcher 日誌沒有喚醒紀錄');
    console.log(`codex-standby-test：一整天沒事 ${countCalls} 次巡檢、叫醒 ${calls(wd).length} 次`);
    // 有待處理照常叫醒：人類 @ 它，下一次巡檢就開 Codex 跑一輪
    const posted = await call(liu.token, '/api/messages', 'POST', { requestId: 'codex-standby-wake', project: '預設專案', text: '[通知] 測試叫醒', recipientIds: [ai.participantId], replyFrom: [ai.participantId] });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    await until(() => calls(wd).length >= 1, 15_000, '有待處理叫醒 Codex');
    assert.equal(calls(wd)[0][0], 'exec');
    await until(() => /這一輪結束/.test(fs.readFileSync(path.join(wd, '.aigile', AG, 'wake.log'), 'utf8')), 10_000, '這一輪結束');
    assert.ok(!fs.readFileSync(path.join(wd, '.aigile', AG, 'wake.log'), 'utf8').includes(tok), 'watcher 叫醒的 wake.log 也沒有 Token');
  } finally { w.kill(); }

  // 8. 接入設定（Codex 版）與規格
  const ob = async q => (await (await app(new Request(`http://localhost/api/my-ais/${ai.participantId}/onboarding${q}`, { headers: { Authorization: `Bearer ${liu.token}` } }), 'http://localhost')).json()).text;
  const cx = await ob('?tool=codex');
  const sec = cx.slice(cx.indexOf('## 五、待命：Codex'), cx.indexOf('## ', cx.indexOf('## 五、待命：Codex') + 5));
  assert.ok(sec.length > 100, 'Codex 第五節');
  assert.ok(!/aigile-wait\.mjs|前景跑|前景執行|保持進行中/.test(sec), 'Codex 不再前景跑等待腳本：' + sec);
  assert.match(sec, /--tool codex --mode auto/, '預設太長才換新，接入檢查帶 --mode');
  assert.match(sec, /有待處理才開 codex exec 跑一輪就結束/);
  assert.match(sec, /太長＝同一個對話叫醒滿 10 次，由喚醒腳本數），免得對話越來越長、每次叫醒重讀越來越貴/, '--every 白話說明');
  assert.match(sec, /commit、push、merge、部署一律不做/, '叫醒那一輪不 commit／push／部署');
  assert.match(sec, /codex\.exe 與 node\.exe/, '寫明怎麼確認已停');
  assert.match(sec, /watcher 在跑、日誌有連線或巡檢紀錄才算成功/, '成功判定改成 watcher');
  assert.match(await ob('?tool=codex&convo=fresh'), /--tool codex --mode fresh/);
  assert.ok(!/免得對話越來越長/.test(await ob('?tool=codex&convo=keep')), '一直接續不寫換新');
  for (const q of ['?tool=codex', '?tool=codex&convo=fresh&autoStandby=1']) assert.ok([...await ob(q)].length <= 6500, `Codex 接入設定 ≤ 6,500 字（${q}）`);
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /\| 能被外部指令叫起來跑一輪（opencode、Codex） \| watcher＋喚醒腳本/, '規格 3.12 表格');
  assert.ok(!/只能在回合裡執行指令（Codex）|整個過程對話要保持進行中/.test(spec), '規格拿掉 Codex 前景常駐');
  const guide = fs.readFileSync(new URL('../docs/connect-your-ai.md', import.meta.url), 'utf8'); // 開源版：Codex 細節在 connect-your-ai，規格只留規則
  assert.ok([...spec].length <= 19500, '開源版規格留 500 字餘裕：' + [...spec].length);
  for (const k of ['aigile-codex.mjs --agent <代號> --mode', '不要用 `resume --last`', 'commit、push、merge、部署一律不做', '`codex.exe` 與 `node.exe`', '每叫醒 10 次開一個新對話', 'git 帳密在叫醒那一輪拿不到，push 會失敗']) assert.ok((spec + guide).includes(k), '規格或 connect-your-ai 有：' + k);
  console.log('codex-standby-test：全部通過');
} catch (e) {
  console.error('codex-standby-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
