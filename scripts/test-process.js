import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.status === 0) return;
  }
  child.kill('SIGKILL');
}

export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  killTree(child);
  await closed;
}

export async function stopServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  server.closeAllConnections?.();
  await closed;
}

// Register before startup so an exit between Browser.close and teardown is observable.
const closedChildren = new WeakMap();

export function trackChild(kids, child) {
  closedChildren.set(child, new Promise(resolve => child.once('close', resolve)));
  kids.push(child);
}

export async function stopBrowsers(ws, kids) {
  const [server, ...browsers] = kids;
  const browsersClosed = Promise.all(browsers.map(child => closedChildren.get(child)));
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }));
      // The socket disconnects before Chrome finishes flushing its profile on Windows.
      await Promise.race([browsersClosed, delay(5000, undefined, { ref: false })]);
    }
  } finally {
    ws?.close();
    for (const child of browsers) killTree(child);
    killTree(server);
    await Promise.all(kids.map(child => closedChildren.get(child)));
  }
}

export async function removeBrowserFixture(dir) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch (err) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code) || Date.now() >= deadline) throw err;
      await delay(250);
    }
  }
}
