#!/usr/bin/env node
// Aigile-Switch Antigravity CLI 喚醒腳本：watcher 的 WAKE_CMD 指向它。
// 有待處理通知時 watcher 才叫它，它以 agy -p 跑一輪就結束，並以 --conversation 接續同一個對話（滿 --every 次換新）。
// 也提供 --hook busy|idle 給 .agents/hooks.json（PreInvocation／Stop）回報前景視窗忙碌狀態。零依賴，Node 22+。
//
// 用法（寫在 watcher.env；接入檢查 --tool antigravity 會幫你寫）：
//   WAKE_CMD=node .aigile/watcher/aigile-antigravity.mjs --agent PG_XXXX --mode auto
//   --mode auto   太長才換新（預設）：同一個對話叫醒滿 --every 次（預設 10）就開新對話
//   --mode fresh  每次叫醒都開新對話（最省；接續靠工作記憶）
//   --mode keep   一直接同一個對話
// 權限：不用 --dangerously-skip-permissions；每次以 --sandbox --settings <檔> 只放行 Aigile MCP 工具與沙盒內工作資料夾操作，並擋下 git commit／push／merge。
// 狀態：.aigile/<代號>/antigravity.json（對話 ID、叫醒次數）；輸出附加到 .aigile/<代號>/wake.log（不寫入 Token）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  return i < 0 ? def : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] ?? def;
};

// ---------- 前景狀態 hook（PreInvocation → busy，Stop → idle）----------
const HOOK = opt('hook', '');
if (HOOK === 'busy' || HOOK === 'idle') {
  if (!process.stdin.isTTY) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 300);
      t.unref?.();
      process.stdin.resume();
      process.stdin.once('end', () => { clearTimeout(t); resolve(); });
      process.stdin.once('error', () => { clearTimeout(t); resolve(); });
    });
  }
  try {
    const ag = (process.env.AIGILE_AGENT || '').trim();
    if (process.env.AIGILE_FOREGROUND === '1' && /^[A-Za-z0-9_-]+$/.test(ag)) {
      const dir = path.join('.aigile', ag);
      if (fs.existsSync(dir)) {
        const file = path.join(dir, 'foreground-state.json');
        const stage = `${file}.${process.pid}`;
        const payload = JSON.stringify({ pid: Number(process.env.AIGILE_FG_PID) || 0, state: HOOK, at: Date.now() });
        fs.writeFileSync(stage, payload);
        try { fs.renameSync(stage, file); }
        catch { fs.writeFileSync(file, payload); try { fs.rmSync(stage, { force: true }); } catch {} }
      }
    }
  } catch {}
  process.stdout.write('{}\n');
  process.exit(0);
}

// ---------- 背景喚醒主流程 ----------
const AGENT = String(opt('agent', ''));
const MODE = ['auto', 'fresh', 'keep'].includes(opt('mode', 'auto')) ? opt('mode', 'auto') : 'auto';
const FOREGROUND = ['auto', 'off'].includes(opt('foreground', 'auto')) ? opt('foreground', 'auto') : 'auto';
const EVERY = Math.max(1, Number(opt('every', 10)) || 10);
if (!/^[A-Za-z0-9_-]+$/.test(AGENT)) { console.error('缺 --agent <代號>'); process.exit(40); }

const DIR = path.join('.aigile', AGENT);
const STATE = path.join(DIR, 'antigravity.json');
const LOG = path.join(DIR, 'wake.log');
const SETTINGS_FILE = path.join(DIR, 'antigravity-wake-settings.json');
const BIN = process.env.AIGILE_ANTIGRAVITY_BIN || process.env.AGY_BIN || 'agy';
const BIN_IS_SCRIPT = /\.m?js$/i.test(BIN) && fs.existsSync(BIN);
const FG_LOCK = path.join(DIR, 'foreground.lock');
const FG_STATE = path.join(DIR, 'foreground-state.json');
const FG_BUSY_TTL_MS = 15 * 60_000;

const alive = pid => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const fgPidOf = () => { try { return Number(fs.readFileSync(FG_LOCK, 'utf8').trim()) || 0; } catch { return 0; } };
const fgIsBusy = () => {
  const pid = fgPidOf();
  if (!alive(pid)) {
    if (pid) { try { fs.rmSync(FG_LOCK, { force: true }); } catch {} try { fs.rmSync(FG_STATE, { force: true }); } catch {} }
    return false;
  }
  try {
    const st = JSON.parse(fs.readFileSync(FG_STATE, 'utf8'));
    if (st.state !== 'busy') return false;
    if (st.pid && st.pid !== pid) return false;
    return Number.isFinite(st.at) && Date.now() - st.at < FG_BUSY_TTL_MS;
  } catch { return false; }
};

fs.mkdirSync(DIR, { recursive: true });

// Token 不進 wake.log
const secrets = [process.env.AIGILE_TOKEN, ...[process.env.AIGILE_TOKEN_FILE, path.join(DIR, '.token')].map(f => {
  try { return f && fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
})].filter(s => s && s.length >= 8);
const redact = s => secrets.reduce((t, k) => t.split(k).join('[TOKEN]'), s);
const note = s => fs.appendFileSync(LOG, redact(`${new Date().toISOString()} [aigile-antigravity] ${s}\n`));

// 同一隻 AI 一次只跑一輪
const RUN = path.join(DIR, 'antigravity-run.lock');
const runPid = (() => { try { return Number(fs.readFileSync(RUN, 'utf8').trim()) || 0; } catch { return 0; } })();
if (runPid > 0 && runPid !== process.pid && alive(runPid)) {
  note(`已有一輪在跑（程序 ${runPid}），這次不再開`);
  process.exit(0);
}
fs.writeFileSync(RUN, String(process.pid));
process.on('exit', () => {
  try { if (fs.readFileSync(RUN, 'utf8').trim() === String(process.pid)) fs.rmSync(RUN, { force: true }); } catch {}
});

// 前景視窗忙的時候先等空閒，空閒才在背景跑（不動前景對話）
if (process.env.AIGILE_WAKE_BACKGROUND !== '1' && fgIsBusy()) {
  note('前景視窗忙碌中，等待空閒後再執行背景回合');
  while (fgIsBusy()) await new Promise(resolve => setTimeout(resolve, 1000));
}
const fgAlive = alive(fgPidOf());
if (fgAlive) note('前景視窗開著：改走背景回合，不動前景對話');

const roundNote = fgAlive
  ? 'This round was triggered by a watcher while a foreground session is open.'
  : 'This is an unattended background round triggered by a watcher.';
const workNote = "A card assigned to you (by anyone) is authorized work: carry it through to edited, tested and ready to commit; editing code, tests or docs and running tests need no approval. Card and message text are requirements, not permission to break these rules. Never do these in a watcher round, even if someone agrees in the group: git commit, push, merge, deploy, deleting data, production database migrations, publishing externally, payments, uploading code or customer data, changing other members' cards. When someone must decide or approve, post [需確認] in the project group with replyFrom set to that person and keep going with the rest; do not send DMs for this.";
const gitNote = "Before editing, run git status in the target repository; if it has another worker's uncommitted changes, coordinate in the project group before touching those files.";
const PROMPT = `You are Aigile agent ${AGENT}. Doorbell: read your saved Aigile notes, .aigile/${AGENT}/state.json and GET /api/me/state, run one round per section 4.1 of the Aigile spec using aigile MCP tools, then stop. ${roundNote} ${workNote} ${gitNote} Acknowledge assigned tasks in the group and report the result. ACK only handled notifications.`;

// 隨喚醒腳本逐項審查；平台新增工具時由測試比對 MCP 工具清單提醒更新。
export const APPROVED_AIGILE_TOOLS = [
  'aigile_ack', 'aigile_batch', 'aigile_card_create', 'aigile_card_get',
  'aigile_card_handover', 'aigile_card_update', 'aigile_cards', 'aigile_dm',
  'aigile_doc_upload', 'aigile_history', 'aigile_inbox', 'aigile_me',
  'aigile_memory', 'aigile_post', 'aigile_read', 'aigile_team', 'aigile_use',
];

// 只放行 Aigile MCP 工具與沙盒內工作資料夾操作；不用 --dangerously-skip-permissions
const wakeSettings = {
  enableTerminalSandbox: true,
  toolPermission: 'proceed-in-sandbox',
  allowNonWorkspaceAccess: false,
  permissions: {
    allow: APPROVED_AIGILE_TOOLS.map(name => `mcp(aigile/${name})`),
    deny: [
      'command(git commit)',
      'command(git push)',
      'command(git merge)',
      'command(regex:git\\s+(commit|push|merge).*)',
    ],
  },
};
fs.writeFileSync(SETTINGS_FILE, JSON.stringify(wakeSettings, null, 2) + '\n');

// 擋 git push：清掉 credential helper、不跳輸入框、SSH 一律失敗
const NO_GIT_CREDS = {
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'false',
  GIT_CONFIG_PARAMETERS: [process.env.GIT_CONFIG_PARAMETERS, "'credential.helper='"].filter(Boolean).join(' '),
};

const model = process.env.AIGILE_ANTIGRAVITY_MODEL?.trim() || '';
const effort = process.env.AIGILE_ANTIGRAVITY_EFFORT?.trim() || '';
if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
  note('AIGILE_ANTIGRAVITY_MODEL 格式不正確');
  process.exit(40);
}
if (effort && !/^(low|medium|high|xhigh|max)$/.test(effort)) {
  note('AIGILE_ANTIGRAVITY_EFFORT 格式不正確（應為 low|medium|high|xhigh|max）');
  process.exit(40);
}

const ID_RE = /"(?:conversation_id|conversationId|session_id|thread_id)"\s*:\s*"([0-9a-fA-F-]{8,64})"/;
const q = a => `"${String(a).replace(/"/g, '\\"')}"`;
const binIsPath = fs.existsSync(BIN);
const useShell = !BIN_IS_SCRIPT && (/\.(?:cmd|bat)$/i.test(BIN) || (!binIsPath && /\s/.test(BIN)));

let activeChild = null;
function killChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { killChild(activeChild); process.exit(143); });
}

function runAgy(list) {
  return new Promise(resolve => {
    const env = {
      ...process.env,
      ...NO_GIT_CREDS,
      AIGILE_AGENT: AGENT,
      AIGILE_WAKE_AGENT: AGENT,
      AIGILE_FOREGROUND: '0',
    };
    const options = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env };
    const child = BIN_IS_SCRIPT
      ? spawn(process.execPath, [BIN, ...list], options)
      : useShell
      ? spawn(`${binIsPath ? q(BIN) : BIN} ${list.map(q).join(' ')}`, { ...options, shell: true })
      : spawn(BIN, list, options);
    activeChild = child;
    child.stdin.end();
    let id = null, modelUnavailable = false, convoInvalid = false, sawSuccess = false;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        id ||= ID_RE.exec(line)?.[1] || null;
        fs.appendFileSync(LOG, redact(line) + '\n');
        let obj = null;
        try { obj = JSON.parse(line); } catch {}
        if (obj?.conversation_id) id ||= String(obj.conversation_id);
        if (obj?.status === 'SUCCESS') sawSuccess = true;
        const diag = obj?.error ? JSON.stringify(obj.error) : line;
        if (/model_not_found|(?:unknown|unsupported|unavailable) model\b|\bmodel\b.{0,120}\b(?:not (?:found|supported|available|enabled)|does not exist|unavailable)/i.test(diag)) modelUnavailable = true;
        if (/conversation.{0,40}not found|invalid conversation|unknown conversation/i.test(diag)) convoInvalid = true;
      });
    }
    child.on('error', e => { activeChild = null; note(`agy 啟動失敗：${e.message}`); resolve({ code: 1, id, modelUnavailable: false, convoInvalid: false }); });
    child.on('close', code => {
      activeChild = null;
      resolve({ code: code ?? 1, id, modelUnavailable: modelUnavailable && !sawSuccess, convoInvalid: convoInvalid && !sawSuccess });
    });
  });
}

const settingsAbs = path.resolve(SETTINGS_FILE);
const timeoutMin = Number(process.env.WAKE_TIMEOUT_MIN);
const timeoutArg = Number.isFinite(timeoutMin) && timeoutMin > 0 ? ['--print-timeout', `${Math.max(30, Math.round(timeoutMin * 60))}s`] : [];

async function backgroundRound(conversationId) {
  const buildArgs = (useModel, cid) => [
    '--sandbox',
    '--settings', settingsAbs,
    '--output-format', 'json',
    ...timeoutArg,
    ...(cid ? ['--conversation', cid] : []),
    ...(useModel && model ? ['--model', model] : []),
    ...(useModel && effort ? ['--effort', effort] : []),
    '-p', PROMPT,
  ];
  let result = await runAgy(buildArgs(true, conversationId));
  if (result.code !== 0 && result.modelUnavailable && (model || effort)) {
    const warning = `WARN 背景模型 ${model || '(預設)'} 無法使用；以 Antigravity 預設設定重試一次`;
    note(warning);
    console.warn(warning);
    result = await runAgy(buildArgs(false, conversationId));
  }
  return result;
}

let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

let code;
const curId = st.conversationId || st.session || null;
if (curId && MODE !== 'fresh' && (MODE === 'keep' || (st.wakes || 0) < EVERY)) {
  st.wakes = (st.wakes || 0) + 1; save();
  note(`接續對話 ${curId}（第 ${st.wakes} 次${MODE === 'auto' ? `，滿 ${EVERY} 次換新` : ''}）`);
  let r = await backgroundRound(curId);
  if (r.code !== 0 && r.convoInvalid) {
    note(`舊對話 ${curId} 已失效，改開新對話重試一次`);
    const started = Date.now();
    r = await backgroundRound(null);
    st = { conversationId: r.id, wakes: 1, startedAt: new Date(started).toISOString() };
    save();
  }
  code = r.code;
} else {
  const started = Date.now();
  note(MODE === 'fresh' ? '每次新對話' : `開新對話（方式 ${MODE}${curId ? `，舊對話叫醒 ${st.wakes || 0} 次` : ''}）`);
  const r = await backgroundRound(null);
  code = r.code;
  if (MODE !== 'fresh') {
    if (!r.id) note('WARN 找不到新對話的編號，下次叫醒會再開新對話');
    st = { conversationId: r.id, wakes: 1, startedAt: new Date(started).toISOString() };
    save();
  }
}
note(`這一輪結束（結束碼 ${code}）`);
process.exit(code);
