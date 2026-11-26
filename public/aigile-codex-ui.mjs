// A dedicated loopback App Server per foreground launcher. Only its own marked
// conversation is eligible for notifications; other loaded threads are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const descriptor = dir => path.join(dir, 'foreground-ui.json');

export const approvedAigileTools = [
  'aigile_ack', 'aigile_batch', 'aigile_card_create', 'aigile_card_get',
  'aigile_card_handover', 'aigile_card_update', 'aigile_cards', 'aigile_dm',
  'aigile_doc_read', 'aigile_doc_upload', 'aigile_history', 'aigile_inbox', 'aigile_kb_read', 'aigile_kb_search', 'aigile_kb_write', 'aigile_me', // 知識庫工具（kb_write 只寫知識頁，跟發文、改卡同級）
  'aigile_memory', 'aigile_post', 'aigile_read', 'aigile_team', 'aigile_use',
  'aigile_review', 'aigile_review_request', // 審查（送審只帶版本與說明；附 diff 要專案開了上傳、AI 明確聲明，轉接腳本只讀工作區內的 diff 檔）
];

// Reconcile only ordinary TOML tables. Codex validates the result before setup succeeds.
export function missingToolApprovals(config) {
  const additions = [];
  const missing = [];
  const lines = config.split(/\r?\n/);
  for (const tool of approvedAigileTools) {
    const header = '[mcp_servers.aigile.tools.' + tool + ']';
    const index = lines.findIndex(line => line.split('#')[0].trim() === header);
    if (index >= 0) {
      let end = index + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      if (lines.slice(index + 1, end).some(line => /^\s*approval_mode\s*=/.test(line))) continue;
      lines.splice(index + 1, 0, 'approval_mode = "approve"');
    } else {
      additions.push('', header, 'approval_mode = "approve"');
    }
    missing.push(header + '\napproval_mode = "approve"');
  }
  const newline = config.includes('\r\n') ? '\r\n' : '\n';
  return { config: lines.concat(additions).join(newline) + (additions.length ? newline : ''), missing };
}

export function foregroundUI(dir) {
  try {
    const ui = JSON.parse(fs.readFileSync(descriptor(dir), 'utf8'));
    if (!Number.isSafeInteger(ui.pid) || ui.pid <= 0 ||
        Number(fs.readFileSync(path.join(dir, 'foreground.lock'), 'utf8')) !== ui.pid ||
        !/^ws:\/\/127\.0\.0\.1:\d+$/.test(ui.url)) return null;
    process.kill(ui.pid, 0);
    return ui;
  } catch { return null; }
}

async function connect(ui) {
  const socket = new WebSocket(ui.url, { headers: { Authorization: 'Bearer ' + ui.key } });
  const pending = new Map();
  let id = 0;
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve(msg.result);
  };
  socket.onclose = () => {
    for (const call of pending.values()) call.reject(new Error('App Server disconnected'));
    pending.clear();
  };
  const request = async (method, params) => {
    const seq = ++id;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(seq, { resolve, reject });
        timer = setTimeout(() => reject(new Error(method + ' timeout')), 6000);
        socket.send(JSON.stringify({ id: seq, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(seq); }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App Server connection timeout')), 4000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('App Server unavailable')); };
    });
    await request('initialize', { clientInfo: { name: 'aigile_watcher', version: '1' } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    return { request, close: () => socket.close() };
  } catch (error) { socket.close(); throw error; }
}

async function target(request, ui) {
  const { data } = await request('thread/loaded/list', {});
  for (const threadId of data) {
    const { thread } = await request('thread/read', { threadId });
    if (thread.preview?.startsWith(ui.marker)) return thread;
  }
  return null;
}

function status(thread, ui) {
  if (thread) return thread.status?.type === 'idle' ? 'idle' : 'busy';
  // The TUI may still be starting. If its marked thread was later unloaded
  // (for example after /new), never send a notification to an unrelated thread.
  return Date.now() - ui.createdAt < 60_000 ? 'busy' : 'closed';
}

export async function inspectForeground(dir) {
  const ui = foregroundUI(dir);
  if (!ui) return 'closed';
  const rpc = await connect(ui);
  try {
    const thread = await target(rpc.request, ui);
    return status(thread, ui);
  } finally { rpc.close(); }
}

export async function deliverForeground(dir, prompt) {
  while (true) {
    const ui = foregroundUI(dir);
    if (!ui) return false;
    const rpc = await connect(ui);
    try {
      const thread = await target(rpc.request, ui);
      const state = status(thread, ui);
      if (state === 'closed') return false;
      if (state === 'idle') {
        const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
        // Only inspect turn metadata. No model call or transcript reload is needed.
        let idleFailureSince;
        while (true) {
          const recent = await rpc.request('thread/turns/list', {
            threadId: thread.id, sortDirection: 'desc', itemsView: 'notLoaded', limit: 8,
          });
          const current = recent.data.find(item => item.id === turn.id);
          if (current?.status === 'completed') return true;
          if (current?.status === 'failed' || current?.status === 'interrupted') {
            // During startup the on-disk turn can briefly look interrupted while
            // the live TUI is still receiving the response.
            const live = await rpc.request('thread/read', { threadId: thread.id });
            if (live.thread.status?.type === 'idle') {
              idleFailureSince ??= Date.now();
              if (Date.now() - idleFailureSince >= 3000) throw new Error('Foreground turn ' + current.status);
            } else idleFailureSince = undefined;
          } else idleFailureSince = undefined;
          await delay(1000);
        }
      }
    } finally { rpc.close(); }
    await delay(1000);
  }
}

function launch(bin, args, options) {
  if (/\.m?js$/i.test(bin) && fs.existsSync(bin)) return spawn(process.execPath, [bin, ...args], options);
  if (process.platform !== 'win32' || /\.exe$/i.test(bin)) return spawn(bin, args, options);
  // npm installs codex.cmd on Windows. Pass only launcher-generated arguments.
  const command = [fs.existsSync(bin) ? '"' + bin + '"' : bin, ...args.map(s => '"' + s.replace(/"/g, "'") + '"')].join(' ');
  return spawn(command, { ...options, shell: true });
}

// Check the inventory seen by the client, which can differ from the server's catalog.
// 剛起來、還沒有對話的 App Server 不會啟動 MCP（runtimeStatus 是 null、0 個工具），直接查一定是空的。
// 所以先開一個 ephemeral 對話讓 MCP 啟動，帶 threadId 查到有結果為止（有上限），查完 unsubscribe。
// 回傳 { state, detail }：ok＝看得到 aigile_ 工具；empty＝連上了卻沒有 aigile_ 工具；failed＝確定啟動失敗；unknown＝判斷不了（逾時、舊版不支援）。
const FAILED = ['failed', 'authenticationRequired', 'cancelled', 'disabled'];
export async function checkAigileCatalog(ui, { timeoutMs = 20000, pollMs = 500, cwd = process.cwd() } = {}) {
  const rpc = await connect(ui);
  let threadId;
  try {
    try { threadId = (await rpc.request('thread/start', { ephemeral: true, cwd })).thread?.id; }
    catch (e) { return { state: 'unknown', detail: 'thread/start: ' + e.message }; }
    if (!threadId) return { state: 'unknown', detail: 'thread/start returned no thread' };
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const page = await rpc.request('mcpServerStatus/list', { serverName: 'aigile', threadId });
      const server = page?.data?.find(entry => entry.name === 'aigile');
      if (!server) return { state: 'unknown', detail: 'aigile not in MCP list' };
      const tools = Object.keys(server.tools || {});
      const status = server.runtimeStatus ?? 'null';
      const detail = `runtimeStatus=${status}, ${tools.length} tools` + (server.toolsError ? `, toolsError=${server.toolsError}` : '');
      if (tools.some(name => name.startsWith('aigile_'))) return { state: 'ok', detail };
      if (FAILED.includes(status) || server.toolsError) return { state: 'failed', detail };
      if (status === 'connected') return { state: 'empty', detail: detail + ' (no aigile_ tools)' };
      if (Date.now() >= deadline) return { state: 'unknown', detail: `timeout ${Math.round(timeoutMs / 1000)}s, ${detail}` };
      await delay(pollMs);
    }
  } finally {
    if (threadId) await rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
    rpc.close();
  }
}

export async function launchForeground({ dir, bin, args, env, prompt, onReady, checkCatalog = false }) {
  const key = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(key).digest('hex');
  const marker = '[Aigile ' + randomUUID() + ']';
  const server = launch(bin, [...args, 'app-server', '--listen', 'ws://127.0.0.1:0',
    '--ws-auth', 'capability-token', '--ws-token-sha256', digest], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let published = false;
  const unpublish = () => {
    if (published) {
      try {
        if (JSON.parse(fs.readFileSync(descriptor(dir), 'utf8')).marker === marker) fs.unlinkSync(descriptor(dir));
      } catch {}
      published = false;
    }
  };
  server.once('exit', unpublish);
  const cleanup = () => {
    unpublish();
    if (!server.pid || server.exitCode !== null || server.signalCode !== null) return;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (result.status !== 0) server.kill();
    }
    else { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
  };
  process.once('exit', cleanup);
  try {
    const url = await new Promise((resolve, reject) => {
      let tail = '';
      const timer = setTimeout(() => reject(new Error('App Server startup timeout')), 12000);
      const read = chunk => {
        tail = (tail + chunk).slice(-4096);
        const match = /listening on: (ws:\/\/127\.0\.0\.1:\d+)\s/.exec(tail);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      server.stdout.on('data', read);
      server.stderr.on('data', read);
      server.once('error', e => { clearTimeout(timer); reject(e); });
      server.once('exit', () => { clearTimeout(timer); resolve(null); });
    });
    if (!url) return null; // Older CLI: caller uses its ordinary interactive launch.
    if (checkCatalog) {
      // 只有確定失敗、或連上了卻沒有 aigile_ 工具才停下；判斷不了就照常開窗，第一輪先提醒 AI 核對
      const check = await checkAigileCatalog({ url, key }).catch(e => ({ state: 'unknown', detail: e.message }));
      if (check.state === 'empty' || check.state === 'failed') {
        console.error(`這台電腦沒有可用的 Aigile MCP 工具（${check.detail}），請核對公司政策。No Aigile MCP tools available (${check.detail}). If company policy permits REST, an administrator may restart with --no-mcp.`);
        return { status: 1 };
      }
      if (check.state === 'unknown') {
        console.error(`⚠ 啟動前沒能確認 Aigile MCP 工具（${check.detail}），照常開啟。Could not confirm Aigile MCP tools before launch (${check.detail}); launching anyway.`);
        prompt = `啟動檢查沒能確認 Aigile MCP 工具（${check.detail}），先確認看得到 aigile_ 工具再做事。The launch check could not confirm Aigile MCP tools; verify them first. ` + prompt;
      }
    }
    const stage = descriptor(dir) + '.' + process.pid;
    fs.writeFileSync(stage, JSON.stringify({ pid: process.pid, marker, key, url, createdAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(stage, descriptor(dir));
    published = true;
    onReady?.();
    const ui = launch(bin, [...args, '--remote', url, '--remote-auth-token-env', 'AIGILE_UI_AUTH', marker + ' ' + prompt], {
      env: { ...env, AIGILE_UI_AUTH: key }, stdio: 'inherit',
    });
    return await new Promise((resolve, reject) => {
      ui.once('error', reject);
      ui.once('exit', code => resolve({ status: code }));
    });
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}
