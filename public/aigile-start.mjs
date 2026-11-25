#!/usr/bin/env node
// Aigile-Switch 一行啟動：所屬人類在網頁「我的 AI」複製一行貼到工作資料夾的終端機；重開機貼同一行就接回。零依賴，Node 22+。
//
// 做的事（每步印一行；不印 Token）：
//   1. Token：.aigile/<代號>/.token 沒有才用 --setup 的一次性接入連結拿（拿到的接入設定去掉 Token 存成 onboarding.md）
//   2. 接入檢查：下載並核對 aigile-setup.mjs（雜湊用 Token 向平台拿），執行它——下載核對 watcher 等腳本、watcher.env、技能、
//      通用 MCP（aigile，整台電腦裝一次）、Claude Code hook（/clear 自動接回、回合結束檢查等待腳本）
//   3. watcher：watcher.pid 的程序不在才在背景啟動
//   4. Claude Code：帶 AIGILE_AGENT=<代號> 開 claude 並帶入待命提示（初次＝照 onboarding.md 接入；之後＝照 reconnect.md 重新接上）
//      Codex：也在前景開 codex（互動模式）帶入接入提示，人看得到接好沒；開著時寫 foreground.lock，背景喚醒腳本據此提醒先檢查工作樹；
//      watcher 合併點名，送進前景對話；視窗關閉才開背景回合
//      Antigravity CLI：在前景開 agy -i 帶入接入提示，開著時寫 foreground.lock 與 foreground-state.json；watcher 收到門鈴於前景空閒時背景跑 agy -p
//      Copilot CLI：目前只接入、不自動叫醒：不開 watcher；開 copilot 互動模式帶入接入提示（MCP 用這隻 AI 的代號）
// 用法：node aigile-start.mjs --agent PG_XXXX --base https://平台網址 [--setup 一次性接入連結] [--tool claude|codex|antigravity|copilot] [--no-launch]
// 結束碼：0 完成（或 claude 的結束碼）；1 某一步失敗（最後一行寫卡在哪、怎麼辦）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const AGENT = opt('agent');
const BASE = (opt('base') || '').replace(/\/+$/, '');
const SETUP_URL = opt('setup');
const TOOL = opt('tool') || 'claude';
const NO_LAUNCH = args.includes('--no-launch');
const DIR = path.join('.aigile', AGENT || '_');
const W = path.join('.aigile', 'watcher');
const out = s => console.log(s);
class Stop extends Error {}
const fail = (step, why, fix) => { out(`✗ ${step}：${why}`); out(`卡在：${step}。怎麼辦：${fix}`); throw new Stop(); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const posix = p => p.replace(/\\/g, '/');

try {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?$/.test(AGENT) || !/^https?:\/\//.test(BASE)) fail('參數', '缺 --agent 或 --base', '請所屬人類在網頁「我的 AI」重新複製一行啟動');
  if (!['claude', 'codex', 'antigravity', 'copilot'].includes(TOOL)) fail('參數', `--tool 只能是 claude、codex、antigravity 或 copilot（收到 ${TOOL}）`, '請所屬人類在網頁選對工具再複製');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Node 版本', `目前 ${process.versions.node}，要 22 以上`, '請安裝 Node 22 以上');
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(W, { recursive: true });

  // 1. Token
  const tokFile = path.join(DIR, '.token');
  let token = ''; try { token = fs.readFileSync(tokFile, 'utf8').trim(); } catch {}
  let first = false;
  let tokenSwapped = false;
  const pendingCheckin = path.join(DIR, TOOL === 'antigravity' ? 'antigravity-checkin.pending' : 'codex-checkin.pending');
  const NET_FIX = '公司網路多半要代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1 再貼一次';
  const RECOPY = '請所屬人類在網頁「我的 AI」重新複製一行啟動';
  // 用一次性連結拿 Token（連結會給目前有效的 Token）；接入設定去掉 Token 存成 onboarding.md
  async function fromLink() {
    const r = await fetch(SETUP_URL, { signal: AbortSignal.timeout(20_000) }).catch(e => fail('連線', `連不到 ${BASE}（${e.cause?.code || e.name}）`, NET_FIX));
    if (r.status === 410 || r.status === 409) fail('接入連結', '已失效或已用過（15 分鐘內、只能用一次）', RECOPY);
    if (!r.ok) fail('接入連結', `HTTP ${r.status}`, '把這行告訴所屬人類');
    const text = await r.text();
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex(l => l.includes('下一行整行就是 Token'));
    const ti = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.trim());
    const t = ti < 0 ? '' : lines[ti].trim();
    if (!/^[A-Za-z0-9_.~-]{16,}$/.test(t)) fail('Token', '接入設定裡找不到 Token', '把這行告訴所屬人類');
    if (!new RegExp(`--agent ${AGENT}\\b`).test(text)) fail('身分', `這份接入設定不是 ${AGENT} 的`, '請所屬人類確認複製的是這隻 AI 的一行啟動');
    first = /（初次接入）/.test(lines[0] || '');
    if (first && (TOOL === 'codex' || TOOL === 'antigravity')) fs.writeFileSync(pendingCheckin, AGENT);
    fs.writeFileSync(tokFile, t);
    lines[ti] = `（Token 已存在 ${posix(tokFile)}；不要印出、不要貼到群組）`;
    fs.writeFileSync(path.join(DIR, 'onboarding.md'), lines.join('\n'));
    return t;
  }
  if (!token) {
    if (!SETUP_URL) fail('Token', `找不到 ${posix(tokFile)}`, RECOPY + '（裡面有一次性接入連結）');
    token = await fromLink();
    out(`✓ Token 已存好（${posix(tokFile)}），接入設定存成 ${posix(path.join(DIR, 'onboarding.md'))}`);
  } else {
    // 本機舊的 Token 失效（重發過或到期）而這一行帶著連結 → 用連結換新的，舊檔先備份
    const r = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}`, 'X-Aigile-Source': 'start' }, signal: AbortSignal.timeout(20_000) }).catch(e => fail('連線', `連不到 ${BASE}（${e.cause?.code || e.name}）`, NET_FIX));
    if (r.status === 401 && SETUP_URL) {
      const bak = `${tokFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(tokFile, bak);
      out(`! 本機的 Token 平台不認得了（401，多半是重發過或到期），改用這一行的一次性連結拿新的；舊檔備份成 ${posix(bak)}`);
      token = await fromLink();
      tokenSwapped = true;
      out(`✓ 新的 Token 已存好（${posix(tokFile)}），接入設定存成 ${posix(path.join(DIR, 'onboarding.md'))}`);
    } else if (r.status === 401) fail('Token', '平台不認得本機的 Token（401）', RECOPY + '（一行裡的連結會換新的 Token）');
    else out(`✓ Token：${posix(tokFile)}`);
  }

  const auth = { Authorization: `Bearer ${token}`, 'X-Aigile-Source': 'start' };
  const get = async p => {
    const r = await fetch(BASE + p, { headers: auth, signal: AbortSignal.timeout(20_000) }).catch(e => fail('連線', `連不到 ${BASE}（${e.cause?.code || e.name}）`, NET_FIX));
    if (r.status === 401) fail('Token', '平台不認得這組 Token（401）', RECOPY);
    if (r.status === 409) {
      const msg = (await r.json().catch(() => null))?.error?.message || '狀態衝突（409）';
      fail('連線', `${p} 回 409：${msg}`, RECOPY);
    }
    if (!r.ok) fail('連線', `${p} 回 HTTP ${r.status}`, '把這行告訴所屬人類');
    return r;
  };

  // 2. 接入檢查（下載核對 aigile-setup.mjs 再執行；它會自己更新這支一行啟動）
  const cfg = await (await get('/api/me/watcher-env')).json();
  if (cfg.agent && cfg.agent !== AGENT) fail('代號', `這個 Token 是 ${cfg.agent} 的，不是 ${AGENT}`, '請所屬人類確認複製的是這隻 AI 的一行啟動');
  const setup = path.join(W, 'aigile-setup.mjs');
  let have = ''; try { have = sha(fs.readFileSync(setup)); } catch {}
  if (cfg.setup && have !== cfg.setup) {
    const r = await fetch(`${BASE}/aigile-setup.mjs`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const buf = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
    if (!buf) fail('下載', 'aigile-setup.mjs 下載失敗', '再貼一次；還是不行就告訴所屬人類');
    if (sha(buf) !== cfg.setup) fail('核對', 'aigile-setup.mjs 的 SHA-256 跟平台給的不一樣', '不要執行，告訴所屬人類');
    fs.writeFileSync(setup, buf);
  }
  out('— 接入檢查 —');
  const s = spawnSync(process.execPath, [setup, '--agent', AGENT, '--base', BASE, '--tool', TOOL], { stdio: 'inherit', env: { ...process.env, AIGILE_TOKEN: '' } });
  if (s.status !== 0) fail('接入檢查', `結束碼 ${s.status}`, '照上面接入檢查最後一行做，做完再貼一次這一行');
  out('— 接入檢查結束 —');

  // 記號：這台是用一行啟動接的＝所屬人類同意待命（/clear 的 hook 拿重新接上設定時帶 start=1）
  try { fs.writeFileSync(path.join(DIR, 'started-by-line'), new Date().toISOString()); } catch {}

  // 3. watcher
  const lock = path.join(DIR, 'foreground.lock');
  const fgStateFile = path.join(DIR, 'foreground-state.json');
  const unlock = () => {
    try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) { fs.rmSync(lock, { force: true }); fs.rmSync(fgStateFile, { force: true }); } } catch {}
  };
  if ((TOOL === 'codex' || TOOL === 'antigravity') && !NO_LAUNCH) {
    const toolTitle = TOOL === 'antigravity' ? 'Antigravity CLI' : 'Codex';
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = Number(fs.readFileSync(lock, 'utf8').trim());
      if (prior && alive(prior)) fail(toolTitle, '同代號已有前景視窗或正在啟動', '先使用或關閉原視窗再重新啟動');
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    }
    process.on('exit', unlock);
    if (fs.existsSync(pendingCheckin)) {
      const me = await (await get('/api/me')).json();
      if (cfg.agent !== AGENT || !me.participantId) fail('身分', '無法核對首次簽到的代號', RECOPY);
      const stateFile = path.join(DIR, 'state.json');
      const local = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
      const { state } = await (await get('/api/me/state')).json();
      const write = async (route, method, body, { allow409 = false } = {}) => {
        const r = await fetch(BASE + route, { method, headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        if (r.status === 409 && allow409) return { status: 409 };
        if (r.status === 409) {
          const msg = (await r.json().catch(() => null))?.error?.message || '狀態衝突（409）';
          fail('簽到', `${method} ${route} 回 409：${msg}`, RECOPY);
        }
        if (!r.ok) fail('簽到', `${method} ${route} 回 HTTP ${r.status}`, '確認平台狀態後重貼同一行');
        return { status: r.status };
      };
      // 先存基準，再以固定 requestId 簽到。已簽到過的 AI 走重新接上、不因重複簽到失敗。
      const messagesCursor = state?.messagesCursor || local.messagesCursor || (await (await get('/api/messages?limit=1&brief=1')).json()).nextCursor;
      if (!messagesCursor) fail('簽到', '平台沒有回傳初次游標', '確認平台狀態後重貼同一行');
      const cardsSince = state?.cardsSince || local.cardsSince || new Date().toISOString();
      if (!state?.messagesCursor) await write('/api/me/state', 'PATCH', { messagesCursor, cardsSince });
      const stage = stateFile + '.' + process.pid;
      fs.writeFileSync(stage, JSON.stringify({ ...local, ...state, messagesCursor, cardsSince }, null, 2));
      fs.renameSync(stage, stateFile);
      const res = await write('/api/messages', 'POST', { project: me.projects.find(p => !me.readOnlyIn?.includes(p)) || me.projects[0] || 'all',
        requestId: 'req_checkin_' + me.participantId, text: `[AI 簽到] ${AGENT} 已用 ${toolTitle} 一行啟動連上平台。` }, { allow409: true });
      fs.unlinkSync(pendingCheckin);
      if (res.status === 409) {
        first = false;
        out('✓ 平台已有你的簽到紀錄，直接沿用原游標重新接上');
      } else {
        first = true;
        out('✓ 首次簽到已送達，已保存收件游標');
      }
    }
  }
  const envFile = posix(path.join(DIR, 'watcher.env'));
  let watcherReady = false;
  const startWatcher = () => {
    if (watcherReady) return;
    const pidFile = path.join(DIR, 'watcher.pid');
    let wpid = 0; try { wpid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
    if (alive(wpid) && !tokenSwapped) out(`✓ watcher 已在執行（程序 ${wpid}）`);
    else {
      if (alive(wpid) && tokenSwapped) {
        try { process.kill(wpid); } catch {}
        try { fs.rmSync(pidFile, { force: true }); } catch {}
        out(`✓ 已換新 Token，停止舊 watcher（程序 ${wpid}）並重新啟動`);
      }
      const logFd = fs.openSync(path.join(DIR, 'watcher.log'), 'a');
      // --env-file 不蓋掉已經有的環境變數：watcher.env 裡有的鍵先從環境拿掉（舊的 AIGILE_TOKEN、空的 AIGILE_BASE 會讓 watcher 讀錯）
      const wenv = { ...process.env };
      for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const k = /^\s*([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1]; if (k) delete wenv[k]; }
      delete wenv.AIGILE_TOKEN;
      const w = spawn(process.execPath, [`--env-file=${envFile}`, posix(path.join(W, 'watcher.mjs'))], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: wenv });
      fs.closeSync(logFd);
      w.unref();
      out(`✓ watcher 已在背景啟動（程序 ${w.pid}，日誌 ${posix(path.join(DIR, 'watcher.log'))}）`);
    }
    watcherReady = true;
  };
  if (TOOL === 'claude' || TOOL === 'antigravity' || (TOOL === 'codex' && NO_LAUNCH)) startWatcher(); // Copilot CLI 不開 watcher

  // 4. 待命提示
  const wait = `node --env-file=${envFile} .aigile/watcher/aigile-wait.mjs --agent ${AGENT}`;
  // Codex、Antigravity CLI 在前景開一次做接入；點名由 watcher 接收，不用等待腳本
  const codexTail = 'Codex 視窗開著才會處理工作；關掉的話，工作會等你下次打開再做。呼叫 MCP 工具 aigile_me 確認 MCP 能用並核對身分，收完訊息後告訴所屬人類「接好了，請開著視窗接工作」。';
  const agyTail = `Antigravity CLI 一律走前景（視窗開著才會接群組的工作，關掉也不會漏，下次打開再處理）：watcher 已在背景跑，請先呼叫 MCP 工具 aigile_me 確認 MCP 能用（不能用就照實說），處理完手上的訊息後用背景執行開等待腳本（${wait}）讓新通知直接叫醒這個視窗；最後告訴所屬人類：「接好了；視窗開著才會接群組的工作，關掉也不會漏，下次打開再處理」。`;
  // Copilot CLI 不自動叫醒，不開 watcher、不開等待腳本；平台操作用 MCP
  const copilotTail = 'Copilot CLI 目前不自動叫醒：不開 watcher、不開等待腳本。平台操作用 MCP 工具（先呼叫 aigile_me 確認 MCP 能用，不能用就照實說）。最後用一句話告訴所屬人類：「接好了；要我做事時開 Copilot CLI 叫我」';
  let prompt;
  if (first) prompt = TOOL === 'antigravity'
    ? `你是 ${AGENT}，${NO_LAUNCH ? '請重貼一行啟動開啟 Antigravity CLI 並完成首次簽到' : '一行啟動已完成首次簽到並保存游標，請勿重複簽到'}。用 aigile_memory 讀取工作記憶，依規格 4.1 收一輪訊息。接入設定在 ${posix(path.join(DIR, 'onboarding.md'))}。所屬人類已用一行啟動同意待命。${agyTail}`
    : TOOL === 'copilot'
    ? `你是 ${AGENT}，這是初次接入：照 ${posix(path.join(DIR, 'onboarding.md'))} 做（Token 已存在 ${posix(tokFile)}，不要印出）。所屬人類已用一行啟動接入。${copilotTail}。`
    : TOOL === 'codex'
    ? `你是 ${AGENT}，${NO_LAUNCH ? '請重貼一行啟動開啟 Codex 並完成首次簽到' : '一行啟動已完成首次簽到並保存游標，請勿重複簽到'}。用 aigile_memory 讀取工作記憶，依規格 4.1 收一輪訊息。接入設定在 ${posix(path.join(DIR, 'onboarding.md'))}。所屬人類已用一行啟動同意待命。${codexTail}`
    : `你是 ${AGENT}，這是初次接入：照 ${posix(path.join(DIR, 'onboarding.md'))} 做（Token 已存在 ${posix(tokFile)}，不要印出）。所屬人類已用一行啟動同意待命，watcher 已在背景跑；接好後用背景執行開等待腳本：${wait}`;
  else {
    const r = await get(`/api/me/reconnect?tool=${TOOL}&start=1`);
    fs.writeFileSync(path.join(DIR, 'reconnect.md'), await r.text());
    prompt = TOOL === 'antigravity'
      ? `你是 ${AGENT}，剛用一行啟動重新開：照 ${posix(path.join(DIR, 'reconnect.md'))} 重新接上（不要重新簽到、游標沿用），跑一輪收訊息。${agyTail}`
    : TOOL === 'copilot'
      ? `你是 ${AGENT}，剛用一行啟動重新開：照 ${posix(path.join(DIR, 'reconnect.md'))} 重新接上（不要重新簽到、游標沿用），跑一輪收訊息。${copilotTail}。`
      : TOOL === 'codex'
      ? `你是 ${AGENT}，剛用一行啟動重新開：照 ${posix(path.join(DIR, 'reconnect.md'))} 重新接上（不要重新簽到、游標沿用），跑一輪收訊息。${codexTail}`
      : `你是 ${AGENT}，剛用一行啟動重新開：照 ${posix(path.join(DIR, 'reconnect.md'))} 重新接上（不要重新簽到、游標沿用）。watcher 已在背景跑；跑完一輪就用背景執行開等待腳本待命：${wait}`;
  }
  const say = prompt.replace(/"/g, "'");
  if (NO_LAUNCH) { out(`✓ 待命提示：${prompt}`); out(`完成（--no-launch：沒有開 ${{ codex: 'Codex', antigravity: 'Antigravity CLI', copilot: 'Copilot CLI' }[TOOL] || 'Claude Code'}）。`); }
  else if (TOOL === 'antigravity') {
    out('✓ 開 Antigravity CLI（互動模式，帶 AIGILE_AGENT）。開著視窗才會處理，關掉就等下次打開');
    const bin = process.env.AIGILE_ANTIGRAVITY_BIN || process.env.AGY_BIN || 'agy';
    const env = { ...process.env, AIGILE_AGENT: AGENT, AIGILE_FOREGROUND: '1', AIGILE_FG_PID: String(process.pid) };
    try { fs.writeFileSync(fgStateFile, JSON.stringify({ pid: process.pid, state: 'busy', at: Date.now() })); } catch {}
    const binIsPath = fs.existsSync(bin);
    const list = ['-i', prompt];
    const r = /\.m?js$/i.test(bin) && binIsPath
      ? spawnSync(process.execPath, [bin, ...list], { stdio: 'inherit', env })
      : /\.(?:cmd|bat)$/i.test(bin) || (!binIsPath && /\s/.test(bin))
        ? spawnSync(`${binIsPath ? `"${bin}"` : bin} -i "${say}"`, { stdio: 'inherit', env, shell: true })
        : spawnSync(bin, list, { stdio: 'inherit', env });
    unlock();
    if (r.error || r.status === null) fail('Antigravity CLI', `開不起來（${r.error?.message || '找不到 agy 指令'}）`, '確認已安裝 Antigravity CLI（agy 指令）並登入過，再貼一次');
    out('✓ Antigravity CLI 已關，有新通知會等下次開視窗再處理');
    process.exitCode = r.status;
  }
  else if (TOOL === 'codex') {
    out('✓ 開 Codex（互動模式，帶 AIGILE_AGENT；沙盒只開網路）。Codex 視窗開著才會處理工作；關掉的話，工作會等你下次打開再做');
    const bin = process.env.AIGILE_CODEX_BIN || process.env.CODEX_BIN || 'codex';
    const sb = ['-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
    const env = { ...process.env, AIGILE_AGENT: AGENT };
    const binIsPath = fs.existsSync(bin);
    const helper = path.resolve(W, 'aigile-codex-ui.mjs');
    let r;
    if (cfg.files?.['aigile-codex-ui.mjs'] && fs.existsSync(helper)) {
      try {
        const { launchForeground } = await import(pathToFileURL(helper).href);
        r = await launchForeground({ dir: DIR, bin, args: sb, env, prompt, onReady: startWatcher });
      } catch (error) {
        out(`同視窗啟動失敗：${error.message}`);
      }
    }
    if (!r) {
      startWatcher();
      out('此 CLI 使用一般前景視窗，由等待腳本接收門鈴。');
      prompt += ' 收完訊息後在這個前景視窗執行等待腳本：' + wait;
      r = /\.m?js$/i.test(bin) && fs.existsSync(bin) ? spawnSync(process.execPath, [bin, ...sb, prompt], { stdio: 'inherit', env })
        : process.platform === 'win32' || (!binIsPath && /\s/.test(bin))
          ? spawnSync(`${binIsPath ? `"${bin}"` : bin} ${sb.join(' ')} "${prompt.replace(/"/g, "'")}"`, { stdio: 'inherit', env, shell: true })
          : spawnSync(bin, [...sb, prompt], { stdio: 'inherit', env });
    }
    unlock();
    if (r.error || r.status === null) fail('Codex', `開不起來（${r.error?.message || '找不到 codex 指令'}）`, '確認已安裝 Codex CLI（codex 指令），再貼一次');
    out('✓ Codex 已關，通知保留到下次開窗');
    process.exitCode = r.status;
  } else if (TOOL === 'copilot') {
    // Copilot CLI 互動模式（-i 帶入提示並直接執行）。目前不自動叫醒，所以不開 watcher。
    // --additional-mcp-config：這次對話的 aigile 直接帶這隻 AI 的代號（蓋掉同名的全機設定；檔案裡沒有 Token，轉接腳本讀 .token）
    const mcpFile = path.join(DIR, 'copilot-mcp.json');
    const mcpPath = posix(path.join(process.env.AIGILE_HOME || os.homedir(), '.aigile', 'aigile-mcp.mjs'));
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { aigile: { type: 'local', command: 'node', args: [mcpPath], env: { AIGILE_AGENT: AGENT }, tools: ['*'] } } }, null, 2) + '\n');
    out('✓ 開 Copilot CLI（互動模式，帶 AIGILE_AGENT；這次對話的 aigile MCP 用你的代號）。目前不自動叫醒：要它做事時，開 Copilot CLI 叫它');
    // AIGILE_COPILOT_BIN 給測試用假的 copilot
    const bin = process.env.AIGILE_COPILOT_BIN || 'copilot';
    const env = { ...process.env, AIGILE_AGENT: AGENT };
    const mcpArg = '@' + posix(path.resolve(mcpFile)); // 絕對路徑：不靠 copilot 從哪個資料夾解讀
    const list = ['--additional-mcp-config', mcpArg, '-i', prompt];
    const r = /\.m?js$/i.test(bin) && fs.existsSync(bin) ? spawnSync(process.execPath, [bin, ...list], { stdio: 'inherit', env })
      : process.platform === 'win32'
        ? spawnSync(`${fs.existsSync(bin) ? `"${bin}"` : bin} --additional-mcp-config "${mcpArg}" -i "${say}"`, { stdio: 'inherit', env, shell: true })
        : spawnSync(bin, list, { stdio: 'inherit', env });
    if (r.error || r.status === null) fail('Copilot CLI', `開不起來（${r.error?.message || '找不到 copilot 指令'}）`, '確認已安裝 GitHub Copilot CLI（copilot 指令）並登入過，再貼一次');
    process.exitCode = r.status;
  } else {
    out('✓ 開 Claude Code（帶 AIGILE_AGENT，通用 MCP 認得你）');
    const bin = process.env.AIGILE_CLAUDE_BIN || 'claude';
    const env = { ...process.env, AIGILE_AGENT: AGENT };
    const r = /\.m?js$/i.test(bin) && fs.existsSync(bin) ? spawnSync(process.execPath, [bin, prompt], { stdio: 'inherit', env })
      : spawnSync(`${bin} "${say}"`, { stdio: 'inherit', env, shell: true });
    if (r.error || r.status === null) fail('Claude Code', `開不起來（${r.error?.message || '找不到 claude 指令'}）`, '確認已安裝 Claude Code（claude 指令），再貼一次');
    process.exitCode = r.status;
  }
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.exitCode = 1;
}
