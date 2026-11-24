// PLAT-436 Aigile-Switch 本機 AI 啟動器（零依賴，Node 22+）
// 安全底線：
//   - 資料夾與 AI 只能在本機用 npx aigile-launcher allow 登記；伺服器送來的任何非啟動請求一律拒絕並記錄。
//   - 不執行任意指令、不下載程式；只用本機白名單裡的資料夾與寫死的三個工具（claude / codex / antigravity）開新終端機。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ALLOWED_TOOLS = ['claude', 'codex', 'antigravity'];
export const DEFAULT_BASE = 'https://aigile-switch.alansid87.workers.dev';
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
export const readAllow = (home = launcherHome()) => {
  const d = readJsonFile(path.join(home, 'allow.json'), null);
  return Array.isArray(d?.items) ? d.items : [];
};
export const writeAllow = (items, home = launcherHome()) => writePrivateJson(path.join(home, 'allow.json'), { version: 1, items });

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
  const customDir = env.AIGILE_LAUNCHER_AUTOSTART_DIR || '';
  if (platform === 'win32') {
    const dir = customDir || path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return { kind: 'win32', file: path.join(dir, 'aigile-launcher.vbs') };
  }
  if (platform === 'darwin') {
    const dir = customDir || path.join(os.homedir(), 'Library', 'LaunchAgents');
    return { kind: 'darwin', file: path.join(dir, 'dev.aigile.launcher.plist'), label: 'dev.aigile.launcher' };
  }
  const dir = customDir || path.join(os.homedir(), '.config', 'systemd', 'user');
  return { kind: 'linux', file: path.join(dir, 'aigile-launcher.service') };
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
  const startScript = path.join(entry.folder, '.aigile', 'watcher', 'aigile-start.mjs');
  const hasStart = fs.existsSync(startScript) && base;
  const cmd = hasStart ? process.execPath : ({ claude: 'claude', codex: 'codex', antigravity: 'agy' }[tool]);
  const cmdArgs = hasStart
    ? [startScript, '--agent', entry.agent, '--base', base, '--tool', tool]
    : (tool === 'antigravity' ? ['-i'] : []);
  return { tool, agent: entry.agent, cwd: entry.folder, cmd, args: cmdArgs, env: { AIGILE_AGENT: entry.agent } };
}

export function defaultSpawnTerminal(spec) {
  const env = { ...process.env, ...spec.env };
  const escPs = s => `'${String(s).replace(/'/g, "''")}'`;
  if (process.platform === 'win32') {
    const argv = [spec.cmd, ...spec.args].map(escPs).join(' ');
    const line = `Set-Location -LiteralPath ${escPs(spec.cwd)}; $env:AIGILE_AGENT=${escPs(spec.agent)}; & ${argv}`;
    const child = spawn('cmd.exe', ['/c', 'start', `Aigile ${spec.agent}`, 'powershell.exe', '-NoExit', '-Command', line], {
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
    const sh = `cd ${JSON.stringify(spec.cwd)} && AIGILE_AGENT=${JSON.stringify(spec.agent)} ${[spec.cmd, ...spec.args].map(a => JSON.stringify(a)).join(' ')}`;
    const child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(sh)}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid || 0 };
  }
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env, detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid || 0 };
}

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

  // 只看本機 allow.json 白名單，絕不用伺服器給的路徑或指令
  const items = readAllow(home);
  const entry = items.find(x => (job.aiId && x.aiId === job.aiId) || (!job.aiId && x.agent && x.agent.toLowerCase() === String(job.agent || '').toLowerCase()));
  if (!entry) return ack('refused', 'folder not registered');
  if (!ALLOWED_TOOLS.includes(entry.tool) || (job.tool && job.tool !== entry.tool)) return ack('refused', 'tool not allowed');
  if (job.folder && !pathEqual(job.folder, entry.folder)) return ack('refused', 'folder not registered');
  if (!fs.existsSync(entry.folder) || !fs.statSync(entry.folder).isDirectory()) return ack('refused', 'folder missing');

  try {
    const spec = buildLaunchSpec(entry, base);
    await spawnTerminal(spec);
    return ack('opened', '');
  } catch (e) {
    return ack('refused', 'spawn_failed: ' + String(e?.message || e).slice(0, 120));
  }
}

export async function pollOnce({ home = launcherHome(), fetchFn = fetch, spawnTerminal = defaultSpawnTerminal } = {}) {
  const cfg = readConfig(home);
  if (!cfg?.base || !cfg?.token) throw new Error('還沒配對這台電腦，請先執行 npx aigile-launcher pair <6位數配對碼>');
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
  const pidFile = path.join(home, 'daemon.pid');
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0 && pid !== process.pid) {
      try { process.kill(pid); } catch {}
    }
    fs.rmSync(pidFile, { force: true });
    return pid;
  } catch { return 0; }
}

function startDaemonBg(home) {
  stopDaemon(home);
  const child = spawn(process.execPath, [CLI_ENTRY, 'run'], {
    env: { ...process.env, AIGILE_LAUNCHER_HOME: home },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export async function main(argv, { env = process.env, fetchFn = fetch, spawnTerminal = defaultSpawnTerminal } = {}) {
  const home = launcherHome(env);
  const { pos, opts } = parseOpts(argv);
  const cmd = pos[0] || 'help';

  if (cmd === 'pair') {
    const code = pos.slice(1).join('').replace(/\D+/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error('請輸入 6 位數配對碼，例：npx aigile-launcher pair 482 913');
    const base = String(opts.base || env.AIGILE_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    const name = String(opts.name || os.hostname() || '我的電腦').trim();
    const r = await fetchFn(`${base}/api/launcher/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, platform: process.platform }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `配對失敗（HTTP ${r.status}）`);
    writeConfig({ base, launcherId: d.launcherId, token: d.token, name: d.name }, home);
    installAutostart({ home, env });
    if (!opts['no-daemon']) startDaemonBg(home);
    console.log(`✓ 已配對「${d.name}」（開機自動啟動已設定）。`);
    console.log('下一步：在要讓 AI 工作的資料夾開啟終端機，將範例代號換成你的 AI 代號：');
    console.log('  npx aigile-launcher allow PG_ABCD . --tool claude');
    return 0;
  }

  if (cmd === 'allow') {
    const cfg = readConfig(home);
    if (!cfg?.token) throw new Error('請先配對這台電腦：npx aigile-launcher pair <6位數配對碼>');
    const agentArg = pos[1];
    const folderRaw = pos[2];
    const tool = String(opts.tool || '').trim();
    if (!agentArg || !folderRaw || !tool) throw new Error('用法：npx aigile-launcher allow <AI代號> <資料夾路徑> --tool <claude|codex|antigravity>');
    if (!ALLOWED_TOOLS.includes(tool)) throw new Error(`工具只能是 ${ALLOWED_TOOLS.join('、')}（收到 ${tool}）`);
    const folder = path.resolve(expandHome(folderRaw));
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`找不到資料夾：${folder}`);

    const meRes = await fetchFn(`${cfg.base.replace(/\/+$/, '')}/api/launcher/me`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    const meData = await meRes.json().catch(() => ({}));
    if (!meRes.ok) throw new Error(meData?.error?.message || `取得 AI 清單失敗（HTTP ${meRes.status}）`);
    const q = agentArg.trim();
    const ai = (meData.ais || []).find(a => a.aiId === q || a.agent.toUpperCase() === q.toUpperCase() || String(a.shortCode || '').toUpperCase() === q.toUpperCase());
    if (!ai) throw new Error(`你名下找不到「${agentArg}」（可填 PG_XXXX 或 participantId）`);

    const items = readAllow(home).filter(x => x.aiId !== ai.aiId);
    items.push({ aiId: ai.aiId, agent: ai.agent, folder, tool, addedAt: new Date().toISOString() });
    writeAllow(items, home);

    const syncRes = await fetchFn(`${cfg.base.replace(/\/+$/, '')}/api/launcher/registrations`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map(({ aiId, agent, folder: f, tool: t }) => ({ aiId, agent, folder: f, tool: t })) }),
    });
    if (!syncRes.ok) {
      const sd = await syncRes.json().catch(() => ({}));
      throw new Error(sd?.error?.message || `同步登記失敗（HTTP ${syncRes.status}）`);
    }
    console.log(`✓ 已本機登記：${ai.name}（${ai.agent}）→ ${folder}（${tool}）`);
    return 0;
  }

  if (cmd === 'remove') {
    const cfg = readConfig(home);
    const key = String(pos[1] || '').trim();
    if (!key) throw new Error('用法：npx aigile-launcher remove <AI代號>');
    const items = readAllow(home).filter(x => x.aiId !== key && x.agent.toUpperCase() !== key.toUpperCase());
    writeAllow(items, home);
    if (cfg?.token) {
      await fetchFn(`${cfg.base.replace(/\/+$/, '')}/api/launcher/registrations`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(({ aiId, agent, folder, tool }) => ({ aiId, agent, folder, tool })) }),
      }).catch(() => {});
    }
    console.log(`✓ 已移除本機登記：${key}`);
    return 0;
  }

  if (cmd === 'list' || cmd === 'status') {
    const cfg = readConfig(home);
    const items = readAllow(home);
    if (opts.json) {
      console.log(JSON.stringify({ paired: !!cfg, computer: cfg?.name || null, base: cfg?.base || null, items, logs: readLocalLogs(home, 10) }, null, 2));
      return 0;
    }
    console.log(cfg ? `已配對：${cfg.name}（${cfg.base}）` : '尚未配對');
    for (const x of items) console.log(`  - ${x.agent} · ${x.folder} · ${x.tool}`);
    if (!items.length) console.log('  （尚未登記任何資料夾）');
    return 0;
  }

  if (cmd === 'logs') {
    for (const l of readLocalLogs(home, 20)) console.log(`${l.at} ${l.agent || l.aiId} ${l.status} ${l.detail}`);
    return 0;
  }

  if (cmd === 'run') {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'daemon.pid'), String(process.pid), 'utf8');
    const cleanup = () => { try { fs.rmSync(path.join(home, 'daemon.pid'), { force: true }); } catch {} process.exit(0); };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    const intervalMs = Math.max(500, Number(opts.interval || env.AIGILE_LAUNCHER_POLL_MS) || 3000);
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
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
  npx aigile-launcher pair <6位數配對碼> [--base <網址>]
  npx aigile-launcher allow <AI代號> <資料夾路徑> --tool <claude|codex|antigravity>
  npx aigile-launcher remove <AI代號>
  npx aigile-launcher list | status | logs | run | uninstall`);
  return 0;
}
