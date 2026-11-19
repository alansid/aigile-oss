import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcpDispatch } from '../src/mcp.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile codex wake '));
const win = process.platform === 'win32';
const bin = path.join(tmp, win ? 'codex.cmd' : 'codex');
const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const wake = fileURLToPath(new URL('../public/aigile-codex.mjs', import.meta.url));
const watcher = fileURLToPath(new URL('../public/watcher.mjs', import.meta.url));
const log = path.join(tmp, 'calls.jsonl');
const agent = 'PG_TEST';
const dir = path.join(tmp, '.aigile', agent);
const lock = path.join(dir, 'foreground.lock');
const thread = '11111111-1111-4111-8111-111111111111';
const env = { ...process.env, CODEX_BIN: bin, CODEX_HOME: path.join(tmp, 'codex-home'),
  FAKE_CODEX_THREAD: thread, FAKE_CODEX_LOG: log, FAKE_CODEX_NODE: process.execPath, FAKE_CODEX_SCRIPT: fake };
let child, server;

function runWake(expected = 0) {
  const r = spawnSync(process.execPath, [wake, '--agent', agent, '--mode', 'keep'],
    { cwd: tmp, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, expected, r.error?.message || r.stderr || fs.readFileSync(path.join(dir, 'wake.log'), 'utf8'));
}

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, win ? '@"%FAKE_CODEX_NODE%" "%FAKE_CODEX_SCRIPT%" %*\r\n'
    : '#!/bin/sh\nexec "$FAKE_CODEX_NODE" "$FAKE_CODEX_SCRIPT" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(lock, String(process.pid));
  runWake();
  runWake();
  fs.unlinkSync(lock);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  const catalog = await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { me: { role_key: 'PG' } });
  const expectedTools = [...catalog.result.tools.map(({ name }) => name), 'aigile_use'];
  const expectedOverrides = [
    ...expectedTools.map(name => `mcp_servers.aigile.tools.${name}.approval_mode="approve"`),
    `mcp_servers.aigile.env.AIGILE_WAKE_AGENT="${agent}"`,
    'mcp_servers.aigile.required=true',
  ].sort();
  for (const args of calls) {
    const overrides = args.filter((arg, i) => args[i - 1] === '-c' && arg.startsWith('mcp_servers.'));
    assert.deepEqual(overrides.sort(), expectedOverrides, 'Review the wake overrides when the platform or bridge catalog changes');
    assert.ok(args.includes('sandbox_mode=workspace-write'));
    assert.match(args.at(-1), /git status/);
  }
  assert.deepEqual(calls[0].slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.deepEqual(calls[1].slice(0, 3), ['exec', 'resume', '--json']);
  assert.equal(calls[1].at(-2), thread);
  assert.match(calls[1].at(-1), /You are Aigile agent PG_TEST\./);

  let wakes = 0, notificationId = 'notif_foreground';
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (url.pathname === '/api/notifications/count') body = { pending: 1 };
    if (url.pathname === '/api/notifications') body = { items: [{ notificationId, wake: true }] };
    if (url.pathname === '/api/me/wake') wakes++;
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(lock, String(process.pid));
  const uiFile = path.join(dir, 'foreground-ui.json');
  fs.writeFileSync(uiFile, JSON.stringify({ pid: process.pid, marker: 'probe', key: 'fixture',
    url: 'ws://127.0.0.1:54321', createdAt: Date.now() }));
  const preload = path.join(tmp, 'socket.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
    const now = Date.now;
    Date.now = () => now() + (fs.existsSync('minute-elapsed') ? 61_000 : 0);
    globalThis.WebSocket = class {
      constructor() { queueMicrotask(() => fs.existsSync('unreachable') ? this.onerror() : this.onopen()); }
      send(raw) {
        const { id, method, params } = JSON.parse(raw);
        if (!id) return;
        let result = {};
        if (method === 'thread/loaded/list') result = { data: ['target'] };
        if (method === 'thread/read') result = { thread: { id: 'target', preview: 'probe',
          status: { type: fs.existsSync('idle') ? 'idle' : 'active' } } };
        if (method === 'turn/start') {
          fs.appendFileSync('deliveries', JSON.stringify(params) + '\\n');
          result = { turn: { id: 'test-turn' } };
        }
        if (method === 'thread/turns/list') result = { data: [{ id: 'test-turn', status: 'completed' }] };
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, result }) }));
      }
      close() { this.onclose?.(); }
    };`);
  child = spawn(process.execPath, [watcher], { cwd: tmp, env: { ...env,
    NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
    AIGILE_BASE: `http://127.0.0.1:${server.address().port}`, AIGILE_TOKEN: 'test-token',
    AIGILE_TOKEN_FILE: '', AIGILE_ME: 'p_test', SUPABASE_URL: '', SUPABASE_KEY: '', WATCH_ONLY: '',
    HEARTBEAT_MIN: '0.02', BELL_FILE: '', PID_FILE: path.join(dir, 'watcher.pid'), WAKE_MAX_PER_HOUR: '5', WAKE_MAX_PER_DAY: '5',
    WAKE_CMD: `"${process.execPath}" "${wake}" --agent ${agent} --mode keep`,
  } });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const waitFor = async pattern => {
    for (let i = 0; i < 100; i++) {
      if (pattern.test(output)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(output);
  };
  await waitFor(/前景對話忙碌/);
  assert.equal(wakes, 0);
  fs.writeFileSync(path.join(tmp, 'idle'), '');
  await waitFor(/喚醒指令結束（exit 0）/);
  assert.equal(wakes, 1);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  const received = JSON.parse(fs.readFileSync(path.join(tmp, 'deliveries'), 'utf8'));
  assert.equal(received.threadId, 'target');
  assert.match(received.input[0].text, /You are Aigile agent PG_TEST/);
  assert.match(received.input[0].text, /foreground session is open/);
  assert.doesNotMatch(received.input[0].text, /unattended|No human/i);
  assert.match(received.input[0].text, /do not git commit, push, merge or deploy/);
  fs.writeFileSync(path.join(tmp, 'unreachable'), '');
  output = '';
  notificationId = 'notif_unreachable';
  await waitFor(/檢查前景對話失敗/);
  assert.equal(wakes, 1);
  fs.writeFileSync(path.join(tmp, 'minute-elapsed'), '');
  await waitFor(/喚醒指令結束（exit 0）/);
  assert.equal(wakes, 2);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);
  fs.unlinkSync(path.join(tmp, 'unreachable'));
  output = '';
  notificationId = 'notif_recovered';
  await waitFor(/喚醒指令結束（exit 0）/);
  assert.equal(wakes, 3);
  assert.equal(fs.readFileSync(path.join(tmp, 'deliveries'), 'utf8').trim().split('\n').length, 2);
  fs.unlinkSync(uiFile);
  fs.unlinkSync(lock);
  output = '';
  notificationId = 'notif_background';
  await waitFor(/喚醒指令結束（exit 0）/);
  assert.equal(wakes, 4);
  const backgroundCalls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(backgroundCalls.length, 4);
  assert.match(JSON.parse(backgroundCalls.at(-1)).at(-1), /unattended background round/);
  console.log('codex-wake: foreground reply, launch, and resume passed');
} finally {
  if (child?.exitCode === null) {
    child.kill();
    await new Promise(resolve => child.once('close', resolve));
  }
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
