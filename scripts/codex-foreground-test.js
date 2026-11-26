import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAigileCatalog, deliverForeground, foregroundUI, inspectForeground, launchForeground } from '../public/aigile-codex-ui.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ui-test-'));
const exitFile = path.join(dir, 'close');
const bin = path.join(dir, 'codex.mjs');
const original = globalThis.WebSocket;
const deliveries = [];
const argvFile = path.join(dir, 'argv.json');
// 啟動檢查用的假 MCP 狀態：catalog(第幾次查) 回 aigile 那一筆；threadStart 回 thread/start 的結果（丟錯＝舊版不支援）
let catalog = () => ({ name: 'aigile', tools: {} }), threadStart = () => ({ thread: { id: 'probe' } }), statusCalls = 0;
const unsubscribed = [];
let busy = true;
let firstTurnRead = true;
let checkedBusy;
const observedBusy = new Promise(resolve => { checkedBusy = resolve; });
let launcher;
try {
  fs.writeFileSync(path.join(dir, 'foreground.lock'), String(process.pid));
  fs.writeFileSync(bin, `import fs from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    if (process.argv.includes('app-server')) {
      console.error('listening on: ws://127.0.0.1:45678');
      setInterval(() => {}, 1000);
    } else {
      if (!process.argv.includes('--remote') || !process.env.AIGILE_UI_AUTH) process.exit(1);
      if (process.env.TEST_ARGV_FILE) fs.writeFileSync(process.env.TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
      while (!fs.existsSync(process.env.TEST_CLOSE_FILE)) await delay(50);
    }`);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  launcher = launchForeground({ dir, bin, args: [], env: { ...process.env, TEST_CLOSE_FILE: exitFile },
    prompt: 'initial prompt', onReady: ready });
  await Promise.race([started, launcher.then(() => { throw Error('test launcher exited early'); })]);
  const ui = foregroundUI(dir);
  let checkingEmptyCatalog = false;
  globalThis.WebSocket = class {
    constructor(url, options) {
      assert.equal(url, ui.url);
      if (!checkingEmptyCatalog) assert.equal(options.headers.Authorization, 'Bearer ' + ui.key);
      queueMicrotask(() => this.onopen());
    }
    send(data) {
      const { id, method, params } = JSON.parse(data);
      if (!id) return;
      let result = {};
      if (method === 'thread/start') {
        try { result = threadStart(params); } catch (e) { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, error: { message: e.message } }) })); return; }
      }
      if (method === 'mcpServerStatus/list') {
        assert.equal(params.threadId, 'probe', '要帶 ephemeral 對話的 threadId 查，沒對話的查法一定是空的');
        const entry = catalog(statusCalls++);
        result = { data: entry ? [{ resources: [], resourceTemplates: [], authStatus: 'unsupported', ...entry }] : [] };
      }
      if (method === 'thread/unsubscribe') { unsubscribed.push(params.threadId); result = { status: 'unsubscribed' }; }
      if (method === 'thread/loaded/list') result = { data: ['other', 'foreground'] };
      if (method === 'thread/read') {
        const mine = params.threadId === 'foreground';
        result = { thread: { id: params.threadId, preview: mine ? ui.marker + ' test' : 'other',
          status: { type: mine && busy ? 'active' : 'idle' } } };
        if (mine && busy) checkedBusy();
      }
      if (method === 'turn/start') {
        assert.equal(params.threadId, 'foreground');
        assert.equal(busy, false);
        deliveries.push(params.input[0].text);
        busy = true;
        result = { turn: { id: 'test-turn' } };
      }
      if (method === 'thread/turns/list') {
        result = { data: [{ id: 'test-turn', status: firstTurnRead ? 'interrupted' : 'completed' }] };
        firstTurnRead = false;
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, result }) }));
    }
    close() { this.onclose?.(); }
  };
  const delivery = deliverForeground(dir, 'test doorbell');
  await observedBusy;
  assert.deepEqual(deliveries, []);
  assert.equal(await inspectForeground(dir), 'busy');
  busy = false;
  assert.equal(await delivery, true);
  assert.deepEqual(deliveries, ['test doorbell']);
  fs.writeFileSync(exitFile, '');
  assert.equal((await launcher).status, 0);
  assert.equal(await inspectForeground(dir), 'closed');
  assert.equal(await deliverForeground(dir, 'next doorbell'), false);
  checkingEmptyCatalog = true;
  const tools = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['aigile_t' + i, { name: 'aigile_t' + i }]));
  const errors = [];
  const origError = console.error;
  const launchWith = async (name, { expectStart }) => {
    statusCalls = 0; unsubscribed.length = 0; errors.length = 0;
    try { fs.unlinkSync(argvFile); } catch {}
    let started = false;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      const r = await launchForeground({ dir, bin, args: [], env: { ...process.env, TEST_CLOSE_FILE: exitFile, TEST_ARGV_FILE: argvFile },
        prompt: 'start prompt', checkCatalog: true, onReady: () => { started = true; } });
      assert.equal(started, expectStart, name + '：' + (expectStart ? '應該照常開窗' : '不該開窗'));
      return { status: r.status, argv: fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) : null, err: errors.join(' | ') };
    } finally { console.error = origError; }
  };
  // 1. 實際情況：還沒啟動（null）→ 啟動中 → 連上、看得到工具 → 照常開，不加提醒，查完 unsubscribe
  catalog = i => [{ name: 'aigile', tools: {}, runtimeStatus: null }, { name: 'aigile', tools: {}, runtimeStatus: 'notStarted' }, { name: 'aigile', tools: {}, runtimeStatus: 'starting' }][i] || { name: 'aigile', tools: tools(23), runtimeStatus: 'connected' };
  let r = await launchWith('not started → connected', { expectStart: true });
  assert.equal(r.status, 0);
  assert.ok(statusCalls >= 4, '要等到連上，不能第一次查到空的就停');
  assert.deepEqual(unsubscribed, ['probe'], '查完要放掉 ephemeral 對話');
  assert.ok(!r.argv.at(-1).includes('沒能確認'), '確認過就不加提醒');
  // 2. 確定失敗 → 停下，訊息印出實際狀態
  catalog = () => ({ name: 'aigile', tools: {}, runtimeStatus: 'failed' });
  r = await launchWith('failed', { expectStart: false });
  assert.equal(r.status, 1);
  assert.match(r.err, /runtimeStatus=failed, 0 tools/);
  assert.deepEqual(unsubscribed, ['probe']);
  // 3. 連上了卻沒有 aigile_ 工具（公司政策擋掉）→ 停下
  catalog = () => ({ name: 'aigile', tools: { other_tool: {} }, runtimeStatus: 'connected' });
  r = await launchWith('connected, 0 aigile tools', { expectStart: false });
  assert.equal(r.status, 1);
  assert.ok(r.err.includes('runtimeStatus=connected, 1 tools (no aigile_ tools)'), r.err);
  // 4. 工具清單讀不到（toolsError）→ 算失敗
  catalog = () => ({ name: 'aigile', tools: {}, runtimeStatus: 'starting', toolsError: 'handshake failed' });
  r = await launchWith('toolsError', { expectStart: false });
  assert.match(r.err, /toolsError=handshake failed/);
  // 5. 舊版不支援 thread/start → 判斷不了：照常開窗，第一輪提醒
  threadStart = () => { throw new Error('unknown method'); };
  catalog = () => assert.fail('thread/start 失敗就不該再查');
  r = await launchWith('old codex', { expectStart: true });
  assert.equal(r.status, 0);
  assert.ok(r.err.includes('沒能確認 Aigile MCP 工具（thread/start: unknown method）'), r.err);
  assert.ok(r.argv.at(-1).includes('啟動檢查沒能確認 Aigile MCP 工具（thread/start: unknown method）') && r.argv.at(-1).endsWith('start prompt'), '第一輪提醒要接在原本的提示前面：' + r.argv.at(-1));
  threadStart = () => ({ thread: { id: 'probe' } });
  // 6. 一直沒啟動完 → 逾時回 unknown（不停下），訊息帶最後狀態
  catalog = () => ({ name: 'aigile', tools: {}, runtimeStatus: 'starting' });
  statusCalls = 0; unsubscribed.length = 0;
  const slow = await checkAigileCatalog({ url: ui.url, key: ui.key }, { timeoutMs: 300, pollMs: 50 });
  assert.equal(slow.state, 'unknown');
  assert.match(slow.detail, /^timeout 0s, runtimeStatus=starting, 0 tools$/);
  assert.ok(statusCalls >= 3, '逾時前要一直重查');
  assert.deepEqual(unsubscribed, ['probe']);
  // 7. 清單裡沒有 aigile → 判斷不了
  catalog = () => null;
  assert.equal((await checkAigileCatalog({ url: ui.url, key: ui.key })).state, 'unknown');
  console.log('codex-foreground: bound thread, busy queue, close, fallback and MCP launch check passed');
} finally {
  fs.writeFileSync(exitFile, '');
  await launcher;
  globalThis.WebSocket = original;
  fs.rmSync(dir, { recursive: true, force: true });
}
