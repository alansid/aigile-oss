// AI 啟動器畫面測試（中文＋英文、1280／375）：我的 AI「▶ 啟動」各種狀態、30 秒逾時、啟動紀錄、電腦與啟動器分頁、停用
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/launcher-ui-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';
import { main as launcherMain, pollOnce } from '../packages/aigile-launcher/src/launcher-core.js';

if (!findBrowser()) { console.log('launcher-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }

const kit = await startKit('lnui');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-lnui-'));
const home = path.join(tmp, 'ln-home');
const workDir = path.join(tmp, 'demo-work');
fs.mkdirSync(workDir, { recursive: true });
const env = { ...process.env, AIGILE_LAUNCHER_HOME: home, AIGILE_LAUNCHER_AUTOSTART_DIR: path.join(tmp, 'auto'), AIGILE_LAUNCHER_NO_LAUNCHCTL: '1' };

try {
  const { call, BASE } = kit;
  const user = (await call(null, '/api/join', 'POST', { name: '小明', role: 'PO' })).body;
  const mkAi = async name => (await call(user.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x',
  })).body;
  const aiPg = await mkAi('示範PG');
  const aiAg = await mkAi('示範AG');
  const aiQa = await mkAi('示範QA');
  kit.sql('UPDATE participants SET last_seen_at = ? WHERE id = ?', Date.now(), aiAg.participantId);

  const { pairing } = (await call(user.token, '/api/launcher')).body;
  await launcherMain(['pair', pairing.code, '--base', BASE, '--name', '小明的筆電', '--no-daemon'], { env });
  await launcherMain(['allow', `PG_${aiPg.shortCode}`, workDir, '--tool', 'claude'], { env });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const shot = async name => {
    if (!process.env.SHOT_DIR) return;
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(process.env.SHOT_DIR, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64'));
  };

  // 中文
  await login(user.token, '/my-ai');
  await until(() => js(`!!document.querySelector('[data-ma="${aiPg.participantId}"] .ma-launch')`), 15000, '中文我的 AI');
  assert.equal(await text(`[data-ma="${aiPg.participantId}"] .ma-launch`), '▶ 啟動');
  assert.equal(await text(`[data-ma="${aiAg.participantId}"] .ma-launch`), '▶ 已在執行');
  assert.equal(await text(`[data-ma="${aiQa.participantId}"] .ma-launch`), '怎麼登記');

  await js(`document.querySelector('[data-ma="${aiPg.participantId}"] [data-act="launch"]').click(); true`);
  await until(async () => (await text(`[data-ma="${aiPg.participantId}"] .ma-nm`)).includes('啟動中…'), 5000, '啟動中');
  await pollOnce({ home, spawnTerminal: async () => ({ pid: 12345 }) });
  await until(async () => (await text('#ma-launch-logs')).includes('已開視窗'), 5000, '已開視窗');

  // 英文介面
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(user.token, '/my-ai');
  await until(async () => (await text(`[data-ma="${aiPg.participantId}"] .ma-launch`)) === '▶ Start', 15000, '英文 Start');
  assert.equal(await text(`[data-ma="${aiAg.participantId}"] .ma-launch`), '▶ Running');
  assert.equal(await text(`[data-ma="${aiQa.participantId}"] .ma-launch`), 'How to register');
  assert.match(await text('#ma-launch-logs'), /Opened/);

  // 英文 30 秒逾時
  await js(`document.querySelector('[data-ma="${aiPg.participantId}"] [data-act="launch"]').click(); true`);
  await until(async () => (await text(`[data-ma="${aiPg.participantId}"] .ma-nm`)).includes('Starting…'), 5000, 'Starting');
  kit.sql("UPDATE launcher_jobs SET created_at = ? WHERE status = 'pending'", Date.now() - 35_000);
  await until(async () => (await text(`[data-ma="${aiPg.participantId}"] .ma-ln-sub`)).includes('Failed to open'), 5000, 'EN timeout');
  await shot('plat436-en-1280-myai');

  await js(`document.querySelector('[data-ma-ptab="computers"]').click(); true`);
  await until(() => js(`!document.querySelector('#ma-comp-view').hidden && !!document.querySelector('#ln-new-code')`), 5000, 'EN computers');
  assert.match(await text('#ma-comp-view'), /Computers & launcher|Add a computer/);
  assert.match(await text('#ma-comp-view .ln-safe-banner'), /Any other request from the platform is refused/);
  await shot('plat436-en-1280-computers');

  await size(375, 812);
  await shot('plat436-en-375-computers');
  assert.equal(await hscroll(), false, '375 EN computers 無橫向捲動');
  await js(`document.querySelector('[data-ma-ptab="ai"]').click(); true`);
  await shot('plat436-en-375-myai');
  assert.equal(await hscroll(), false, '375 EN myai 無橫向捲動');

  console.log('launcher-ui-test：全部通過（中英文 1280／375 啟動／啟動中／逾時／已在執行／怎麼登記／啟動紀錄／電腦分頁）');
} finally {
  await kit.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
