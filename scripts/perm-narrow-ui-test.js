// 成員與權限：主區塊變窄（1280 開私訊面板、1024 筆電）時成員表不崩版；明細內容與邊框留間距
// 用法：node scripts/perm-narrow-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('perm-narrow-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  for (const [n, r] of [['王小明', 'UX'], ['陳大文', 'QA']]) {
    const p = (await kit.call(null, '/api/join', 'POST', { name: n, role: r })).body;
    await kit.call(boss.token, `/api/participants/${p.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  }
  await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '示範的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const { js, login, cdp } = await kit.browser(1400, 800);

  // 打開成員與權限的「依專案 › 平台」；dm＝模擬右邊私訊面板開著（主區塊讓出 380px）
  const open = async (w, dm = false) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 600 });
    await login(boss.token, '/members');
    await until(() => js("!!document.querySelector('.pm-split')"), 10000, '成員與權限');
    await js("document.querySelector('[data-pm-proj=\"預設專案\"]')?.click(); true");
    await until(() => js("!!document.querySelector('.pm-detail .pm-table')"), 8000, '平台明細');
    if (dm) await js("document.body.classList.add('dm-open'); document.querySelector('#dm-panel').hidden = false; true");
    await new Promise(r => setTimeout(r, 200));
  };
  // 名字一行：每個名字的文字只佔一行；看得到的欄名不互相重疊；沒有橫向捲動
  const check = async label => {
    const r = JSON.parse(await js(`JSON.stringify((() => {
      const names = [...document.querySelectorAll('.pm-detail .c-name .pm-name-link')].map(e => { const g = document.createRange(); g.selectNodeContents(e); const lines = new Set([...g.getClientRects()].map(x => Math.round(x.top))).size; return { t: e.textContent, lines, ok: lines === 1 }; });
      const th = [...document.querySelectorAll('.pm-detail .pm-table thead th')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      const overlap = th.some((a, i) => th.slice(i + 1).some(b => a.right > b.left + 1 && b.right > a.left + 1));
      const textOk = [...document.querySelectorAll('.pm-detail .pm-table thead th')].filter(e => e.offsetParent).every(e => e.scrollWidth <= e.clientWidth + 1);
      return { names, overlap, textOk, scroll: document.documentElement.scrollWidth > innerWidth + 1 };
    })())`));
    assert.ok(r.names.length >= 3, label + '：有成員：' + JSON.stringify(r.names));
    assert.ok(r.names.every(n => n.ok), label + '：名字橫排一行：' + JSON.stringify(r.names));
    assert.ok(!r.overlap && r.textOk, label + '：欄名不重疊');
    assert.ok(!r.scroll, label + '：沒有橫向捲動');
  };
  // 明細裡的搜尋列、管理員說明、開放申請加入卡：左右離明細邊框至少 8px
  const inset = async label => {
    const r = JSON.parse(await js(`JSON.stringify((() => {
      const d = document.querySelector('.pm-detail').getBoundingClientRect();
      return ['.pm-detail > .fb', '.pm-detail > .pm-join'].map(s => { const e = document.querySelector(s); if (!e) return { s, miss: true }; const b = e.getBoundingClientRect(); return { s, l: Math.round(b.left - d.left), r: Math.round(d.right - b.right) }; });
    })())`));
    for (const x of r) assert.ok(!x.miss && x.l >= 8 && x.r >= 8, label + '：' + JSON.stringify(x));
  };

  await open(1280, true); await check('1280＋私訊面板'); await inset('1280＋私訊面板');
  await open(1440, true); await check('1440＋私訊面板');
  await open(1024); await check('1024'); await inset('1024');
  await open(1440); await check('1440'); await inset('1440');
  assert.equal(await js("getComputedStyle(document.querySelector('.pm-detail .pm-table thead')).display"), 'table-header-group', '1440 夠寬：維持四欄表格');
  await open(375); await check('375');

  // 角色分頁：說明文字不貼左邊框
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await login(boss.token, '/members');
  await until(() => js("!!document.querySelector('.pm-split')"), 10000, '成員與權限');
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '角色').click(); true");
  await until(() => js("!!document.querySelector('.pr-note')"), 8000, '角色分頁');
  assert.ok(await js("document.querySelector('.pr-note').getBoundingClientRect().left - document.querySelector('.pm-panel').getBoundingClientRect().left >= 8"), '角色分頁說明不貼邊');
  console.log('perm-narrow-ui-test：全部通過');
} catch (e) {
  console.error('perm-narrow-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
