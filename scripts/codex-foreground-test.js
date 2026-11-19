import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverForeground, foregroundUI, inspectForeground, launchForeground } from '../public/aigile-codex-ui.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ui-test-'));
const exitFile = path.join(dir, 'close');
const bin = path.join(dir, 'codex.mjs');
const original = globalThis.WebSocket;
const deliveries = [];
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
      while (!fs.existsSync(process.env.TEST_CLOSE_FILE)) await delay(50);
    }`);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  launcher = launchForeground({ dir, bin, args: [], env: { ...process.env, TEST_CLOSE_FILE: exitFile },
    prompt: 'initial prompt', onReady: ready });
  await Promise.race([started, launcher.then(() => { throw Error('test launcher exited early'); })]);
  const ui = foregroundUI(dir);
  globalThis.WebSocket = class {
    constructor(url, options) {
      assert.equal(url, ui.url);
      assert.equal(options.headers.Authorization, 'Bearer ' + ui.key);
      queueMicrotask(() => this.onopen());
    }
    send(data) {
      const { id, method, params } = JSON.parse(data);
      if (!id) return;
      let result = {};
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
  console.log('codex-foreground: bound thread, busy queue, close and fallback passed');
} finally {
  fs.writeFileSync(exitFile, '');
  await launcher;
  globalThis.WebSocket = original;
  fs.rmSync(dir, { recursive: true, force: true });
}
