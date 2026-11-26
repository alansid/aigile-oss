// Aigile-Switch 本機 AI 啟動器（零依賴，Node 22+）
// 安全底線：
//   - 資料夾與 AI 只能在本機用 npx aigile-cli add 登記；伺服器送來的任何非啟動請求一律拒絕並記錄。
//   - 不執行任意指令、不下載程式；只用本機白名單裡的資料夾與寫死的三個工具（claude / codex / antigravity）開新終端機。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ALLOWED_TOOLS = ['claude', 'codex', 'antigravity'];
const FORBIDDEN_JOB_KEYS = ['command', 'cmd', 'script', 'eval', 'exec', 'url', 'download', 'shell', 'args', 'code'];
const CLI_ENTRY = fileURLToPath(new URL('../bin/aigile-launcher.mjs', import.meta.url));

export const launcherHome = (env = process.env) => env.AIGILE_LAUNCHER_HOME || path.join(os.homedir(), '.aigile-launcher');

export function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

const normPath = p => {
  const r = path.resolve(expandHome(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const pathEqual = (a, b) => !!a && !!b && normPath(a) === normPath(b);

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export const readConfig = (home = launcherHome()) => readJsonFile(path.join(home, 'config.json'), null);
export const writeConfig = (cfg, home = launcherHome()) => writePrivateJson(path.join(home, 'config.json'), cfg);
function registeredFolders(home) {
  const dir = path.join(home,'folders');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => readJsonFile(path.join(dir,name), null)).filter(record => record?.folder);
}

export function appendLocalLog(entry, home = launcherHome()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const safe = {
    at: new Date().toISOString(),
    jobId: entry.jobId || null,
    aiId: entry.aiId || null,
    agent: entry.agent || '',
    folder: entry.folder || '',
    tool: entry.tool || '',
    status: entry.status,
    detail: entry.detail || '',
  };
  fs.appendFileSync(path.join(home, 'logs.jsonl'), JSON.stringify(safe) + '\n', { mode: 0o600 });
  return safe;
}

export function readLocalLogs(home = launcherHome(), limit = 20) {
  try {
    const lines = fs.readFileSync(path.join(home, 'logs.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function autostartTarget({ env = process.env, platform = process.platform, home = launcherHome() } = {}) {
  const siteKey = path.basename(home);
  const suffix = /^[a-f0-9]{64}$/.test(siteKey) && path.basename(path.dirname(home)) === 'sites' ? '-' + siteKey : '';
  const customDir = env.AIGILE_LAUNCHER_AUTOSTART_DIR || '';
  if (platform === 'win32') {
    const dir = customDir || path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return { kind: 'win32', file: path.join(dir, 'aigile-launcher' + suffix + '.vbs') };
  }
  if (platform === 'darwin') {
    const dir = customDir || path.join(os.homedir(), 'Library', 'LaunchAgents');
    return { kind: 'darwin', file: path.join(dir, 'dev.aigile.launcher' + suffix + '.plist'), label: 'dev.aigile.launcher' + suffix };
  }
  const dir = customDir || path.join(os.homedir(), '.config', 'systemd', 'user');
  return { kind: 'linux', file: path.join(dir, 'aigile-launcher' + suffix + '.service') };
}

export function installAutostart({ home = launcherHome(), env = process.env, platform = process.platform } = {}) {
  const t = autostartTarget({ env, platform, home });
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  const nodeBin = process.execPath;
  if (t.kind === 'win32') {
    const homeEnv = home.replace(/"/g, '""');
    const cmd = `cmd /c set "AIGILE_LAUNCHER_HOME=${homeEnv}" && "${nodeBin}" "${CLI_ENTRY}" run`;
    const vbs = `' Aigile-Switch Launcher autostart\r\nCreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
    fs.writeFileSync(t.file, vbs, 'utf8');
  } else if (t.kind === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${t.label}</string>
  <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${CLI_ENTRY}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>AIGILE_LAUNCHER_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>\n`;
    fs.writeFileSync(t.file, plist, 'utf8');
    if (!env.AIGILE_LAUNCHER_AUTOSTART_DIR && env.AIGILE_LAUNCHER_NO_LAUNCHCTL !== '1') {
      spawnSync('launchctl', ['load', '-w', t.file], { stdio: 'ignore' });
    }
  } else {
    const unit = `[Unit]\nDescription=Aigile-Switch AI Launcher\nAfter=network-online.target\n\n[Service]\nEnvironment="AIGILE_LAUNCHER_HOME=${home}"\nExecStart="${nodeBin}" "${CLI_ENTRY}" run\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    fs.writeFileSync(t.file, unit, 'utf8');
  }
  return t;
}

export function removeAutostart({ home = launcherHome(), env = process.env, platform = process.platform } = {}) {
  const t = autostartTarget({ env, platform, home });
  if (t.kind === 'darwin' && fs.existsSync(t.file) && !env.AIGILE_LAUNCHER_AUTOSTART_DIR && env.AIGILE_LAUNCHER_NO_LAUNCHCTL !== '1') {
    spawnSync('launchctl', ['unload', '-w', t.file], { stdio: 'ignore' });
  }
  try { fs.rmSync(t.file, { force: true }); } catch {}
  return t;
}

// 寫死的開終端機方式：絕不接受伺服器字串，只依照本機白名單 entry（tool、agent、folder）開新視窗
export function buildLaunchSpec(entry, base) {
  const tool = entry.tool;
  if (!ALLOWED_TOOLS.includes(tool)) throw new Error(`不允許的工具：${tool}`);
  return { tool, agent: entry.agent, cwd: entry.folder, cmd: process.execPath, args: [], env: { AIGILE_AGENT: entry.agent } };
}

export function defaultSpawnTerminal(spec) {
  const env = { ...process.env, ...spec.env };
  const escPs = s => `'${String(s).replace(/'/g, "''")}'`;
  if (process.platform === 'win32') {
    const argv = [spec.cmd, ...spec.args].map(escPs).join(' ');
    const line = `& ${argv}`;
    const encoded = Buffer.from(line, 'utf16le').toString('base64');
    const child = spawn('cmd.exe', ['/d', '/c', 'start', 'powershell.exe', '-NoProfile', '-NoExit', '-EncodedCommand', encoded], {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { pid: child.pid || 0 };
  }
  if (process.platform === 'darwin') {
    const script = 'on run argv\nset line to "cd " & quoted form of item 1 of argv & " && env " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv\nrepeat with arg in items 4 thru -1 of argv\nset line to line & " " & quoted form of (contents of arg)\nend repeat\ntell application "Terminal" to do script line\nend run';
    const child = spawn('osascript', ['-e', script, '--', spec.cwd, 'AIGILE_AGENT=' + spec.agent, 'AIGILE_LAUNCHER_HOME=' + env.AIGILE_LAUNCHER_HOME, spec.cmd, ...spec.args], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid || 0 };
  }
  const terminal = ['/usr/bin/x-terminal-emulator','/usr/bin/xterm'].find(file => fs.existsSync(file));
  if (!terminal || !(env.DISPLAY || env.WAYLAND_DISPLAY)) throw new Error('找不到圖形終端機');
  const child = spawn(terminal, ['-e',spec.cmd,...spec.args], {cwd:spec.cwd,env,detached:true,stdio:'ignore'});
  child.unref();
  return { pid: child.pid || 0 };
}

const bundledStarter = fileURLToPath(new URL('../runtime/aigile-start.mjs', import.meta.url));

export async function executeLaunchJob(job, { home = launcherHome(), base = '', token = '', spawnTerminal = defaultSpawnTerminal, fetchFn = fetch } = {}) {
  const ack = async (status, detail = '') => {
    appendLocalLog({ jobId: job?.id, aiId: job?.aiId, agent: job?.agent, folder: job?.folder, tool: job?.tool, status, detail }, home);
    if (base && token && job?.id) {
      await fetchFn(`${base.replace(/\/+$/, '')}/api/launcher/jobs/${encodeURIComponent(job.id)}/ack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, detail }),
      }).catch(() => {});
    }
    return { status, detail };
  };

  if (!job || typeof job !== 'object' || Array.isArray(job)) return ack('refused', 'illegal_request');
  if (job.action !== 'launch') return ack('refused', 'illegal_action');
  for (const k of FORBIDDEN_JOB_KEYS) {
    if (job[k] !== undefined && job[k] !== null && job[k] !== '') return ack('refused', 'illegal_payload');
  }

  // 只看本機 已登記資料夾，絕不用伺服器給的路徑或指令
  if (typeof job.folder !== 'string' || !path.isAbsolute(job.folder)) return ack('refused', 'folder not registered');
  const digest = createHash('sha256').update(normPath(job.folder)).digest('hex');
  const local = readJsonFile(path.join(home, 'folders', digest + '.json'), null);
  if (!local || !pathEqual(local.folder, job.folder)) return ack('refused', 'folder not registered');
  if (!fs.existsSync(local.folder) || !fs.statSync(local.folder).isDirectory() || !pathEqual(fs.realpathSync(local.folder), local.folder)) return ack('refused', 'folder missing');
  if (!ALLOWED_TOOLS.includes(job.tool)) return ack('refused', 'tool not allowed');
  const entry = { folder: local.folder, agent: job.agent, tool: job.tool };
  try {
    if (!base || !token || !fs.existsSync(bundledStarter)) return ack('refused', 'launcher_update_required');
    await checkLauncherVersion(base, fetchFn);
    const spec = buildLaunchSpec(entry, base);
    if (!/^ljob_[a-z0-9_-]+$/i.test(job.id) || typeof entry.agent !== 'string' || !/^[A-Z0-9]+_[A-Z0-9]+$/.test(entry.agent)) return ack('refused', 'illegal_request');
    spec.args = [bundledStarter, '--agent', entry.agent, '--base', base, '--tool', entry.tool, '--launcher-job', job.id];
    if (job.transport === 'rest') spec.args.push('--no-mcp');
    spec.env.AIGILE_LAUNCHER_HOME = home;
    await spawnTerminal(spec);
    return ack('opened', '');
  } catch (error) {
    if (error instanceof LauncherVersionError) {
      console.error(error.message);
      return ack('refused', 'launcher_update_required');
    }
    return ack('refused', 'spawn_failed');
  }
}

export async function pollOnce({ home = launcherHome(), fetchFn = fetch, spawnTerminal = defaultSpawnTerminal } = {}) {
  const cfg = readConfig(home);
  if (!cfg?.base || !cfg?.token) throw new Error('還沒配對這台電腦，請先執行 npx aigile-cli <站台網址>');
  const windows = path.join(home, 'windows');
  if (fs.existsSync(windows)) {
    for (const id of fs.readdirSync(windows).filter(name => /^ljob_[a-z0-9_-]+$/i.test(name))) {
      const file = path.join(windows, id);
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); continue; } catch (err) { if (err.code !== 'ESRCH') continue; }
      const response = await fetchFn(cfg.base + '/api/launcher/jobs/' + id + '/closed', {
        method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(10000),
      });
      if (response.ok || response.status === 404) fs.rmSync(file, { force: true });
    }
  }
  const r = await fetchFn(`${cfg.base.replace(/\/+$/, '')}/api/launcher/poll`, {
    headers: { Authorization: `Bearer ${cfg.token}`, 'X-Aigile-Source': 'launcher' },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 401) throw new Error('LAUNCHER_DISABLED: 啟動器已停用，請重新配對');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const results = [];
  for (const job of data.jobs || []) {
    results.push(await executeLaunchJob(job, { home, base: cfg.base, token: cfg.token, spawnTerminal, fetchFn }));
  }
  return { ...data, results };
}

function parseOpts(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['no-daemon', 'json'].includes(a.slice(2))) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

function stopDaemon(home) {
  const instance = readJsonFile(path.join(home, 'daemon-instance.json'), null);
  if (instance?.nonce) writePrivateJson(path.join(home, 'stop-request.json'), { nonce: instance.nonce });
}

function startDaemonBg(home) {
  const instance = readJsonFile(path.join(home, 'daemon-instance.json'), null);
  if (instance?.pid && !readJsonFile(path.join(home, 'stop-request.json'), null)) {
    try { process.kill(instance.pid, 0); return instance.pid; } catch {}
  }
  const child = spawn(process.execPath, [CLI_ENTRY, 'run'], {
    env: { ...process.env, AIGILE_LAUNCHER_HOME: home },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function localHttpHost(host) {
  // URL has already canonicalized IPv4 literals and validated the hostname.
  return host === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host)
    || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host) || host.endsWith('.local');
}

// The starter is pinned by content hash, so sites may require an exact release.
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
class LauncherVersionError extends Error {}
async function checkLauncherVersion(base, fetchFn) {
  const response = await fetchFn(base + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('無法確認站台版本，請稍後再試');
  const range = (await response.json()).launcherVersions;
  const min = versionParts(range?.min), max = versionParts(range?.max), local = versionParts(packageVersion);
  if (!min || !max || !local || compareVersions(min, max) > 0) throw new Error('站台未提供有效的啟動器版本範圍，請確認站台已更新');
  if (compareVersions(local, min) < 0 || compareVersions(local, max) > 0) {
    throw new LauncherVersionError(`請將原指令開頭改為 npx aigile-cli@${range.max}，沿用後面的站台網址`);
  }
}

async function browserPairCode(base, fetchFn, deviceToken) {
  const secret = randomUUID();
  const response = await fetchFn(base + '/api/launcher/browser-request', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, deviceToken, name: os.hostname(), platform: process.platform, folder: fs.realpathSync(process.cwd()) }),
  });
  if (!response.ok) throw new Error('無法建立配對請求（HTTP ' + response.status + '）');
  const { code: confirmationCode } = await response.json();
  if (!/^[0-9A-F]{8}$/.test(confirmationCode)) throw new Error('無效的確認碼');
  console.log('回到原本的「在電腦上跑」視窗，輸入 ' + confirmationCode + '。這組碼十分鐘內有效。');
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const res = await fetchFn(base + '/api/launcher/browser-result', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }),
    });
    if (!res.ok) throw new Error('無法查詢瀏覽器授權結果');
    const { code } = await res.json();
    if (/^\d{6}$/.test(code)) return { code, secret };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('瀏覽器配對已逾時，請重新執行指令');
}

function siteProfiles(root) {
  const dir = path.join(root, 'sites');
  const homes = [root];
  if (fs.existsSync(dir)) for (const key of fs.readdirSync(dir)) {
    if (/^[a-f0-9]{64}$/.test(key)) homes.push(path.join(dir, key));
  }
  return homes.map(home => ({ home, cfg: readConfig(home) })).filter(profile => profile.cfg?.base);
}

export async function main(argv, { env = process.env, fetchFn = fetch, spawnTerminal = defaultSpawnTerminal } = {}) {
  let home = launcherHome(env);
  const { pos, opts } = parseOpts(argv);
  const cmd = pos[0] || 'help';

  if (pos.length === 1 && /^https?:\/\//i.test(cmd)) {
    const endpoint = URL.parse(cmd);
    if (!endpoint || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
        !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && localHttpHost(endpoint.hostname)))) {
      throw new Error('Invalid launcher server URL');
    }
    if (endpoint.protocol === 'http:') console.warn('這是未加密的連線，建議使用 https');
    const base = endpoint.origin;
    const previous = readConfig(home);
    if (previous && previous.base !== base) home = path.join(home, 'sites', createHash('sha256').update(base).digest('hex'));
    await checkLauncherVersion(base, fetchFn);
    const device = readConfig(home);
    const consent = await browserPairCode(base, fetchFn, device?.base === base ? device.token : undefined);
    const name = String(opts.name || os.hostname() || '我的電腦').trim();
    const r = await fetchFn(`${base}/api/launcher/pair`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...consent, ...(device?.base === base && device.token ? { deviceToken: device.token } : {}), name, platform: process.platform, workspace: fs.realpathSync(process.cwd()) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `配對失敗（HTTP ${r.status}）`);
    const cfg = { base, launcherId: d.launcherId, token: d.token, name: d.name };
    writeConfig(cfg, home);
    const folder = fs.realpathSync(process.cwd());
    const digest = createHash('sha256').update(normPath(folder)).digest('hex');
    writePrivateJson(path.join(home, 'folders', digest + '.json'), { folder });
    installAutostart({ home, env });
    if (!opts['no-daemon']) startDaemonBg(home);
    console.log(`✓ 已配對「${d.name}」（開機自動啟動已設定）。`);
    return 0;
  }

  if (cmd === 'add') {
    const profiles = siteProfiles(home);
    const selected = pos[1] ? profiles.find(p => p.cfg.base === new URL(pos[1]).origin) : profiles.length === 1 && profiles[0];
    if (!selected) throw new Error(profiles.length ? '請指定已配對的站台網址' : '請先在這個資料夾執行 npx aigile-cli <站台網址> 配對');
    const folder = fs.realpathSync(process.cwd());
    const digest = createHash('sha256').update(normPath(folder)).digest('hex');
    writePrivateJson(path.join(selected.home, 'folders', digest + '.json'), { folder });
    const response = await fetchFn(selected.cfg.base + '/api/launcher/folders', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + selected.cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    if (!response.ok) throw new Error('資料夾同步失敗，請重跑 add（HTTP ' + response.status + '）');
    console.log('已登記資料夾：' + folder);
    return 0;
  }

  if (!pos.length) {
    const folder = fs.realpathSync(process.cwd());
    const digest = createHash('sha256').update(normPath(folder)).digest('hex');
    const profiles = siteProfiles(home).filter(p => pathEqual(readJsonFile(path.join(p.home,'folders',digest + '.json'),null)?.folder, folder));
    if (profiles.length === 1) { startDaemonBg(profiles[0].home); return 0; }
    if (profiles.length > 1) throw new Error('請用 npx aigile-cli start <站台網址> 選擇站台');
  }

  if (['start', 'stop', 'status'].includes(cmd)) {
    const profiles = siteProfiles(home);
    if (cmd === 'status' && profiles.length > 1 && !pos[1]) {
      const sites = profiles.map(({ home, cfg }) => ({ base: cfg.base, computer: cfg.name, items: registeredFolders(home) }));
      console.log(opts.json ? JSON.stringify({ sites }) : sites.map(s => s.base + ' · ' + s.computer).join('\n'));
      return 0;
    }
    if (profiles.length > 1 && !pos[1]) throw new Error('請在指令後指定站台網址');
    const target = pos[1] && URL.parse(pos[1].includes('://') ? pos[1] : 'https://' + pos[1]);
    const profile = pos[1] ? profiles.find(p => p.cfg.base === target?.origin) : profiles[0];
    if (!profile && (cmd !== 'status' || pos[1])) throw new Error('找不到已配對的站台');
    if (profile) home = profile.home;
    if (cmd === 'start') { installAutostart({ home, env }); startDaemonBg(home); return 0; }
    if (cmd === 'stop') { removeAutostart({ home, env }); stopDaemon(home); return 0; }
  }
  if (cmd === 'list' || cmd === 'status') {
    const cfg = readConfig(home);
    const items = registeredFolders(home);
    if (opts.json) {
      console.log(JSON.stringify({ paired: !!cfg, computer: cfg?.name || null, base: cfg?.base || null, items, logs: readLocalLogs(home, 10) }, null, 2));
      return 0;
    }
    console.log(cfg ? `已配對：${cfg.name}（${cfg.base}）` : '尚未配對');
    for (const x of items) console.log(`  - ${x.folder}`);
    if (!items.length) console.log('  （尚未登記任何資料夾）');
    return 0;
  }

  if (cmd === 'logs') {
    for (const l of readLocalLogs(home, 20)) console.log(`${l.at} ${l.agent || l.aiId} ${l.status} ${l.detail}`);
    return 0;
  }

  if (cmd === 'run') {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const instanceFile = path.join(home,'daemon-instance.json');
    writePrivateJson(instanceFile, { pid:process.pid, nonce });
    const cleanup = () => {
      if (readJsonFile(instanceFile,null)?.nonce === nonce) fs.rmSync(instanceFile,{force:true});
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    const intervalMs = Math.max(500, Number(opts.interval || env.AIGILE_LAUNCHER_POLL_MS) || 3000);
    let stopped = false;
    const loop = async () => {
      while (!stopped && readJsonFile(instanceFile,null)?.nonce === nonce && readJsonFile(path.join(home,'stop-request.json'),null)?.nonce !== nonce) {
        try { await pollOnce({ home, fetchFn, spawnTerminal }); }
        catch (e) { if (String(e?.message || '').startsWith('LAUNCHER_DISABLED')) { stopped = true; break; } }
        await new Promise(r => setTimeout(r, intervalMs));
      }
      cleanup();
    };
    await loop();
    return 0;
  }

  if (cmd === 'uninstall') {
    stopDaemon(home);
    removeAutostart({ home, env });
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    console.log('✓ 已移除啟動器、開機啟動設定與本機登記。');
    return 0;
  }

  console.log(`Aigile-Switch AI 啟動器
用法：
  npx aigile-cli https://example.com
  npx aigile-cli start | status | stop [站台網址]
  npx aigile-cli add [站台網址]
  npx aigile-launcher list | status | logs | run | uninstall`);
  return 0;
}
