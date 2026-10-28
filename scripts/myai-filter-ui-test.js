// 我的 AI 篩選（真的瀏覽器）：專案檢視的「我的 AI」不能被看不見的篩選擋住
// 曾發生：專案寫 8 隻、列表「顯示 1／8」——全部檢視記住的「專案：A」在專案檢視（沒有專案下拉）仍套用
// 1. 全部檢視選專案 A → 切到專案 B 的我的 AI，B 的 AI 全部看得到
// 2. 記住的角色不在這個專案的選項裡 → 不套用
// 3. 有篩選造成「顯示 x／y」時，旁邊有「清除篩選」，一按全部顯示
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/myai-filter-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('myai-filter-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('maflt');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const pjs = (await kit.call(liu.token, '/api/projects')).body.items.filter(p => !p.archived);
  assert.ok(pjs.length >= 2, '至少兩個專案');
  const [A, B] = pjs;
  const mk = (name, projects, role) => kit.call(liu.token, '/api/my-ais', 'POST', { projects, roleKey: 'PG', role, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(r => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; });
  // A：2 隻只在 A（角色「品質」）；B：7 隻只在 B（角色「程式開發」）；1 隻兩邊都在
  for (let i = 1; i <= 2; i++) await mk(`甲${i}號`, [A.id], '品質');
  for (let i = 1; i <= 7; i++) await mk(`乙${i}號`, [B.id], '程式開發');
  await mk('兩邊號', [A.id, B.id], '程式開發');

  const { js, login } = await kit.browser(1280, 900);
  const rows = () => js("document.querySelectorAll('#ai-list [data-ma]').length");
  const cnt = () => js("(document.querySelector('#ma-find .fb-cnt')?.textContent || '').trim()");
  const open = async (path, prefs) => {
    await login(liu.token, '/');
    await js(`localStorage.setItem('aigile-find:myai', ${JSON.stringify(JSON.stringify(prefs))}); true`);
    await login(liu.token, path);
    await until(async () => (await rows()) > 0, 15000, '我的 AI 列表 ' + path);
    await new Promise(r => setTimeout(r, 300));
  };

  // 全部檢視：記住「專案：A」→ 只顯示 A 的 3 隻，旁邊有清除篩選
  await open('/my-ai', { proj: A.id });
  assert.equal(await rows(), 3, '全部檢視照樣套用看得到的專案篩選');
  assert.equal(await cnt(), '顯示 3／10');
  assert.ok(await js("!!document.querySelector('#ma-find .fb-clear')"), '顯示 x／y 旁邊有清除篩選');
  // 1. 切到 B 的專案檢視：沒有專案下拉 → 記住的「專案：A」不套用，B 的 8 隻全部看得到
  await open(`/p/${encodeURIComponent(B.slug || B.id)}/my-ai`, { proj: A.id });
  assert.equal(await js("!!document.querySelector('#ma-find [data-fb-proj]')"), false, '專案檢視沒有專案下拉');
  assert.equal(await rows(), 8, `B 的 AI 全部看得到（修正前只剩 1 隻）：${await cnt()}`);
  assert.equal(await cnt(), '8 個');
  assert.ok(!(await js("!!document.querySelector('#ma-find .fb-clear')")), '沒有篩選就不顯示清除篩選');
  // 2. 記住的角色「品質」不在 B 的選項裡 → 不套用
  await open(`/p/${encodeURIComponent(B.slug || B.id)}/my-ai`, { role: '品質' });
  assert.equal(await rows(), 8, '看不到的角色條件不生效');
  // 3. 看得到的篩選照樣生效；按清除篩選全部顯示
  await open('/my-ai', { role: '品質' });
  assert.equal(await rows(), 2, '全部檢視：角色品質 2 隻');
  await js("document.querySelector('#ma-find .fb-clear').click(); true");
  await until(async () => (await rows()) === 10, 5000, '清除篩選後全部顯示');
  assert.equal(await cnt(), '10 個');
  assert.equal(JSON.parse(await js("localStorage.getItem('aigile-find:myai')")).role, '', '清除也清掉記住的條件');
  console.log('myai-filter-ui-test：全部通過');
} catch (e) {
  console.error('myai-filter-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
