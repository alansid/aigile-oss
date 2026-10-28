// 走查建議的畫面細節（真的瀏覽器，正式啟動：有預設管理員）
// 1. 還沒改預設帳密：登入頁提示「看 README」（不寫出密碼）；改好後不再提示
// 2. 註冊的帳號不合規則：不能有的字一個一個列（不能有：空白、!）
// 3. 第一次設定引導按「全部略過」：主畫面出現「接下來可以做的事」，按「知道了」收起
// 4. 審核加入申請：角色預先帶入註冊時填的，兩個下拉都有標籤
// 用法：node scripts/walkthrough-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('walkthrough-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('walk', { env: { AIGILE_TEST_PROJECTS: '' } });
try {
  const { js, cdp } = await kit.browser(1280, 900);
  const q = s => JSON.stringify(s);
  const visible = sel => js(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !!e.offsetParent && !e.hidden; })()`);
  const type = (sel, v) => js(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const open = async (token = null) => {
    await cdp('Page.navigate', { url: kit.BASE + '/' }); await until(() => js('document.readyState === "complete"'), 15000, '首頁');
    await js(`localStorage.clear(); ${token ? `localStorage.setItem('aigile-switch-token', ${q(token)});` : ''} true`);
    await cdp('Page.navigate', { url: kit.BASE + '/' });
  };

  // 1. 登入頁提示
  assert.equal((await kit.call(null, '/api/health')).body.defaultCredentials, true, '健康檢查：預設帳密還沒改');
  await open();
  await until(() => visible('#pwd-form'), 15000, '登入頁');
  await until(() => visible('#first-admin'), 5000, '登入頁提示看 README');
  assert.ok(!/admin/i.test(await js("document.querySelector('.join-first').textContent")), '提示不寫出帳號密碼');
  assert.match(await js("document.querySelector('.join-first').textContent"), /^第一次使用？管理員：帳號密碼看安裝說明（README）；其他人：自己註冊，或請管理員傳邀請連結給你。$/, '「第一次使用」只有一句');

  // 2. 註冊帳號的錯誤：分開列
  await js("document.querySelector('#self-join').click(); true");
  await until(() => visible('#jn-user'), 5000, '註冊表單');
  await type('#jn-user', 'ab c!d');
  assert.equal(await js("document.querySelector('#jn-user-hint').textContent"), '只能用英文、數字和 . _ -，不能有：空白、!');
  assert.equal(await js("document.querySelector('#jn-user').getAttribute('aria-invalid')"), 'true', '紅框');
  assert.match(await js("document.querySelector('#join-desc').textContent"), /申請加入專案/, '註冊說明是申請加入的流程');
  console.log('✓ 登入頁提示、註冊錯誤分開列');

  // 改好帳密：提示不見
  const boss = (await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  assert.equal((await kit.call(boss, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' })).status, 200);
  assert.equal((await kit.call(null, '/api/health')).body.defaultCredentials, undefined, '改好後不再回 defaultCredentials');
  await open();
  await until(() => visible('#pwd-form'), 15000, '登入頁');
  await sleep(500);
  assert.equal(await visible('#first-admin'), false, '改好後登入頁不再提示');

  // 3. 引導全部略過 → 主畫面提示下一步
  await open(boss);
  await until(() => js("!!document.querySelector('[data-sw=\"skipall\"]')"), 20000, '引導');
  await js("document.querySelector('[data-sw=\"skipall\"]').click(); true");
  await until(() => visible('.hub-next'), 20000, '主畫面的「接下來可以做的事」');
  const acts = await js("[...document.querySelectorAll('.hub-next [data-next]')].map(b => b.dataset.next).join(',')");
  assert.equal(acts, 'wizard,projects,invites,system,close');
  await js("document.querySelector('.hub-next [data-next=\"invites\"]').click(); true");
  await until(() => js("document.querySelector('[data-pm-tab=\"invites\"]')?.getAttribute('aria-selected') === 'true'"), 10000, '直接到邀請分頁');
  await cdp('Page.navigate', { url: kit.BASE + '/' });
  await until(() => visible('.hub-next'), 30000, '回主畫面還在'); // 全套一起跑時機器忙，給久一點
  await js("document.querySelector('.hub-next [data-next=\"close\"]').click(); true");
  await until(async () => !(await visible('.hub-next')), 5000, '按知道了收起');
  await cdp('Page.reload'); await sleep(1500);
  await until(() => js("!!document.querySelector('.hub')"), 15000, '主畫面');
  assert.equal(await visible('.hub-next'), false, '重新整理後不再出現');
  console.log('✓ 引導略過後的下一步提示');

  // 4. 審核視窗帶入註冊時的角色
  const lin = (await kit.call(null, '/api/join', 'POST', { name: '林新人', role: 'UX' })).body;
  const pj = (await kit.call(boss, '/api/projects')).body.items[0].id;
  const ap = await kit.call(lin.token, `/api/projects/${encodeURIComponent(pj)}/join-requests`, 'POST', { note: '想幫忙' });
  assert.ok(ap.status < 300, JSON.stringify(ap.body));
  const reqs = (await kit.call(boss, '/api/join-requests')).body.items;
  assert.equal(reqs.find(x => x.participantId === lin.participant.participantId)?.role, 'UX', 'API 帶註冊時的角色');
  await cdp('Page.reload');
  await until(() => js("[...document.querySelectorAll('.hub-todo button, .hub-todo a')].some(b => /林新人 申請加入/.test(b.textContent))"), 20000, '主畫面「要你處理」有申請');
  await js("[...document.querySelectorAll('.hub-todo button, .hub-todo a')].find(b => /林新人 申請加入/.test(b.textContent)).click(); true");
  await until(() => js("!!document.querySelector('[data-join-review], [data-jr-role]')"), 15000, '進到收件匣的申請');
  if (!(await js("!!document.querySelector('[data-jr-role]')")))   await js("document.querySelector('[data-join-review]').click(); true");
  await until(() => js("!!document.querySelector('[data-jr-role]')"), 10000, '審核視窗');
  assert.equal(await js("document.querySelector('[data-jr-role]').value"), 'UX', '角色預先帶入 UX');
  assert.equal(await js("[...document.querySelectorAll('.jr-lab > span')].map(s => s.textContent).join(',')"), '角色,權限', '兩個下拉都有標籤');
  console.log('✓ 審核視窗帶入角色、下拉有標籤');

  // 5. 工作總覽：「要你處理」是 0 但有自己負責的待整理卡要說；決策按鈕緊接在問題下面；手機空的統計框不佔位
  const bossId = (await kit.call(boss, '/api/me')).body.participantId;
  const todo = await kit.call(boss, '/api/cards', 'POST', { requestId: 'walk-todo', project: pj, title: '還沒整理的卡', ownerId: bossId });
  assert.ok(todo.status < 300 && todo.body.status === '待整理' && todo.body.owner?.participantId === bossId, JSON.stringify(todo.body));
  const dec = await kit.call(boss, '/api/cards', 'POST', { requestId: 'walk-dec', project: pj, type: '決策', title: '要不要上線', question: '這週要不要上線？', options: ['上線', '先不要'], recommendation: '上線', deciderId: bossId });
  assert.ok(dec.status < 300, JSON.stringify(dec.body));
  const slug = (await kit.call(boss, '/api/projects')).body.items[0].slug || pj;
  await cdp('Page.navigate', { url: `${kit.BASE}/p/${encodeURIComponent(slug)}/work` });
  await until(() => js("!!document.querySelector('.wpanel.mine') && !!document.querySelector('.dcard')"), 20000, '工作總覽');
  assert.match(await js("document.querySelector('.wpanel.mine').textContent"), /有 1 張你負責的卡還在待整理，還不用動手。/, '空狀態說有待整理的卡');
  assert.equal(await js("!!document.querySelector('.wpanel.mine [data-filter=\"待整理\"]')"), true, '可以直接看待整理的卡');
  const order = await js("[...document.querySelector('.dcard').children].map(e => e.tagName === 'H4' ? 'q' : e.matches('.dbox') ? 'box' : e.querySelector('button') && !e.matches('.dcard-top') ? 'act' : '').filter(Boolean).join(',')");
  assert.match(order, /^q,act,box/, '決策卡：問題 → 按鈕 → 建議方案：' + order);
  assert.equal(await js("document.querySelector('.crow-wait.me')?.textContent"), '等你', '卡片列表「等誰」寫「等你」，中間沒有空格');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.reload'); // 手機寬度下重新打開（行內回覆是否收起在畫的時候決定）
  await until(() => js("!!document.querySelector('.wpanel.mine') && !!document.querySelector('.dcard')"), 20000, '手機工作總覽');
  await sleep(300);
  const shown = await js("[...document.querySelectorAll('.wpanel')].filter(e => e.offsetParent).map(e => e.classList[1]).join(',')");
  assert.equal(shown, 'mine', '手機：空的「受阻」「最近完成」不佔位，有提示的「要你處理」留著');
  await until(() => js("[...document.querySelectorAll('.dcard [data-inl-act=\"decide\"][data-result]')].filter(b => b.offsetParent).length === 2"), 5000, '手機：決策選項不用先按「回覆…」就看得到');
  assert.equal(await js("document.querySelector('.dcard [data-inl-open]')?.textContent"), '其他回覆…', '其他回覆收起來');
  assert.ok(await js("document.querySelector('.dcard [data-inl-act=\"decide\"]').getBoundingClientRect().bottom <= innerHeight"), '手機：決策按鈕在第一屏');
  await js("document.querySelector('.dcard [data-inl-act=\"decide\"][data-result=\"先不要\"]').click(); true");
  await until(async () => (await kit.call(boss, `/api/cards/${dec.body.cardId}`)).body.decision?.result === '先不要', 8000, '手機直接按選項就決定');
  await cdp('Emulation.clearDeviceMetricsOverride');
  console.log('✓ 工作總覽空狀態、決策按鈕位置、手機統計框');
  console.log('walkthrough-ui-test：全部通過');
} catch (e) {
  console.error('walkthrough-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally { await kit.stop(); }
