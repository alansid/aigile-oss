// 獨立單元測試：src/update.js 邊界案例（版本檢查、快取／節流、錯誤處理、無可用更新、權限與設定）
// 嚴格隔離：
// - 不連網：使用 config.updateFetch 注入假回應，並鎖死 globalThis.fetch 確保絕不打網路
// - 不讀寫真的 ~/.aigile 或 ~/.codex：所有資料與暫存目錄建於 os.tmpdir()，於 finally 清除
// 用法：node scripts/update-edge-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-upd-edge-'));
const isolatedHome = path.join(tmpRoot, 'home');
fs.mkdirSync(isolatedHome, { recursive: true });
process.env.AIGILE_HOME = path.join(isolatedHome, '.aigile');
process.env.CODEX_HOME = path.join(isolatedHome, '.codex');
process.env.AIGILE_GEMINI_HOME = path.join(isolatedHome, '.gemini');
process.env.COPILOT_HOME = path.join(isolatedHome, '.copilot');

const { createApp } = await import('../src/core.js');
const { openTestDb } = await import('./test-db.js');
const { dbStorage } = await import('../src/storage-db.js');
const { registerUpdateCheck, UPDATE_REPO } = await import('../src/update.js');
const { APP_VERSION, cmpVersion } = await import('../src/version.js');

const DAY_MS = 24 * 3600_000;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  throw new Error(`禁止真實連網：${url}`);
};

const dbs = [];
try {
  // 1. cmpVersion 邊界案例
  assert.ok(cmpVersion('2.0.0', '1.99.99') > 0, '主版號進位比較');
  assert.ok(cmpVersion('1.10.0', '1.9.9') > 0, '次版號數字比較（非字串字典序）');
  assert.ok(cmpVersion('1.0.8', '1.0.7') > 0, '修訂版號比較');
  assert.equal(cmpVersion('v1.0.7', '1.0.7'), 0, 'v 前綴應視為相同');
  assert.equal(cmpVersion('1.2.3-beta.1', '1.2.3'), 0, '預先發行後綴取前三碼');
  assert.equal(cmpVersion('V1.0.7', '0.0.0'), 0, '大寫 V 非合法前綴視為 0.0.0');
  assert.equal(cmpVersion('', null), 0, '空字串與 null 視為 0.0.0');
  assert.equal(cmpVersion(undefined, '0.0.0'), 0, 'undefined 視為 0.0.0');
  assert.ok(cmpVersion('1.0.0', '1.0.1') < 0, '較舊版回負數');

  // 2. 純單元測試 registerUpdateCheck：config.updateCheck 各種開關值
  for (const [val, expected] of [
    [false, false],
    ['0', false],
    [0, false],
    [true, true],
    ['1', true],
    ['', true],
    [undefined, true],
  ]) {
    let handler = null;
    let fetchCalls = 0;
    let dbCalls = 0;
    registerUpdateCheck({
      route: (m, p, fn) => {
        assert.equal(m, 'GET');
        assert.equal(p, '/api/admin/update-check');
        handler = fn;
      },
      db: {
        async get() { dbCalls++; return null; },
        async run() { dbCalls++; return { changes: 0 }; },
      },
      requireHuman: () => {},
      requireAdmin: async () => {},
      config: {
        updateCheck: val,
        updateFetch: async () => {
          fetchCalls++;
          return new Response(JSON.stringify({ tag_name: 'v' + APP_VERSION }), { status: 200 });
        },
      },
    });
    const res = await handler({ ctx: {}, me: { id: 'u1' } });
    assert.equal(res.enabled, expected, `updateCheck=${String(val)} 應為 ${expected}`);
    assert.equal(res.current, APP_VERSION);
    if (!expected) {
      assert.equal(fetchCalls, 0, '關閉時不應呼叫 fetch');
      assert.equal(dbCalls, 0, '關閉時不應讀寫資料庫');
    } else {
      assert.equal(fetchCalls, 1, '開啟時應查詢一次');
    }
  }

  // 3. 完整 createApp 整合測試（SQLite 建於 os.tmpdir()）
  let calls = 0;
  let nextReply = null;
  const fakeFetch = async (url, opts) => {
    calls++;
    assert.equal(url, `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    assert.equal(opts.headers.Accept, 'application/vnd.github+json');
    assert.equal(opts.headers['User-Agent'], 'aigile-switch-update-check');
    assert.ok(opts.signal instanceof AbortSignal, '應傳入 AbortSignal');
    assert.equal(opts.signal.aborted, false);
    if (typeof nextReply === 'function') return nextReply(url, opts);
    if (nextReply instanceof Error) throw nextReply;
    return new Response(JSON.stringify(nextReply.body), { status: nextReply.status || 200 });
  };

  const makeSite = async (name, extraConfig = {}) => {
    const db = await openTestDb(path.join(tmpRoot, `${name}.db`), { legacyProjects: false });
    dbs.push(db);
    const app = createApp({
      db,
      storage: dbStorage(db),
      docText: '',
      config: { openJoin: '1', rateLimitPerMin: '100000', updateFetch: fakeFetch, ...extraConfig },
    });
    const call = async (token, p, method = 'GET', body) => {
      const r = await app(
        new Request('http://localhost' + p, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
        'http://localhost'
      );
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    return { db, call };
  };

  const [ma, mi, pa] = APP_VERSION.split('.').map(Number);
  const newer = `${ma}.${mi + 1}.${pa}`;
  const older = `${ma}.${mi}.${Math.max(0, pa - 1)}`;
  const rel = (tag, extra = {}) => ({
    body: {
      tag_name: tag,
      name: '新版說明',
      html_url: `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
      ...extra,
    },
  });

  const site = await makeSite('main');
  const admin = (await site.call(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
  const member = (await site.call(null, '/api/join', 'POST', { name: '一般成員', role: 'PG' })).body;
  const projId = (await site.db.get('SELECT id FROM projects LIMIT 1'))?.id;
  assert.ok(projId, '應能取得預設專案 id');
  const botRes = await site.call(admin.token, '/api/my-ais', 'POST', {
    projects: [projId],
    roleKey: 'PG',
    role: 'PG',
    name: '測試AI',
    duties: '寫程式',
    style: '務實',
    autonomy: '高',
    mustConfirm: '無',
    handoff: '完成後回報',
  });
  const botToken = botRes.body?.token;
  assert.ok(botToken, `應能建立測試 AI token: ${JSON.stringify(botRes.body)}`);

  const check = (tok) => site.call(tok, '/api/admin/update-check');
  const setCache = async (val) => {
    const raw = typeof val === 'string' ? val : JSON.stringify(val);
    await site.db.run(
      "INSERT INTO app_settings (key, value) VALUES ('update_check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      raw
    );
  };
  const ageCache = async (ms) => {
    const row = await site.db.get("SELECT value FROM app_settings WHERE key = 'update_check'");
    const parsed = JSON.parse(row.value);
    await setCache({ ...parsed, at: Date.now() - ms });
  };

  // 3a. 權限邊界：未登入(401)、非管理員人類(403)、AI token(403) 皆不可查詢且不觸發 fetch
  assert.equal((await check(null)).status, 401, '未登入應回 401');
  assert.equal((await check(member.token)).status, 403, '非管理員人類應回 403');
  assert.equal((await check(botToken)).status, 403, 'AI token 應被 requireHuman 擋下');
  assert.equal(calls, 0, '無權限請求絕不觸發 fetch');

  // 3b. 有新版本：name 截斷 120 字、html_url 僅允許 https://github.com/
  const longName = 'A'.repeat(150);
  nextReply = rel('v' + newer, { name: longName });
  let res = await check(admin.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.current, APP_VERSION);
  assert.ok(!Number.isNaN(Date.parse(res.body.checkedAt)), 'checkedAt 應為合法 ISO 時間');
  assert.equal(res.body.failed, undefined);
  assert.equal(res.body.newer?.version, newer);
  assert.equal(res.body.newer?.name.length, 120, 'release name 應截斷為 120 字');
  assert.equal(res.body.newer?.url, `https://github.com/${UPDATE_REPO}/releases/tag/v${newer}`);
  assert.equal(calls, 1);

  // 3c. 快取節流：距離上次檢查不到 24 小時（DAY_MS - 5000）不重查
  await ageCache(DAY_MS - 5000);
  const beforeThrottle = calls;
  res = await check(admin.token);
  assert.equal(calls, beforeThrottle, '24 小時內應使用快取，不重查');
  assert.equal(res.body.newer?.version, newer);

  // 3d. 超過 24 小時（DAY_MS + 1000）應重新查詢
  await ageCache(DAY_MS + 1000);
  nextReply = rel(newer, { name: null, html_url: 'http://github.com/alansid/aigile-oss/releases' });
  res = await check(admin.token);
  assert.equal(calls, beforeThrottle + 1, '滿 24 小時後應重查');
  assert.equal(res.body.newer?.name, '', '缺少 name 應回空字串');
  assert.equal(res.body.newer?.url, `https://github.com/${UPDATE_REPO}/releases`, '非 https://github.com/ 應退回 releases 首頁');

  // 3e. 惡意或無效 html_url 皆退回預設 releases 頁
  for (const badUrl of ['https://evil.example/x', 'javascript:alert(1)', '', undefined]) {
    await ageCache(DAY_MS + 1000);
    nextReply = rel('v' + newer, { html_url: badUrl });
    res = await check(admin.token);
    assert.equal(res.body.newer?.url, `https://github.com/${UPDATE_REPO}/releases`, `不合法 URL(${String(badUrl)}) 應退回預設頁`);
  }

  // 3f. 無可用更新（相同版本、較舊版本、draft、prerelease、不合法 tag_name）
  for (const [payload, desc] of [
    [rel('v' + APP_VERSION), '相同版本'],
    [rel(older), '較舊版本'],
    [rel('v' + newer, { draft: true }), 'draft 草稿'],
    [rel('v' + newer, { prerelease: true }), 'prerelease 預先發行'],
    [rel('vv' + newer), '雙 v 前綴'],
    [rel('V' + newer), '大寫 V 前綴'],
    [rel('nightly'), '非語意化版本'],
    [{ body: {} }, '缺少 tag_name'],
  ]) {
    await ageCache(DAY_MS + 1000);
    nextReply = payload;
    res = await check(admin.token);
    assert.equal(res.status, 200, `${desc} 不應報錯`);
    assert.equal(res.body.newer, undefined, `${desc} 不應顯示 newer`);
    assert.equal(res.body.failed, undefined, `${desc} 不是查詢失敗，不應標記 failed`);
  }

  // 3g. 錯誤回應與例外處理：HTTP 非 2xx、網路錯誤、無效 JSON、null body
  for (const [errPayload, desc] of [
    [{ status: 404, body: { message: 'Not Found' } }, 'HTTP 404'],
    [{ status: 403, body: { message: 'rate limit' } }, 'HTTP 403'],
    [{ status: 500, body: { message: 'server error' } }, 'HTTP 500'],
    [new Error('ECONNREFUSED'), '網路連線例外'],
    [Object.assign(new Error('Aborted'), { name: 'AbortError' }), 'AbortError'],
    [() => new Response('{bad json', { status: 200 }), '回傳壞掉的 JSON'],
    [() => new Response('null', { status: 200 }), '回傳 JSON null'],
  ]) {
    await ageCache(DAY_MS + 1000);
    nextReply = errPayload;
    const cBefore = calls;
    res = await check(admin.token);
    assert.equal(res.status, 200, `${desc} 對管理員仍應回 200`);
    assert.equal(res.body.newer, undefined, `${desc} 不應顯示 newer`);
    assert.equal(res.body.failed, true, `${desc} 應標記 failed: true`);
    assert.equal(calls, cBefore + 1);
    // 失敗結果一天內同樣節流不重查
    const cachedRes = await check(admin.token);
    assert.equal(calls, cBefore + 1, `${desc} 一天內不應重查`);
    assert.equal(cachedRes.body.failed, true);
  }

  // 3h. 資料庫快取損毀或時間戳無效時應安全降級重查
  await setCache('{not-valid-json');
  nextReply = rel('v' + newer);
  let beforeRecover = calls;
  res = await check(admin.token);
  assert.equal(calls, beforeRecover + 1, '快取 JSON 損毀應觸發重查');
  assert.equal(res.body.newer?.version, newer);

  await setCache({ at: 'invalid-ts', latest: null, failed: true });
  beforeRecover = calls;
  res = await check(admin.token);
  assert.equal(calls, beforeRecover + 1, '快取 at 非數字應觸發重查');
  assert.equal(res.body.newer?.version, newer);

  console.log('update-edge-test：全部通過');
} catch (e) {
  console.error('update-edge-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  globalThis.fetch = origFetch;
  for (const db of dbs) {
    try { await db.close(); } catch {}
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
