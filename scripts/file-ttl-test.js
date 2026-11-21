// 訊息附件保存時間改成管理員可調（存 app_settings 的 file_ttl，不用重開、不改資料表）
// A. GET /api/file-ttl 誰都能讀（紀錄、來源只給管理員）；PUT 只有管理員，其他人類、AI 一律 403，沒登入 401
// B. 預設 24 小時；主機設了 FILE_TTL_HOURS 就用它當初始值；管理員改過就以資料庫為準（之後 FILE_TTL_HOURS 不再影響）
//    /api/me 的 fileTtlHours、/api/files 的 ttlHours 跟著設定
// C. 改了只影響之後上傳的檔：新檔 expires_at 照新設定，舊檔的到期時間不變；訊息內文照每個檔自己的保存時間寫
// D. 只收 1、6、24、72、168、720（小時），其他值 400；沒變不存、不記紀錄；紀錄最多 20 筆
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres（app_settings 的 upsert 兩邊都要能跑）
// 本機暫存資料庫，不連任何站。用法：node scripts/file-ttl-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const PJ = '預設專案';
const H = 3600_000;
const dirs = [], dbs = [];
async function mkApp(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-filettl-'));
  dirs.push(dataDir);
  const db = await openTestDb(path.join(dataDir, 'switch.db'));
  dbs.push(db);
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  const req = async (token, p, method = 'GET', body, raw = false) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json().catch(() => null) : null };
  };
  return { db, req };
}
const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);

try {
  const { db, req } = await mkApp();
  const up = (token, name, n, extra = {}) => req(token, `/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ, ...extra })}`, 'POST', png(n), true);
  const ttlOf = async id => { const f = await db.get('SELECT created_at, expires_at FROM files WHERE id = ?', id); return Number(f.expires_at) - Date.parse(f.created_at); };
  const near = (ms, hours, what) => assert.ok(Math.abs(ms - hours * H) < 60_000, `${what}：保存 ${(ms / H).toFixed(3)} 小時，應為 ${hours}`);

  const wang = (await req(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝管理員
  const chen = (await req(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  assert.equal((await req(wang.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] })).status, 200, '陳大文加進預設專案');
  const ai = (await req(wang.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '王小美的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);

  // ---------- A／B 預設 24 小時，誰都能讀 ----------
  let r = await req(chen.token, '/api/file-ttl');
  assert.equal(r.status, 200, 'A 一般成員能讀');
  assert.deepEqual([r.body.hours, r.body.defaultHours, r.body.choices], [24, 24, [1, 6, 24, 72, 168, 720]], 'B 預設 24 小時、六個選項：' + JSON.stringify(r.body));
  assert.equal(r.body.log, undefined, 'A 紀錄只給管理員');
  assert.equal(r.body.custom, undefined, 'A 來源只給管理員');
  assert.equal((await req(aiToken, '/api/file-ttl')).body.hours, 24, 'A AI 也能讀');
  r = await req(wang.token, '/api/file-ttl');
  assert.deepEqual([r.body.log, r.body.custom, r.body.envHours], [[], false, null], 'A 管理員看得到紀錄（空）、還沒改過、主機沒設 FILE_TTL_HOURS');
  assert.equal((await req(null, '/api/file-ttl')).status, 401, 'A 沒登入不能讀');
  assert.equal((await req(chen.token, '/api/me')).body.fileTtlHours, 24, 'B /api/me 帶 fileTtlHours');
  assert.equal((await req(aiToken, '/api/me')).body.fileTtlHours, 24, 'B AI 的 /api/me 也帶');
  assert.equal((await req(chen.token, '/api/files')).body.ttlHours, 24, 'B /api/files 帶 ttlHours');

  const old = await up(wang.token, '舊截圖.png', 1);
  assert.equal(old.status, 201, '舊檔上傳');
  near(await ttlOf(old.body.file.fileId), 24, 'B 預設 24 小時');
  assert.match(old.body.message.text, /已聲明不含程式碼與客戶個資；24 小時後自動刪除。/, 'B 內文寫 24 小時：' + old.body.message.text);
  const oldExp = Number((await db.get('SELECT expires_at FROM files WHERE id = ?', old.body.file.fileId)).expires_at);

  // ---------- A 只有管理員能改 ----------
  for (const [tok, who] of [[chen.token, '一般成員'], [aiToken, 'AI']]) {
    r = await req(tok, '/api/file-ttl', 'PUT', { hours: 6 });
    assert.equal(r.status, 403, `A ${who}不能改：${r.status}`);
    assert.equal(r.body.error.code, 'NOT_ADMIN', `A ${who} → NOT_ADMIN`);
  }
  assert.equal((await req(null, '/api/file-ttl', 'PUT', { hours: 6 })).status, 401, 'A 沒登入 401');

  // ---------- D 不合法的值 ----------
  for (const bad of [0, 2, -1, 1.5, '24', null, 721, 'abc', [24], true]) {
    r = await req(wang.token, '/api/file-ttl', 'PUT', { hours: bad });
    assert.equal(r.status, 400, `D hours=${JSON.stringify(bad)} 要 400：${r.status}`);
  }
  assert.equal((await req(wang.token, '/api/file-ttl', 'PUT', {})).status, 400, 'D 沒帶 hours 400');
  // 沒變：不存、不記（還沒改過，照舊跟著初始值）
  r = await req(wang.token, '/api/file-ttl', 'PUT', { hours: 24 });
  assert.deepEqual([r.status, r.body.hours, r.body.log.length, r.body.custom], [200, 24, 0, false], 'D 跟目前一樣：不記紀錄、不算改過');
  assert.equal(await db.get("SELECT value FROM app_settings WHERE key = 'file_ttl'"), null, 'D 沒變不寫資料庫');

  // ---------- C 改成 6 小時：新檔照新設定、舊檔不變 ----------
  r = await req(wang.token, '/api/file-ttl', 'PUT', { hours: 6 });
  assert.equal(r.status, 200, 'C 管理員改成 6 小時');
  assert.deepEqual([r.body.hours, r.body.custom, r.body.log.length], [6, true, 1], 'C 改過、留一筆紀錄');
  assert.deepEqual([r.body.log[0].by, r.body.log[0].byName, r.body.log[0].from, r.body.log[0].to], [wang.participant.participantId, '王小美', 24, 6], 'C 紀錄誰、從幾小時改成幾小時');
  assert.ok(!Number.isNaN(Date.parse(r.body.log[0].at)), 'C 紀錄時間');
  assert.equal((await req(chen.token, '/api/me')).body.fileTtlHours, 6, 'C /api/me 立刻跟上（不用重開）');
  assert.equal((await req(chen.token, '/api/files')).body.ttlHours, 6, 'C /api/files 跟上');
  const neu = await up(chen.token, '新截圖.png', 2);
  assert.equal(neu.status, 201);
  near(await ttlOf(neu.body.file.fileId), 6, 'C 新檔 6 小時');
  assert.match(neu.body.message.text, /；6 小時後自動刪除。/, 'C 新檔內文寫 6 小時');
  assert.equal(Number((await db.get('SELECT expires_at FROM files WHERE id = ?', old.body.file.fileId)).expires_at), oldExp, 'C 舊檔到期時間不變');
  const byId = Object.fromEntries((await req(chen.token, '/api/files')).body.items.map(f => [f.fileId, f]));
  assert.ok(Date.parse(byId[old.body.file.fileId].expiresAt) - Date.parse(byId[neu.body.file.fileId].expiresAt) > 17 * H, 'C 清單裡新舊兩檔各自的到期時間');

  r = await req(wang.token, '/api/file-ttl', 'PUT', { hours: 6 });
  assert.equal(r.body.log.length, 1, 'D 沒變不記紀錄');

  // 天數：3 天；多檔訊息內文
  r = await req(wang.token, '/api/file-ttl', 'PUT', { hours: 72 });
  assert.deepEqual([r.body.log.length, r.body.log[0].from, r.body.log[0].to], [2, 6, 72], 'C 最新的紀錄在最前面');
  const a = await up(wang.token, 'a.png', 3, { post: 'false' }), b = await up(wang.token, 'b.png', 4, { post: 'false' });
  near(await ttlOf(a.body.file.fileId), 72, 'C 3 天');
  r = await req(wang.token, '/api/messages', 'POST', { project: PJ, requestId: 'ttl_multi', text: '兩張', fileIds: [a.body.file.fileId, b.body.file.fileId] });
  assert.equal(r.status, 201, '多檔發文');
  assert.match(r.body.text, /\[文件\] 2 個檔案（已聲明不含程式碼與客戶個資；3 天後自動刪除）/, 'C 多檔內文寫 3 天：' + r.body.text);
  // 兩個檔保存時間不同：不寫單一時間
  const e = await up(wang.token, 'e.png', 7, { post: 'false' });
  await req(wang.token, '/api/file-ttl', 'PUT', { hours: 168 });
  const g = await up(wang.token, 'g.png', 8, { post: 'false' });
  near(await ttlOf(g.body.file.fileId), 168, 'C 7 天');
  r = await req(wang.token, '/api/messages', 'POST', { project: PJ, requestId: 'ttl_mix', text: '', fileIds: [e.body.file.fileId, g.body.file.fileId] });
  assert.match(r.body.text, /；依各檔上傳時的保存時間自動刪除）/, 'C 兩個檔保存時間不同：' + r.body.text);
  await req(wang.token, '/api/file-ttl', 'PUT', { hours: 720 });
  near(await ttlOf((await up(wang.token, 'h.png', 9, { post: 'false' })).body.file.fileId), 720, 'C 30 天');
  await req(wang.token, '/api/file-ttl', 'PUT', { hours: 1 });
  r = await up(wang.token, 'i.png', 10);
  near(await ttlOf(r.body.file.fileId), 1, 'C 1 小時');
  assert.match(r.body.message.text, /；1 小時後自動刪除。/, 'C 1 小時內文');

  // 紀錄最多 20 筆
  for (let i = 0; i < 24; i++) await req(wang.token, '/api/file-ttl', 'PUT', { hours: i % 2 ? 6 : 24 });
  r = await req(wang.token, '/api/file-ttl');
  assert.equal(r.body.log.length, 20, 'D 紀錄最多 20 筆');
  assert.equal(r.body.hours, 6);

  // ---------- B 主機設了 FILE_TTL_HOURS：當初始值；管理員改過以資料庫為準 ----------
  {
    const x = await mkApp({ fileTtlHours: '6' });
    const adm = (await x.req(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
    r = await x.req(adm.token, '/api/file-ttl');
    assert.deepEqual([r.body.hours, r.body.defaultHours, r.body.envHours, r.body.custom], [6, 6, 6, false], 'B FILE_TTL_HOURS=6 → 初始 6 小時');
    assert.equal((await x.req(adm.token, '/api/me')).body.fileTtlHours, 6);
    assert.equal((await x.req(adm.token, '/api/file-ttl', 'PUT', { hours: 24 })).body.hours, 24, 'B 管理員改成 24');
    assert.equal((await x.req(adm.token, '/api/me')).body.fileTtlHours, 24, 'B 改過以資料庫為準');
  }
  {
    // 同一個資料庫、主機換了 FILE_TTL_HOURS 重開：管理員改過的值照舊
    const db1 = dbs[dbs.length - 1];
    const app2 = createApp({ db: db1, storage: dbStorage(db1), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', fileTtlHours: '168' } });
    const adm = (await app2(new Request('http://localhost/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '陳小華', role: 'PG' }) }), 'http://localhost').then(x => x.json()));
    const t = await app2(new Request('http://localhost/api/file-ttl', { headers: { Authorization: `Bearer ${adm.token}` } }), 'http://localhost').then(x => x.json());
    assert.deepEqual([t.hours, t.defaultHours], [24, 168], 'B 重開換了 FILE_TTL_HOURS：管理員改過的 24 小時照舊');
  }
  {
    // 測試用的極短保存時間（不在選項裡）照舊可用；管理員下拉會多一個目前值
    const x = await mkApp({ fileTtlHours: String(1 / 60) });
    const adm = (await x.req(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
    r = await x.req(adm.token, '/api/file-ttl');
    assert.ok(Math.abs(r.body.hours - 1 / 60) < 1e-9, 'B 不在選項裡的初始值照用');
    const f = await x.req(adm.token, `/api/files?${new URLSearchParams({ name: 'x.png', declared: 'true', project: PJ })}`, 'POST', png(11), true);
    assert.match(f.body.message.text, /；1 分鐘後自動刪除。/, 'B 不到 1 小時寫分鐘');
  }

  console.log('file-ttl-test：全部通過（管理員才能改、只收 6 種值、預設 24 小時、FILE_TTL_HOURS 是初始值、新檔照新設定、舊檔不變、內文照各檔保存時間）');
} catch (err) {
  console.error('file-ttl-test 失敗：', err.message);
  process.exitCode = 1;
} finally {
  for (const d of dbs) { try { await d.close?.(); } catch {} }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
