import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wake-binding-'));
const file = name => path.join(dir, name);
fs.writeFileSync(file('.token'), 'fixture');
fs.writeFileSync(file('launcher-origin'), 'fixture');
fs.writeFileSync(file('launcher-binding.json'), JSON.stringify({jobId:'ljob_fixture', folder:dir}));
let bound = false, checks = 0;
const server = http.createServer((req, res) => {
  let result = {};
  if (req.url === '/api/me/launcher-binding') { checks++; result = {bound}; }
  if (req.url.startsWith('/api/notifications?')) result = {items:[{notificationId:'notif_fixture',wake:true}]};
  if (req.url === '/api/notifications/count') result = {pending:1};
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify(result));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const watcher = spawn(process.execPath, [fileURLToPath(new URL('../public/watcher.mjs', import.meta.url))], {
  cwd:dir, env:{...process.env,AIGILE_BASE:'http://127.0.0.1:'+server.address().port,
    AIGILE_TOKEN_FILE:file('.token'),AIGILE_ME:'p_fixture',WATCH_ONLY:'1',BELL_FILE:file('bell.json'),
    HEARTBEAT_MIN:'0.005',SUPABASE_URL:'',SUPABASE_KEY:'',PID_FILE:''}, stdio:'ignore',
});
const done = once(watcher,'exit');
async function until(predicate) {
  for (let i=0;i<120;i++) { if (predicate()) return; await delay(50); }
  assert.fail('watcher did not reach the expected state');
}
const seq = () => fs.existsSync(file('bell.json')) ? JSON.parse(fs.readFileSync(file('bell.json'))).seq : 0;
try {
  await until(()=>checks >= 2);
  assert.equal(seq(),0);
  bound=true;
  await until(()=>seq() > 0);
  console.log('Watcher suppressed the unbound folder and delivered after binding was restored.');
} finally {
  watcher.kill();
  await done;
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
