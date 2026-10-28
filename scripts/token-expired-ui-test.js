// 畫面測試（真的瀏覽器，手機寬 375px）：Token 已過期的 AI 不能顯示綠色「在線」；摘要分開寫；Token 橫幅一行、可收合
// UX 全面驗收必修③、應修①
// 1. 過期的 AI 狀態寫「Token 已過期」（不是在線），旁邊有重發 Token
// 2. 上方摘要分開寫「Token 已過期 N 隻」「Token 快到期 N 隻」，過期的不算在線
// 3. 橫幅可收合；收合後換頁、重新整理都不再跳出；有新的過期才再出現
// 4. 375px 橫幅一行（不超過 48px 高）
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/token-expired-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('token-expired-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const mk = async (name, role = 'PG') => { const a = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; assert.ok(a.participantId, JSON.stringify(a)); return { id: a.participantId, tok: kit.aiToken(a.participantId) }; };
  // 過期一號：Token 過期、但剛剛還有活動（修正前會顯示綠色在線）。先建、先改；後面再建 AI 時平台會重讀成員表
  const ex = await mk('過期一號');
  kit.sql('UPDATE participants SET token_expires_at = ?, last_seen_at = ?, standby_at = ? WHERE id = ?', Date.now() - 60_000, Date.now(), Date.now(), ex.id); // 還留著剛剛的待命心跳（匯入備份後就是這樣）
  const soon = await mk('快到期二號');
  kit.sql('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() + 5 * 3600_000, soon.id);
  const ok = await mk('正常三號', '程式開發'); // 職稱長一點：手機那列字多，才看得出「Token 到 MM/DD」會不會被擠斷
  await kit.call(ok.tok, '/api/me'); // 正常三號在線

  const { js, login } = await kit.browser(375, 800);
  await login(boss.token, '/my-ai');
  const row = id => `document.querySelector('[data-ma="${id}"]')`;
  await until(() => js(`!!${row(ex.id)}`), 10000, '我的 AI 列表');
  // 1. 狀態寫 Token 已過期，不是在線；旁邊有重發 Token
  assert.equal(await js(`${row(ex.id)}.querySelector('.ma-st').textContent.trim()`), 'Token 已過期');
  assert.equal(await js(`${row(ex.id)}.querySelector('.ma-st').classList.contains('on')`), false, '不是綠色在線');
  assert.equal(await js(`${row(ex.id)}.querySelector('.ma-st').classList.contains('bad')`), true, '紅色');
  assert.equal(await js(`!!${row(ex.id)}.querySelector('[data-act="reissue"]')`), true, '旁邊有重發 Token');
  assert.match(await js(`${row(ok.id)}.querySelector('.ma-st').textContent`), /在線/, '正常的照舊在線');
  // 手機也看得到「複製接入設定」與 Token 到期日（修正前只剩「⋯」）
  assert.equal(await js(`(() => { const b = ${row(ok.id)}.querySelector('.ma-copy'); return !!b && b.offsetParent !== null && b.getBoundingClientRect().right <= innerWidth; })()`), true, '375 看得到複製接入設定');
  assert.match(await js(`${row(ok.id)}.querySelector('.ma-meta').innerText`), /Token 到 \d/, '375 看得到 Token 到期日');
  assert.equal(await js(`(() => { const t = ${row(ok.id)}.querySelector('.ma-mtok'), m = ${row(ok.id)}.querySelector('.ma-main').getBoundingClientRect(), r = t.getBoundingClientRect(); return t.getClientRects().length === 1 && r.right <= m.right + 1 && !/^·/.test(t.textContent.trim()); })()`), true, '375「Token 到 MM/DD」自己一行、不被擠斷、不超出');
  // 2. 摘要分開寫，過期的不算在線
  const sum = await js("document.querySelector('#ma-sum').textContent");
  assert.match(sum, /3 隻 · 1 在線/, '過期的不算在線：' + sum);
  assert.match(sum, /Token 已過期 1 隻/, sum);
  assert.match(sum, /Token 快到期 1 隻/, sum);
  // 4. 375px 橫幅一行
  const bar = () => js("(() => { const b = document.querySelector('#token-alert'); return b && !b.hidden ? b.textContent.replace(/\\s+/g, ' ').trim() : ''; })()");
  assert.match(await bar(), /過期一號 的 Token 已過期/);
  assert.equal(await js("document.querySelector('#token-alert').getBoundingClientRect().height <= 48"), true, '一行：' + await js("document.querySelector('#token-alert').getBoundingClientRect().height"));
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '沒有橫向捲動');
  assert.equal(await js("(() => { const r = document.querySelector('#token-alert .alert-close').getBoundingClientRect(); return r.right <= innerWidth && r.width >= 44; })()"), true, '收合鈕在畫面內、夠大');
  // 3. 收合：換頁、重新整理都不再跳出
  await js("document.querySelector('#token-alert .alert-close').click(); true");
  assert.equal(await bar(), '', '收起來');
  await js("history.pushState(null, '', '/p/main/work'); dispatchEvent(new PopStateEvent('popstate')); true");
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await bar(), '', '換頁不再跳出');
  await js('location.reload(); true');
  await until(() => js("!!document.querySelector('.av-btn')"), 15000, '重新整理');
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await bar(), '', '重新整理不再跳出');
  // 5. 側欄人數：過期一號留著待命心跳也不算待命；快到期二號從沒連線＝還沒接入；正常三號在線＝待命（修正前寫「2 待命」，跟紅條、我的 AI 說法不一）
  await until(() => js("/AI 0 在做事、1 待命、1 還沒接入/.test(document.querySelector('.sb-presence-text')?.textContent || '')"), 10000, '側欄 AI 人數：' + await js("document.querySelector('.sb-presence-text')?.textContent"));
  // 有新的過期才再出現：快到期二號也過期了
  kit.sql('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() - 1000, soon.id);
  await mk('觸發重讀'); // 新增 AI 會讓平台重讀成員表
  await js('location.reload(); true');
  await until(async () => /快到期二號 的 Token 已過期/.test(await bar()), 15000, '新的過期再出現：' + await bar());
  console.log('token-expired-ui-test：全部通過');
} catch (e) {
  console.error('token-expired-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
