// 驗收測試：管理員設定「系統與備份」頁顯示即時通道模式（SSE／Supabase Realtime／輪詢）、最後一次即時事件時間與輪詢間隔
// A. API：SSE（live hub）、Supabase Realtime、輪詢三模式皆實際偵測並更新 lastEventAt；非管理員與 AI 回 403
// B. 畫面（中英文、1280／375）：管理員在 /admin/system 看到 SSE 即時通道卡、無橫向捲動；一般成員看不到
// 設 PLAT458_SHOTS=資料夾 可輸出截圖。用法：node scripts/realtime-status-ui-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { createLiveHub } from '../src/live.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';
import { startKit, findBrowser, until } from './browser-kit.js';

// ---------- 1) API 單元：SSE / Supabase Realtime / 輪詢 ＋ 權限 ----------
async function testApiModes() {
  const origFetch = globalThis.fetch;
  for (const kind of ['sse', 'supabase', 'polling']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rt-'));
    const db = await openTestDb(path.join(dir, 'switch.db'));
    const live = kind === 'sse' ? createLiveHub() : null;
    let broadcasts = 0;
    if (kind === 'supabase') {
      globalThis.fetch = async () => { broadcasts++; return new Response('{}', { status: 200 }); };
    }
    try {
      const app = createApp({
        db, storage: dbStorage(db), docText: '', live,
        config: {
          openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0',
          ...(kind === 'supabase' ? { supabaseUrl: 'https://sb.example.test', supabaseKey: 'test-key' } : {}),
        },
      });
      const call = async (token, p, method = 'GET', body) => {
        const waits = [];
        const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost', { waitUntil: pr => waits.push(pr) });
        await Promise.allSettled(waits);
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const admin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
      const member = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
      const ai = (await call(admin.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '甲PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
      const aiTok = await testToken(db, ai.participantId);

      assert.equal((await call(member.token, '/api/admin/realtime')).status, 403, '一般成員不可讀');
      assert.equal((await call(aiTok, '/api/admin/realtime')).status, 403, 'AI 不可讀');

      let rt = await call(admin.token, '/api/admin/realtime');
      assert.equal(rt.status, 200);
      assert.equal(rt.body.mode, kind, '實際偵測模式：' + kind);
      assert.equal(rt.body.lastEventAt, null, '尚未有即時事件');
      assert.equal(rt.body.pollIntervalSec, kind === 'sse' ? 60 : 5);

      if (kind === 'sse') {
        const conn = live.open({ id: admin.participant.participantId, kind: 'human' });
        assert.ok(conn.response);
        await call(admin.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '[進度] 測試 SSE' });
        rt = await call(admin.token, '/api/admin/realtime');
        assert.ok(rt.body.lastEventAt, 'SSE 推送後記錄最後一次即時事件時間');
        assert.equal(rt.body.connections, 1);
      } else if (kind === 'supabase') {
        await call(admin.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '[交接] 請處理', recipientIds: [ai.participantId], replyFrom: [ai.participantId] });
        assert.ok(broadcasts >= 1, 'Supabase 門鈴已送出');
        rt = await call(admin.token, '/api/admin/realtime');
        assert.ok(rt.body.lastEventAt, 'Supabase 送出後記錄最後一次即時事件時間');
      }
    } finally {
      if (live) live.closeAll();
      globalThis.fetch = origFetch;
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

await testApiModes();
console.log('✓ API 三模式與權限通過');

// ---------- 2) 畫面測試（中英文、1280／375） ----------
if (!findBrowser()) { console.log('realtime-status-ui-test：略過畫面（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('rtui');
try {
  const { call } = kit;
  const admin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const member = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  await call(admin.token, `/api/participants/${member.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => {
    if (!process.env.PLAT458_SHOTS) return;
    fs.mkdirSync(process.env.PLAT458_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.PLAT458_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  };

  // 管理員中文 1280（先發一則訊息觸發 SSE 即時事件，驗證「HH:MM（N 秒前）」格式）
  await size(1280, 900);
  await login(admin.token, '/admin/system');
  await until(() => js("/目前通道\\s+SSE/.test(document.querySelector('.adm-rt-card')?.innerText || '')"), 10000, '載入 SSE 即時通道卡');
  await call(admin.token, '/api/messages', 'POST', { requestId: 'ui-m1', project: '預設專案', text: '[進度] 觸發即時事件' });
  await until(() => js("/\\d{2}:\\d{2}（(剛剛|\\d+ 秒前)）/.test(document.querySelector('.adm-rt-card')?.innerText || '')"), 10000, '送出即時事件後顯示 HH:MM（剛剛／N 秒前）');
  const zhTxt = await js("document.querySelector('.adm-rt-card').innerText");
  assert.match(zhTxt, /目前通道\s+SSE/, '開源版顯示 SSE：' + zhTxt);
  assert.match(zhTxt, /最後一次送出即時事件\s+\d{2}:\d{2}（(剛剛|\d+ 秒前)）/, '顯示 HH:MM（剛剛／N 秒前）');
  assert.match(zhTxt, /輪詢間隔\s+/, '顯示輪詢間隔');
  assert.match(zhTxt, /新訊息約 1 秒內出現。/, '白話說明 SSE 延遲');
  assert.equal(await js("document.querySelectorAll('.adm-rt-card .adm-rico').length"), 0, '不顯示多餘圖示方塊');
  assert.ok(!(await hscroll()), '中文 1280 無橫向捲動');
  await shot('PLAT-458-oss-zh-1280');

  // 管理員中文 375
  await size(375, 812);
  await until(() => js("!!document.querySelector('.adm-rt-card')"), 5000, '手機顯示即時通道卡');
  assert.ok(!(await hscroll()), '中文 375 無橫向捲動');
  await shot('PLAT-458-oss-zh-375');

  // 管理員英文 1280
  await size(1280, 900);
  await js("localStorage.setItem('aigile-lang', 'en'); window.__staleReload = 1; location.reload(); true");
  await until(() => js('!window.__staleReload'), 20000, '重新整理後換成新頁面');
  await until(() => js("document.documentElement.lang === 'en' && /Current channel\\s+SSE/.test(document.querySelector('.adm-rt-card')?.innerText || '')"), 15000, '英文介面即時通道卡');
  const enTxt = await js("document.querySelector('.adm-rt-card').innerText");
  assert.match(enTxt, /Last realtime event sent\s+\d{2}:\d{2} \((just now|\d+s ago)\)/, '英文最後事件：' + enTxt);
  assert.match(enTxt, /Polling interval\s+/, '英文輪詢間隔');
  assert.match(enTxt, /New messages show up within about 1 second\./, '英文延遲說明');
  assert.ok(!(await hscroll()), '英文 1280 無橫向捲動');
  await shot('PLAT-458-oss-en-1280');

  // 一般成員看不到
  await js("localStorage.removeItem('aigile-lang'); true");
  await login(member.token, '/admin/system');
  await until(() => js("location.pathname !== '/admin/system' || !document.querySelector('.adm-rt-card')"), 8000, '非管理員不可見');
  assert.equal(await js("!!document.querySelector('.adm-rt-card')"), false, '一般成員不顯示即時通道卡');
  assert.equal((await call(member.token, '/api/admin/realtime')).status, 403, '一般成員 API 回 403');

  console.log('realtime-status-ui-test：全部通過（API 三模式＋中英文 1280/375＋一般成員隱藏）');
} finally {
  await kit.stop();
}
