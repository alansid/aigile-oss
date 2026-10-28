// 畫面測試（真的瀏覽器）：深色模式「等誰」的紅字／橘字看得清楚
// 1. 工作總覽：「等 陳大文：設計稿還沒來」（受阻、深色底）與「等你」（決策卡那列、咖啡底）對比至少 4.5
// 2. 看板：卡片上的「等誰」標籤一樣看得清楚
// 3. 淺色模式顏色不變
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/wait-dark-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('wait-dark-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('wdark');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const chen = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const pj = (await kit.call(boss.token, '/api/me')).body.projects[0];
  await kit.call(chen.token, `/api/projects/${encodeURIComponent(pj)}/join-requests`, 'POST', { note: '' }); // 陳大文加入專案，才能指派「等誰」
  const jr = (await kit.call(boss.token, '/api/join-requests')).body.items[0];
  assert.equal((await kit.call(boss.token, `/api/join-requests/${jr.id}/approve`, 'POST', { role: '', readOnly: false })).status, 200, '核准加入');
  const blocked = await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'wd-1', project: '預設專案', title: '首頁改版', status: '受阻', blocker: '設計稿還沒來', waitForId: chen.participant.participantId });
  assert.ok(blocked.status < 300, JSON.stringify(blocked.body));
  const dec = await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'wd-2', project: '預設專案', type: '決策', title: '要不要上線', question: '這週要不要上線？', options: ['上線', '先不要'], recommendation: '上線', deciderId: boss.participant.participantId });
  assert.ok(dec.status < 300, JSON.stringify(dec.body));

  const { js, login, cdp } = await kit.browser(1280, 900);
  await login(boss.token, '/p/main/work');
  // 對比：字色對上第一個不透明的底色（WCAG 相對亮度）
  const contrast = sel => js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 0;
    const rgb = s => (s.match(/[\\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bg = null; for (let e = el; e && !bg; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.5)) bg = c; }
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg || [255, 255, 255]);
    return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  })()`);
  const color = sel => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).color`);
  const show = async view => { await js(`document.querySelector('[data-view="${view}"]')?.click(); true`); await sleep(400); };

  await until(() => js("!!document.querySelector('.crow-wait.me') && !!document.querySelector('.crow-wait.bad')"), 20000, '工作總覽的等誰');
  // 3. 淺色不變
  assert.equal(await color('.crow-wait.me'), 'rgb(154, 52, 18)', '淺色「等你」維持原色');
  assert.equal(await color('.crow-wait.bad'), 'rgb(153, 27, 27)', '淺色受阻維持原色');

  for (const [how, set] of [['系統深色', () => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })],
                            ['手動選深色', async () => { await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await js("document.documentElement.dataset.theme = 'dark'; true"); }]]) {
    await set(); await show('A'); await sleep(300);
    // 1. 工作總覽
    const me = await contrast('.crow-wait.me'), bad = await contrast('.crow-wait.bad');
    assert.ok(me >= 4.5, `${how}：決策卡那列「等你」對比 ${me}（至少 4.5）`);
    assert.ok(bad >= 4.5, `${how}：「等 陳大文：設計稿還沒來」對比 ${bad}（至少 4.5）`);
    // 2. 看板
    await show('B');
    await until(() => js("!!document.querySelector('.cwait.me') && !!document.querySelector('.cwait.bad')"), 10000, '看板的等誰');
    const bme = await contrast('.cwait.me'), bbad = await contrast('.cwait.bad');
    assert.ok(bme >= 4.5 && bbad >= 4.5, `${how}：看板「等誰」對比 ${bme}／${bbad}（至少 4.5）`);
    console.log(`✓ ${how}：總覽 ${me}／${bad}，看板 ${bme}／${bbad}`);
  }
  await show('A');
  console.log('wait-dark-ui-test：全部通過');
} catch (e) {
  console.error('wait-dark-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
