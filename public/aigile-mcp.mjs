#!/usr/bin/env node
// Aigile-Switch MCP 轉接（通用版）：把 Claude Code／Codex 的 stdio MCP 請求轉到平台 POST /api/mcp。零依賴，Node 22+。
//
// 每次請求都重讀 Token 檔：所屬人類重發 Token 後只要換 .aigile/<代號>/.token，不用改 MCP 設定、不用重開。
// Token 不放環境變數、不寫進 MCP 設定檔；這支腳本不印 Token。
//
// 兩種用法：
//   通用（整台電腦裝一次）：claude mcp add -s user aigile -- node ~/.aigile/aigile-mcp.mjs
//     工作資料夾：從目前資料夾（AIGILE_DIR 可指定）往上找第一個有 AI Token 的 .aigile/（從子資料夾開也找得到）；
//       往上找到家目錄就停（家目錄底下的專案不會用到家目錄的 .aigile）。找不到＝這裡沒有接入平台：不打網路、不給工具
//     Token：<工作資料夾>/.aigile/<代號>/.token；平台網址讀同一層 watcher.env 的 AIGILE_BASE
//     認身分依序：環境變數 AIGILE_AGENT（一行啟動會帶）→ 資料夾只有一隻 AI 有 .token 就用它 → 都不是就只給 aigile_use(代號)，選好送 tools/list_changed
//     身分一個程序只定一次：定了就鎖住，aigile_use 換別的代號會被擋（要換身分請重開對話），免得中途誤切成別隻 AI
//   舊的（每隻 AI 一個，aigile-<代號>）：node <絕對路徑>/.aigile/watcher/aigile-mcp.mjs --agent PG_XXXX [--base https://平台網址]
//     Token：這支腳本旁邊的 ../<代號>/.token；照舊能用
//   代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1
// stdout 只寫 MCP 回應（一行一則 JSON）；說明與錯誤寫 stderr。
// aigile_memory（read／patch／write）成功、aigile_ack 回了 messagesCursor，就同步寫本機 .aigile/<代號>/state.json（AI 不用另外寫）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const FIXED = opt('agent'); // 舊用法：代號寫死
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_RE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?$/;
const log = msg => process.stderr.write(`[aigile-mcp] ${msg}\n`);
const tokenIn = (root, agent) => { try { return !!fs.readFileSync(path.join(root, '.aigile', agent, '.token'), 'utf8').trim(); } catch { return false; } };
const agentsIn = root => { try { return fs.readdirSync(path.join(root, '.aigile'), { withFileTypes: true }).filter(d => d.isDirectory() && CODE_RE.test(d.name) && tokenIn(root, d.name)).map(d => d.name).sort(); } catch { return []; } };
// 往上找工作資料夾（通用版）
const wakeAgent = process.env.AIGILE_WAKE_AGENT;
function findWork() {
  // watcher 從自己的工作目錄啟動，不能往上層尋找其他身分。
  if (wakeAgent !== undefined) return process.cwd();
  const start = path.resolve(process.env.AIGILE_DIR || process.cwd());
  const home = path.resolve(os.homedir()); // 真的家目錄（AIGILE_HOME 只管轉接腳本放哪，不影響往上找到哪裡停）
  for (let d = start; ; d = path.dirname(d)) {
    if (d === home && d !== start) return null; // 家目錄的 .aigile 只給在家目錄開的對話
    if (agentsIn(d).length) return d;
    if (path.dirname(d) === d) return null;
  }
}
const WORK = FIXED ? null : findWork();
const dirOf = agent => (FIXED ? path.join(HERE, '..', agent) : path.join(WORK, '.aigile', agent));
const hasToken = agent => { try { return !!fs.readFileSync(path.join(dirOf(agent), '.token'), 'utf8').trim(); } catch { return false; } };
const candidates = () => (WORK ? agentsIn(WORK) : []);

let AGENT = FIXED;
let why = '';
if (wakeAgent !== undefined) {
  if (!CODE_RE.test(wakeAgent) || (FIXED && FIXED !== wakeAgent) || !hasToken(wakeAgent)) {
    log('無法綁定指定的喚醒身分，請檢查該代號與工作目錄。');
    process.exit(1);
  }
  AGENT = wakeAgent;
} else if (!AGENT && WORK) {
  const env = (process.env.AIGILE_AGENT || '').trim();
  const list = candidates();
  if (env && CODE_RE.test(env) && hasToken(env)) AGENT = env;
  else if (env) why = `環境變數 AIGILE_AGENT=${env}，但 ${path.join(WORK, '.aigile', env, '.token')} 沒有 Token`;
  else if (list.length === 1) AGENT = list[0];
  else why = `這個資料夾（${WORK}）有 ${list.length} 隻 AI（${list.join('、')}），請先呼叫 aigile_use 選你的代號`;
}
const envBase = agent => { try { return /^AIGILE_BASE=(.*)$/m.exec(fs.readFileSync(path.join(dirOf(agent), 'watcher.env'), 'utf8'))?.[1].trim() || ''; } catch { return ''; } };
const baseOf = agent => (opt('base') || envBase(agent)).replace(/\/+$/, '');
if (FIXED && !baseOf(FIXED)) { log(`找不到平台網址（--base 或 ${path.join(dirOf(FIXED), 'watcher.env')} 的 AIGILE_BASE）。先跑 aigile-setup.mjs`); process.exit(1); }
const NONE = '這裡沒有接入平台（這個資料夾和上層都沒有 .aigile/<代號>/.token）。這個專案用不到 aigile 工具，照常工作即可';

const send = obj => process.stdout.write((typeof obj === 'string' ? obj.trim() : JSON.stringify(obj)) + '\n');
const USE_TOOL = { name: 'aigile_use', description: '選定你在這個資料夾的 AI 代號（例如 PG_XXXX），一個對話只能選一次，選了就鎖定；已選定時回傳目前身分。一行啟動或資料夾只有一隻 AI 時不用呼叫。',
  inputSchema: { type: 'object', properties: { agent: { type: 'string', description: '你的 AI 代號（角色_短代碼），看接入設定或 .aigile 底下的資料夾名' } }, required: ['agent'], additionalProperties: false } };
const multi = () => !FIXED && candidates().length > 1;

async function post(agent, line) {
  const token = fs.readFileSync(path.join(dirOf(agent), '.token'), 'utf8').trim();
  if (!token) throw new Error(`Token 檔是空的：${path.join(dirOf(agent), '.token')}`);
  const base = baseOf(agent);
  if (!base) throw new Error(`找不到平台網址（${path.join(dirOf(agent), 'watcher.env')} 的 AIGILE_BASE）`);
  let r;
  try {
    r = await fetch(`${base}/api/mcp`, { method: 'POST', body: line, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Aigile-Source': 'mcp' } });
  } catch (e) { throw new Error(`連不到 ${base}（${e.cause?.code || e.name}）`); }
  if (r.status === 202) return null; // 通知，不用回
  const text = await r.text();
  if (r.ok) return text;
  let w = text.slice(0, 200);
  try { const j = JSON.parse(text); if (j.jsonrpc) return text; w = `${j.error?.code}：${j.error?.message}`; } catch {}
  throw new Error(`平台回 HTTP ${r.status}：${w}${r.status === 401 ? '（Token 失效：請所屬人類在網頁重發，換掉 .token 即可，不用改設定）' : ''}`);
}

async function uploadDoc(agent, a) {
  if (a.declared !== true) throw new Error('declared 要是 true（確認不含程式碼與客戶個資）');
  if (!a.project || !a.name) throw new Error('要帶 project 與 name');
  const file = path.resolve(WORK || process.cwd(), String(a.path));
  let bytes; try { bytes = fs.readFileSync(file); } catch (e) { throw new Error(`讀不到 ${file}（${e.code || e.message}）`); }
  const token = fs.readFileSync(path.join(dirOf(agent), '.token'), 'utf8').trim(), base = baseOf(agent);
  const q = new URLSearchParams({ name: a.name, declared: 'true', ...(a.folderId ? { folderId: a.folderId } : {}) });
  const r = await fetch(`${base}/api/projects/${encodeURIComponent(a.project)}/docs?${q}`, { method: 'POST', body: bytes, signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Aigile-Source': 'mcp' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${j.error?.code || 'HTTP_' + r.status}：${j.error?.message || ''}`);
  return { docId: j.doc?.docId, name: j.doc?.name, size: j.doc?.size };
}

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失敗' } }); }
  const id = Array.isArray(msg) ? null : msg?.id;
  const isNote = id === undefined || id === null;
  const fail = message => (isNote ? log(message) : send({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
  const reply = result => send({ jsonrpc: '2.0', id, result });
  const text = t => ({ content: [{ type: 'text', text: t }] });
  const method = msg?.method;

  // 通用版、這裡沒有接入平台：不打網路、不給工具
  if (!FIXED && !WORK) {
    if (method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aigile', version: 'local' }, instructions: NONE });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [] });
    if (method === 'tools/call') return reply({ ...text(NONE), isError: true });
    if (isNote) return;
    return fail(NONE);
  }
  // 通用版：本機處理 aigile_use（一個程序只定一次身分）
  if ((!FIXED || wakeAgent) && method === 'tools/call' && msg.params?.name === 'aigile_use') {
    const want = String(msg.params?.arguments?.agent || '').trim();
    if (AGENT) {
      if (want === AGENT) return reply(text(`目前身分：${AGENT}（${dirOf(AGENT)}）。`));
      return reply({ ...text(`已鎖定為 ${AGENT}，這個對話不能換成 ${want || '別的代號'}。要換身分請重開對話（或用一行啟動帶 AIGILE_AGENT）。`), isError: true });
    }
    if (!CODE_RE.test(want) || !hasToken(want)) return reply({ ...text(`找不到 ${path.join(WORK, '.aigile', want || '<代號>', '.token')}。這個資料夾有 Token 的代號：${candidates().join('、') || '（沒有）'}`), isError: true });
    AGENT = want; why = '';
    reply(text(`已選定並鎖定 ${want}（${path.join(WORK, '.aigile', want)}）。工具清單已更新；之後每輪照接入設定用 aigile_ 工具，這個對話不能再換身分。`));
    return send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
  if (!AGENT) {
    if (method === 'initialize') {
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'aigile', version: 'local' },
        instructions: `Aigile-Switch 協作平台。還不知道你是哪隻 AI：${why}。先呼叫 aigile_use(代號)。` });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [USE_TOOL] });
    if (method === 'tools/call') return reply({ ...text(`還不知道你是哪隻 AI：${why}。先呼叫 aigile_use(代號)。`), isError: true });
    if (isNote) return;
    return fail(`還不知道你是哪隻 AI：${why}`);
  }
  // aigile_doc_upload 給本機 path 時，這裡讀檔直接上傳（平台的 MCP 讀不到本機檔案）
  if (method === 'tools/call' && msg.params?.name === 'aigile_doc_upload' && msg.params?.arguments?.path) {
    try { return reply(text(JSON.stringify(await uploadDoc(AGENT, msg.params.arguments)))); }
    catch (e) { return reply({ ...text(`失敗：${e.message}`), isError: true }); }
  }
  let out;
  try { out = await post(AGENT, line); } catch (e) { return fail(e.message); }
  if (out === null) return;
  if (method === 'tools/call') syncState(msg.params?.name, out);
  if (FIXED && !wakeAgent) return send(out);
  // 通用版：宣告會換工具清單；同資料夾有多隻 AI 時保留 aigile_use（回傳目前身分）
  try {
    const j = JSON.parse(out);
    if (method === 'initialize' && j.result) j.result.capabilities = { ...j.result.capabilities, tools: { ...(j.result.capabilities?.tools || {}), listChanged: true } };
    if (method === 'tools/list' && Array.isArray(j.result?.tools) && (wakeAgent || multi())) j.result.tools = [...j.result.tools, USE_TOOL];
    return send(j);
  } catch { return send(out); }
}

// 本機 state.json 跟平台的工作記憶一致（hook、poll.mjs、換對話時讀它）；失敗只記 stderr，不影響工具回應
function syncState(name, out) {
  if (name !== 'aigile_memory' && name !== 'aigile_ack') return;
  try {
    const r = JSON.parse(out)?.result;
    if (!r || r.isError) return;
    const body = JSON.parse(r.content?.[0]?.text || 'null');
    const file = path.join(dirOf(AGENT), 'state.json');
    if (name === 'aigile_memory' && body?.state) return fs.writeFileSync(file, JSON.stringify(body.state, null, 2));
    if (name === 'aigile_ack' && body?.messagesCursor) {
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
      if (cur.messagesCursor !== body.messagesCursor) fs.writeFileSync(file, JSON.stringify({ ...cur, messagesCursor: body.messagesCursor }, null, 2));
    }
  } catch (e) { log(`同步本機 state.json 失敗：${e.message}`); }
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { if (!line.trim()) return; const p = forward(line).catch(e => log(`轉送失敗：${e.message}`)).finally(() => pending.delete(p)); pending.add(p); });
// 對方關掉後不馬上 process.exit（Windows 上剛用完連線就 exit 會觸發 libuv 斷言）：設 exitCode 自然結束；5 秒後還有連線掛著才強制結束
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exitCode = 0; setTimeout(() => process.exit(0), 5000).unref?.(); });
