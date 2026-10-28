// 畫面測試（真的瀏覽器）：網頁走內建即時通道
// 1. 本機／Docker 版：別人發的訊息 3 秒內出現（連著即時通道時輪詢放慢到 60 秒，所以不是輪詢抓到的）
// 2. 關掉內建即時通道（LIVE=0）：照舊靠 5 秒輪詢，8 秒內出現
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/live-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('live-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function scenario(env, within, label) {
  const kit = await startKit('liveui', { env });
  try {
    const a = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
    const b = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
    const { js, login } = await kit.browser(1280, 800);
    await login(b.token, '/');
    await until(() => js("!!document.querySelector('.av-btn')"), 15000, '登入');
    await js("history.pushState(null, '', '/cross/messages'); dispatchEvent(new PopStateEvent('popstate')); true");
    await sleep(6000); // 等網頁連好、也讓第一輪輪詢過去
    const t0 = Date.now();
    assert.equal((await kit.call(a.token, '/api/messages', 'POST', { requestId: 'm' + Date.now(), project: 'all', text: '即時測試訊息' })).status, 201);
    await until(() => js("/即時測試訊息/.test(document.body.textContent)"), within, label);
    return Date.now() - t0;
  } finally { await kit.stop(); }
}
try {
  const t1 = await scenario({}, 3000, '即時通道：3 秒內出現');
  const t2 = await scenario({ LIVE: '0' }, 8000, '沒有即時通道：5 秒輪詢內出現');
  console.log(`live-ui-test：全部通過（即時 ${t1} ms、輪詢 ${t2} ms）`);
} catch (e) {
  console.error('live-ui-test 失敗：', e.message);
  process.exitCode = 1;
}
