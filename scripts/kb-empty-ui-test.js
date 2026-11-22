// 畫面測試：知識庫還是空的
// A. leader／管理員：「知識庫還是空的」＋說明＋「⬆ 上傳到知識庫」「從專案文件挑」＋教學連結；頁頂不重複放上傳按鈕
// B. 一般成員：不放按鈕，寫「請 leader 把文件放進來。」
// C. 專案文件有檔但都不在知識庫：知識庫照樣是空的；「從專案文件挑」切到專案文件分頁
// D. 1280、375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 KB_EMPTY_SHOTS=資料夾 會另外截圖。用法：node scripts/kb-empty-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('kb-empty-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('kbempty');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  await fetch(`${kit.BASE}/api/projects/${encodeURIComponent('預設專案')}/docs?${new URLSearchParams({ name: '會議紀錄.md', declared: 'true' })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + chen.token }, body: '# 週會\n下週三上線。' });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.KB_EMPTY_SHOTS) return; fs.mkdirSync(process.env.KB_EMPTY_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_EMPTY_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const openKb = async tok => {
    await login(tok, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
    await js("document.querySelector('[data-files-tab=\"kb\"]').click(); true");
    await until(() => js("!!document.querySelector('.kb-empty')"), 8000, '空的知識庫');
  };
  const intro = '知識庫還是空的 把想讓 AI 讀懂的文件放進來，例如規章、手冊、流程。放進來的會抽字、整理成知識頁，大家和 AI 都搜得到；一般專案文件不會。';

  for (const [w, h, tag] of [[1280, 900, '電腦1280'], [375, 812, '手機375']]) {
    await size(w, h);
    // ---------- A、C leader／管理員 ----------
    await openKb(liu.token);
    assert.equal(await text('.kb-empty'), `📚 ${intro} ⬆ 上傳到知識庫 從專案文件挑 第一次用？看教學：知識庫怎麼設定 ›`, 'A 空畫面：' + await text('.kb-empty'));
    assert.equal(await js("document.querySelectorAll('[data-kb-up]').length"), 1, 'A 空的時候頁頂不重複放上傳按鈕');
    assert.equal(await js("document.querySelector('.kb-empty a').getAttribute('href')"), '/help/6', 'A 教學連結到第 6 章');
    assert.ok(!(await hscroll()), `D ${tag} 不橫向捲動`);
    await shot(`01-${tag}-知識庫還是空的-leader`);
    // ---------- B 一般成員 ----------
    await openKb(chen.token);
    assert.equal(await text('.kb-empty'), `📚 ${intro} 請 leader 把文件放進來。 第一次用？看教學：知識庫怎麼設定 ›`, 'B 一般成員：' + await text('.kb-empty'));
    assert.equal(await js("document.querySelectorAll('[data-kb-up], [data-kb-go-docs]').length"), 0, 'B 一般成員沒有按鈕');
    await shot(`02-${tag}-知識庫還是空的-一般成員`);
  }
  // C：從專案文件挑 → 切到專案文件分頁
  await size(1280, 900);
  await openKb(liu.token);
  await js("document.querySelector('[data-kb-go-docs]').click(); true");
  await until(() => js("document.querySelector('[data-files-tab=\"docs\"]').getAttribute('aria-selected') === 'true' && !!document.querySelector('[data-kb-pick]')"), 8000, 'C 切到專案文件、有勾選框');

  console.log('kb-empty-ui-test：全部通過（空的知識庫：leader 兩顆按鈕與教學連結、一般成員一行說明、從專案文件挑、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
