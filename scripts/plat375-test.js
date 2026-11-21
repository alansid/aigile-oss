// PLAT-375 測試：腳本或 watcher.env 更新後，watcher 自動檢查語法並換新重開（換檔、壞檔、叫醒中不換、pid 交接、不重複叫醒）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000, label = '') => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error('等太久：' + label);
    await sleep(100);
  }
};
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p375-'));
const agentDir = path.join(dir, 'PG_A');
const otherDir = path.join(dir, 'PG_B');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });

const watcherSrc = new URL('../public/watcher.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const wakeScript = path.join(dir, 'wake.mjs');
const pidFile = path.join(agentDir, 'watcher.pid');
const envFile = path.join(agentDir, 'watcher.env');
const reloadFile = path.join(agentDir, 'watcher.reload');
const logFile = path.join(agentDir, 'watcher.log');
const wakeLog = path.join(dir, 'wakes.txt');
const otherPidFile = path.join(otherDir, 'watcher.pid');
fs.writeFileSync(otherPidFile, '999999');

let notifications = [{ notificationId: 'n1', wake: true }];
const dms = [];
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/me') return res.end(JSON.stringify({ participantId: 'p_ai', roleKey: 'PG', projects: ['平台'], ownerParticipantId: 'p_human' }));
    if (req.url === '/api/me/online') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/api/me/wake') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/api/notifications/count') return res.end(JSON.stringify({ pending: notifications.length }));
    if (req.url?.startsWith('/api/notifications?')) return res.end(JSON.stringify({ items: notifications }));
    if (req.url === '/api/dm') { dms.push(body.text); return res.end(JSON.stringify({ ok: true })); }
    res.statusCode = 404; res.end('{}');
  });
});

let trackedPid = 0;
try {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  fs.writeFileSync(wakeScript, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(wakeLog)}, 'wake-v1\\n');\n`);
  const writeEnv = hb => fs.writeFileSync(envFile, [
    `AIGILE_BASE=http://127.0.0.1:${port}`,
    'AIGILE_TOKEN=tok_test',
    'AIGILE_ME=p_ai',
    `WAKE_CMD=node ${wakeScript.replace(/\\/g, '/')}`,
    `PID_FILE=${pidFile.replace(/\\/g, '/')}`,
    `HEARTBEAT_MIN=${hb}`,
    'WAKE_MERGE_SEC=0',
  ].join('\n') + '\n');
  writeEnv(0.03);

  const logFd = fs.openSync(logFile, 'a');
  const w = spawn(process.execPath, [`--env-file=${envFile}`, watcherSrc], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
  fs.closeSync(logFd);
  w.unref();

  const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0; } catch { return 0; } };
  const pid1 = await until(() => { const p = readPid(); return p && alive(p) ? p : 0; }, 10000, 'pid1 寫入');
  trackedPid = pid1;
  await until(() => fs.existsSync(wakeLog) && fs.readFileSync(wakeLog, 'utf8').includes('wake-v1'), 10000, '第一次叫醒 n1');

  // 1) 換檔（有效語法）+ reload 檔：pid 交接、不重複叫醒 n1
  fs.writeFileSync(wakeScript, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(wakeLog)}, 'wake-v2\\n');\n`);
  fs.writeFileSync(reloadFile, String(Date.now()));
  const pid2 = await until(() => { const p = readPid(); return p && p !== pid1 && alive(p) ? p : 0; }, 10000, '換新為 pid2');
  trackedPid = pid2;
  await until(() => !alive(pid1), 5000, '舊程序 pid1 結束');
  await sleep(600);
  assert.equal(fs.readFileSync(wakeLog, 'utf8').trim().split('\n').length, 1, '已叫醒過的 n1 不重複叫醒');

  // 2) 壞檔：node --check 失敗 → 繼續跑 pid2、記 log、私訊所屬人類
  fs.writeFileSync(wakeScript, 'const broken = ;\n');
  fs.writeFileSync(reloadFile, String(Date.now()));
  await until(() => dms.some(t => t.includes('語法有誤')), 10000, '壞檔私訊所屬人類');
  assert.equal(readPid(), pid2, '壞檔時維持原程序 pid2');
  assert.ok(alive(pid2), 'pid2 繼續活著');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('語法有誤'), 'watcher.log 記錄語法有誤');

  // 3) 叫醒中不換，等叫醒結束後才換（同時測 watcher.env 更新）
  const lockFile = path.join(dir, 'wake-running.lock');
  fs.writeFileSync(wakeScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(lockFile)}, '1'); await new Promise(r => setTimeout(r, 1500)); fs.appendFileSync(${JSON.stringify(wakeLog)}, 'wake-v3\\n'); fs.unlinkSync(${JSON.stringify(lockFile)});\n`);
  fs.writeFileSync(reloadFile, String(Date.now()));
  const pid3 = await until(() => { const p = readPid(); return p && p !== pid2 && alive(p) ? p : 0; }, 10000, '修好後換新為 pid3');
  trackedPid = pid3;
  await until(() => !alive(pid2), 5000, '舊程序 pid2 結束');

  // 觸發 n2 讓 wake.mjs 跑 1.5 秒；跑的中途改 watcher.env 並寫 reload
  notifications = [{ notificationId: 'n1', wake: true }, { notificationId: 'n2', wake: true }];
  await until(() => fs.existsSync(lockFile), 10000, 'n2 開始叫醒');
  writeEnv(15);
  fs.writeFileSync(reloadFile, String(Date.now()));
  await sleep(600);
  assert.equal(readPid(), pid3, '叫醒中不能中途換新（仍為 pid3）');

  // 等 wake.mjs 跑完，自動接續換新為 pid4
  const pid4 = await until(() => { const p = readPid(); return p && p !== pid3 && alive(p) ? p : 0; }, 10000, '叫醒結束後換新為 pid4');
  trackedPid = pid4;
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('目前正在喚醒中，等這一輪結束後換新'), 'log 記錄叫醒中延後換新');
  assert.equal(fs.readFileSync(otherPidFile, 'utf8').trim(), '999999', '不碰其他代號的 pid 檔');

  console.log('plat375-test：全部通過');
} finally {
  if (trackedPid && alive(trackedPid)) { try { process.kill(trackedPid, 'SIGKILL'); } catch {} }
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
