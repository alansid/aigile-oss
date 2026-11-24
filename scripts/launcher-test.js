// AI 啟動器 API＋CLI＋安全底線測試（開機自啟、單次配對碼、本機白名單、拒絕惡意指令、僅主人可啟動、離線紀錄、停用與移除）
// 完全隔離（temp HOME + temp AUTOSTART + 假 terminal），不碰真實家目錄／登錄檔／程式。用法：node scripts/launcher-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startKit } from './browser-kit.js';
import {
  main as launcherMain,
  pollOnce,
  executeLaunchJob,
  readConfig,
  readAllow,
  readLocalLogs,
  installAutostart,
  removeAutostart,
} from '../packages/aigile-launcher/src/launcher-core.js';

const kit = await startKit('ln436');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ln-'));
const home = path.join(tmp, 'ln-home');
const autoDir = path.join(tmp, 'autostart');
const workDir = path.join(tmp, 'demo-repo');
const evilDir = path.join(tmp, 'evil-repo');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(evilDir, { recursive: true });

try {
  const { call, BASE } = kit;
  const admin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const hua = (await call(null, '/api/join', 'POST', { name: '小華', role: 'PG' })).body;
  await call(admin.token, `/api/participants/${hua.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const aiRes = await call(hua.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '華的PG',
    duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x',
  });
  assert.equal(aiRes.status, 201, JSON.stringify(aiRes.body));
  const ai = aiRes.body;

  const env = { ...process.env, AIGILE_LAUNCHER_HOME: home, AIGILE_LAUNCHER_AUTOSTART_DIR: autoDir, AIGILE_LAUNCHER_NO_LAUNCHCTL: '1' };

  const st0 = await call(hua.token, '/api/launcher');
  assert.equal(st0.status, 200);
  const code = st0.body.pairing.code;
  assert.match(code, /^\d{6}$/, '配對碼 6 位數');

  const rcPair = await launcherMain(['pair', code.slice(0, 3), code.slice(3), '--base', BASE, '--name', '小華筆電', '--no-daemon'], { env });
  assert.equal(rcPair, 0);
  const cfg = readConfig(home);
  assert.ok(cfg?.token?.startsWith('lk_'), '拿到 lk_ 裝置金鑰');
  assert.notEqual(cfg.token, ai.token);

  await assert.rejects(() => launcherMain(['pair', code, '--base', BASE, '--no-daemon'], { env }), /已使用|不存在|過期/);

  const { code: expCode } = (await call(hua.token, '/api/launcher/pair-code', 'POST')).body;
  kit.sql('UPDATE launcher_pair_codes SET expires_at = ? WHERE code = ?', Date.now() - 1000, expCode);
  await assert.rejects(() => launcherMain(['pair', expCode, '--base', BASE, '--no-daemon'], { env }), /已過期|不存在/);

  for (const plat of ['win32', 'darwin', 'linux']) {
    const info = installAutostart({ home, env, platform: plat });
    assert.ok(fs.existsSync(info.file), `${plat} 建立開機自啟設定`);
    removeAutostart({ home, env, platform: plat });
    assert.ok(!fs.existsSync(info.file), `${plat} 清除開機自啟設定`);
  }

  const agent = `PG_${ai.shortCode}`;
  await assert.rejects(() => launcherMain(['allow', agent, workDir, '--tool', 'copilot'], { env }), /只能是/);
  assert.equal(await launcherMain(['allow', agent, workDir, '--tool', 'claude'], { env }), 0);
  assert.equal(readAllow(home).length, 1);

  const leakRes = await call(hua.token, '/api/messages', 'POST', { project: '預設專案', text: `測試外洩 ${cfg.token}` });
  assert.equal(leakRes.status, 400);
  assert.equal(leakRes.body.error.code, 'SECRET_IN_TEXT');

  const adminTry = await call(admin.token, `/api/my-ais/${ai.participantId}/launch`, 'POST');
  assert.equal(adminTry.status, 403, '管理員也不能幫別人的 AI 按啟動');

  const spawned = [];
  const fakeSpawn = async spec => { spawned.push(spec); return { pid: 99999 }; };

  const startRes = await call(hua.token, `/api/my-ais/${ai.participantId}/launch`, 'POST');
  assert.equal(startRes.status, 200);
  const job = startRes.body.job;

  const pr = await pollOnce({ home, spawnTerminal: fakeSpawn });
  assert.equal(pr.results[0].status, 'opened');
  assert.equal(spawned.length, 1);
  assert.equal(path.resolve(spawned[0].cwd), path.resolve(workDir));

  for (const rj of [
    { id: 'bad1', action: 'exec', command: 'rm -rf /', aiId: ai.participantId, agent, folder: workDir, tool: 'claude' },
    { id: 'bad2', action: 'launch', aiId: ai.participantId, agent, folder: evilDir, tool: 'claude' },
    { id: 'bad3', action: 'launch', aiId: ai.participantId, agent, folder: workDir, tool: 'codex' },
    { id: 'bad4', action: 'launch', aiId: 'p_not_registered', agent: 'QA_NONE', folder: workDir, tool: 'claude' },
    { id: 'bad5', action: 'launch', aiId: ai.participantId, agent, folder: workDir, tool: 'claude', url: 'https://evil.invalid/x.js' },
  ]) {
    const res = await executeLaunchJob(rj, { home, base: BASE, token: cfg.token, spawnTerminal: fakeSpawn });
    assert.equal(res.status, 'refused');
  }
  assert.equal(spawned.length, 1, '被拒絕的請求絕不呼叫 spawnTerminal');
  assert.ok(readLocalLogs(home, 10).length >= 6);

  kit.sql('UPDATE launchers SET last_seen_at = ? WHERE id = ?', Date.now() - 5 * 60_000, cfg.launcherId);
  const offTry = await call(hua.token, `/api/my-ais/${ai.participantId}/launch`, 'POST');
  assert.equal(offTry.status, 409);

  await call(hua.token, `/api/launchers/${cfg.launcherId}/disable`, 'POST');
  await assert.rejects(() => pollOnce({ home, spawnTerminal: fakeSpawn }), /LAUNCHER_DISABLED|停用/);

  await launcherMain(['uninstall'], { env });
  assert.ok(!fs.existsSync(home));

  console.log('launcher-test：全部通過（配對、開機自啟、白名單、拒絕惡意指令、主人權限、離線紀錄、停用與移除）');
} finally {
  await kit.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
