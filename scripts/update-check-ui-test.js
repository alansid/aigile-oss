// 畫面測試（真的瀏覽器，375）：管理頁「有新版本」提示（不連 GitHub：先把查詢結果放進快取）
// 1. 管理員打開成員與權限：頂端寫「有新版本 vX（目前 vY）」與版本說明連結；375 沒有橫向捲動
// 2. 按 × 這一版就不再提醒（重新整理也一樣）
// 3. 「系統」分頁寫目前版本與有新版本
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/update-check-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { APP_VERSION } from '../src/version.js';

if (!findBrowser()) { console.log('update-check-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('upd', { env: { UPDATE_CHECK: '1' } });
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const [a, b, c] = APP_VERSION.split('.').map(Number), next = `${a}.${b + 1}.${c}`;
  const url = `https://github.com/alansid/aigile-oss/releases/tag/v${next}`;
  kit.sql("INSERT INTO app_settings (key, value) VALUES ('update_check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: Date.now(), latest: { version: next, name: '新版', url } }));

  const { js, login } = await kit.browser(375, 800);
  await login(boss.token, '/members');
  await until(() => js("!!document.querySelector('.upd-banner')"), 15000, '有新版本提示');
  const text = await js("document.querySelector('.upd-banner').textContent");
  assert.match(text, new RegExp(`有新版本 v${next.replace(/\./g, '\\.')}（目前 v${APP_VERSION.replace(/\./g, '\\.')}）`), text);
  assert.equal(await js("document.querySelector('.upd-banner a').href"), url, '版本說明連結');
  assert.equal(await js("document.querySelector('.upd-banner a').rel"), 'noopener noreferrer');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 沒有橫向捲動');
  // 3. 系統分頁
  await js("document.querySelector('[data-pm-tab=\"system\"]').click(); true");
  await until(() => js("/目前 v[\\d.]+ · 有新版本/.test(document.querySelector('#page-work').textContent)"), 10000, '系統分頁寫版本');
  // 2. 按 × 不再提醒這一版
  await js("document.querySelector('[data-upd-hide]').click(); true");
  await until(() => js("!document.querySelector('.upd-banner')"), 5000, '收起來');
  await js('location.reload(); true');
  await until(() => js("!!document.querySelector('[data-pm-tab]')"), 15000, '重新整理');
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await js("!!document.querySelector('.upd-banner')"), false, '重新整理也不再提醒');
  console.log('update-check-ui-test：全部通過');
} catch (e) {
  console.error('update-check-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
