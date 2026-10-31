// 畫面測試（真的瀏覽器）：看板卡片文字換行、不被欄寬切掉
// UX 在英文示範資料看到「待確認」「已完成」欄「…after sign-u」「10/2」被切：欄被一段不換行的長字撐寬，超出的部分被欄藏起來
// 中英 × 1280／375 × 淺深色：每一欄都沒有橫向捲動、欄內每個元素都不超出欄寬、文字沒有被藏起來（「已驗證」精簡列標題照設計省略）
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/board-wrap-ui-test.js（設 SHOTS=資料夾 會存截圖）
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('board-wrap-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('bwrap', { env: { AIGILE_TEST_PROJECTS: '0', UPDATE_CHECK: '0' } });
try {
  await until(async () => (await kit.call(null, '/api/health')).status === 200, 10000, '伺服器');
  const tok = (await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  assert.equal((await kit.call(tok, '/api/me/password', 'PUT', { username: 'owner1', currentPassword: 'admin', newPassword: 'pass-word-9', newPasswordAgain: 'pass-word-9' })).status, 200, '改帳密');

  const { js, login, cdp } = await kit.browser(1280, 900);
  await login(tok, '/');
  await until(() => js("!!document.querySelector('[data-sw=\"skipall\"]')"), 15000, '第一次設定引導');
  await js("document.querySelector('[data-sw=\"skipall\"]').click(); true"); // 引導會蓋住看板
  await until(() => js("!document.querySelector('[data-sw=\"skipall\"]')"), 5000, '引導關掉');
  // 欄被撐出橫向捲動、欄裡有東西超出欄的右邊、或文字被藏起來（scrollWidth 比看得到的寬）就列出來
  // 只有「已驗證」精簡列的標題照設計省略成一行（…），其他都要換行
  const clipped = () => js(`(() => {
    const bad = [];
    for (const col of document.querySelectorAll('.bcol')) {
      const st = col.dataset.col;
      if (col.scrollWidth > col.clientWidth + 1) bad.push(st + '：欄有橫向捲動（' + col.scrollWidth + '／' + col.clientWidth + '）');
      const edge = col.getBoundingClientRect().left + col.clientLeft + col.clientWidth;
      for (const el of col.querySelectorAll('.ctile, .ctile *, .cmini, .cmini *')) {
        if (!el.offsetParent || !el.textContent.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.right > edge + 0.5) bad.push(st + '：超出欄寬 ' + el.className + '「' + el.textContent.trim().slice(0, 40) + '」');
        else if (!el.matches('.cmini-t') && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
          bad.push(st + '：字被切 ' + el.className + '「' + el.textContent.trim().slice(0, 40) + '」');
      }
    }
    return bad;
  })()`);
  const shot = async name => {
    if (!process.env.SHOTS) return;
    const { result: { data } } = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };

  for (const lang of ['en', 'zh']) {
    await kit.call(tok, '/api/admin/demo', 'DELETE');
    assert.equal((await kit.call(tok, '/api/admin/demo', 'POST', lang === 'en' ? { lang } : undefined)).status, 200, '載入示範資料');
    const pj = (await kit.call(tok, '/api/admin/demo')).body.projectId;
    // 已完成欄要有已驗證的精簡列：示範的完成卡由別人驗證（管理員不是完成者）
    const done = (await kit.call(tok, `/api/cards?project=${encodeURIComponent(pj)}`)).body.items.find(c => c.status === '已完成');
    if (done && !done.verified) assert.equal((await kit.call(tok, `/api/cards/${done.cardId}/verify`, 'POST')).status, 200, '驗證完成卡');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); true`);
    for (const [w, h] of [[1280, 900], [375, 800]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
      for (const theme of ['light', 'dark']) {
        await js(`history.pushState(null, '', '/p/${pj}/work'); localStorage.setItem('aigile-theme', '${theme}'); location.reload(); true`);
        await until(() => js("document.readyState === 'complete' && !!document.querySelector('[data-view=\"B\"]')"), 20000, '工作頁');
        await js(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('[data-view="B"]').click(); true`);
        const cols = w < 900 ? ['待確認', '已完成'] : [null];
        for (const c of cols) {
          if (c) { await until(() => js(`!!document.querySelector('[data-mcol="${c}"]')`), 10000, '手機狀態切換'); await js(`document.querySelector('[data-mcol="${c}"]').click(); true`); }
          await until(() => js(`!!document.querySelector('.bcol[data-col="${c || '已完成'}"] .cmini, .bcol[data-col="${c || '已完成'}"] .ctile')`), 10000, '看板卡片');
          await sleep(200);
          const bad = await clipped();
          const where = `${lang} ${w} ${theme}${c ? ' ' + c : ''}`;
          await shot(`board-${lang}-${w}-${theme}${c ? '-' + (c === '已完成' ? 'done' : 'confirm') : ''}`);
          assert.deepEqual(bad, [], `${where}：有文字超出欄寬：${bad.join("；")}`);
          console.log(`✓ ${where}`);
        }
      }
    }
  }
  console.log('board-wrap-ui-test：全部通過');
} catch (e) {
  console.error('board-wrap-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
