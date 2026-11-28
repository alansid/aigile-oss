// 程式庫設定的讀取金鑰（唯讀 Token）
// 1. 只有管理員／專案負責人能設；加密存在 repokeys:<專案>，任何 API 回應、群組訊息、專案紀錄都不出現金鑰本身，只給 hasReadKey
// 2. 測試連線：剛填的金鑰優先、沒填用已存的；私有庫沒金鑰說「請填唯讀的讀取金鑰」；金鑰錯了說換金鑰
// 3. 送審抓差異帶金鑰（假 GitHub 確認收到 Authorization），私有庫也有「看程式變更」
// 4. 網址改了或清除時，舊金鑰一併丟掉；清除寫進專案紀錄
// 只用假金鑰與假 GitHub 回應，不打真的 GitHub、不連正式庫。用法：node scripts/repo-read-key-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { fetchReviewChanges, testGitHubRepo } from '../src/review-manifest.js';

const KEY = 'ghp_fakeReadKeyXAAAAAAAAAAAAAAAAAAAA', KEY2 = 'github_pat_fakeKeySecondKeyBBBBBBBB', WRONG = 'ghp_wrongKeyX';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', HEAD = '0123456789abcdef0123456789abcdef01234567';
const PRIV = 'https://github.com/example/private-repo', PUB = 'https://github.com/example/public-repo';
const seen = []; // 假 GitHub 收到的請求
async function gitFetch(url, opts = {}) {
  const u = new URL(url), auth = opts.headers?.Authorization || '';
  seen.push({ path: u.pathname, auth });
  assert.equal(u.hostname, 'api.github.com', '只打 api.github.com');
  assert.equal(opts.redirect, 'manual', '不跟隨轉址（manual，拿到 3xx 就停）');
  const priv = u.pathname.startsWith('/repos/example/private-repo');
  if (priv && auth && auth !== 'Bearer ' + KEY && auth !== 'Bearer ' + KEY2) return Response.json({ message: 'Bad credentials' }, { status: 401 });
  if (priv && !auth) return Response.json({ message: 'Not Found' }, { status: 404 }); // GitHub 對沒權限的私有庫回 404
  const name = priv ? 'example/private-repo' : 'example/public-repo';
  if (/\/commits\//.test(u.pathname)) return Response.json({ sha: SHA, parents: [{ sha: HEAD }], files: [{ filename: 'src/a.js', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] });
  if (/\/branches\//.test(u.pathname)) return Response.json({ commit: { sha: HEAD } });
  return Response.json({ full_name: name, default_branch: 'main', private: priv });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-repo-read-key-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', cloudAuto: '0', gitFetch } });
const req = (token, p, method = 'GET', body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost')
  .then(async r => { const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; });
const noKey = (r, what) => { for (const k of [KEY, KEY2, WRONG]) assert.ok(!r.text.includes(k) && !r.text.includes(k.slice(4, 20)), what + ' 不含金鑰'); };
const pj = encodeURIComponent('預設專案');
const id = x => x.participant?.participantId || x.participantId;

try {
  // 0. 單元：有金鑰才帶 Authorization；錯誤訊息不含金鑰
  seen.length = 0;
  await fetchReviewChanges({ url: PRIV }, SHA, { fetchImpl: gitFetch, token: KEY });
  assert.equal(seen[0].auth, 'Bearer ' + KEY, '抓差異帶金鑰');
  seen.length = 0;
  await fetchReviewChanges({ url: PUB }, SHA, { fetchImpl: gitFetch });
  assert.equal(seen[0].auth, '', '沒金鑰不帶 Authorization');
  await assert.rejects(fetchReviewChanges({ url: PRIV }, SHA, { fetchImpl: gitFetch }), /私有庫.*讀取金鑰/, '私有庫沒金鑰：提示填讀取金鑰');
  await assert.rejects(testGitHubRepo(PRIV, 'main', gitFetch), /私有庫.*唯讀的讀取金鑰/, '測試連線：私有庫沒金鑰');
  await assert.rejects(testGitHubRepo(PRIV, 'main', gitFetch, WRONG), e => /HTTP 401/.test(e.message) && /換一把/.test(e.message) && !e.message.includes(WRONG), '金鑰錯：說換金鑰、不印金鑰');
  const ok = await testGitHubRepo(PRIV, 'main', gitFetch, KEY);
  assert.deepEqual([ok.private, ok.usedKey, ok.sha], [true, true, HEAD], '帶金鑰讀得到私有庫');
  // 轉址：Workers 只收 follow／manual。用 manual，拿到 3xx 或 opaqueredirect 就停；不跟隨、金鑰不會被帶到別的網址
  for (const reply of [() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } }), () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() })]) {
    const calls = [];
    const hop = async (url, opts = {}) => { calls.push({ host: new URL(url).hostname, redirect: opts.redirect, auth: opts.headers?.Authorization || '' }); return reply(); };
    await assert.rejects(fetchReviewChanges({ url: PRIV }, SHA, { fetchImpl: hop, token: KEY }), e => /轉址/.test(e.message) && !e.message.includes(KEY), '抓差異遇到轉址就停');
    await assert.rejects(testGitHubRepo(PRIV, 'main', hop, KEY), e => /轉址/.test(e.message) && !e.message.includes(KEY), '測試連線遇到轉址就停');
    assert.equal(calls.length, 2, '各只發一次請求，不跟隨轉址');
    assert.ok(calls.every(c => c.host === 'api.github.com' && c.redirect === 'manual'), '只打 api.github.com、redirect 是 manual：' + JSON.stringify(calls.map(c => [c.host, c.redirect])));
  }

  const liu = (await req(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const hua = (await req(null, '/api/join', 'POST', { name: '小華', role: 'PG' })).body;
  await req(liu.token, `/api/participants/${id(hua)}/projects`, 'PUT', { projects: ['預設專案'] });

  // 1. 設定金鑰：只有管理員／負責人；回應只有 hasReadKey
  const items = [{ name: '私有', url: PRIV, branch: 'main', primary: true, readKey: KEY }, { name: '公開', url: PUB, branch: '', primary: false }];
  let r = await req(hua.token, `/api/projects/${pj}/repo`, 'PUT', { items });
  assert.equal(r.status, 403, '一般成員不能設定');
  noKey(r, '403 回應');
  assert.equal((await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ ...items[0], readKey: '有 空白' }] })).status, 400, '金鑰格式不對擋下');
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items });
  assert.equal(r.status, 200, '管理員設定：' + r.text.slice(0, 200));
  noKey(r, '儲存回應');
  const repos = () => req(hua.token, '/api/projects').then(x => { noKey(x, '專案清單'); return x.body.items.find(p => p.id === '預設專案').repositories; });
  assert.deepEqual((await repos()).map(x => [x.name, x.hasReadKey, 'readKey' in x]), [['私有', true, false], ['公開', false, false]], '清單只給有沒有設定');
  const rows = await db.all("SELECT key, value FROM app_settings WHERE key LIKE 'repo%'");
  assert.ok(rows.every(x => !x.value.includes(KEY) && !x.value.includes(KEY.slice(4, 20))), '資料庫存的是加密後的金鑰');
  assert.ok(rows.some(x => x.key === 'repokeys:預設專案' && /"v1:/.test(x.value)), '金鑰另存 repokeys:<專案>');
  const ev = await db.all('SELECT text FROM project_events WHERE project_id = ?', '預設專案');
  assert.ok(ev.some(e => /設定「私有」的讀取金鑰/.test(e.text)), '專案紀錄寫「設定讀取金鑰」');
  assert.ok(ev.every(e => !e.text.includes(KEY)), '專案紀錄不含金鑰');

  // 2. 測試連線：沒填就用已存的；剛填的優先；沒金鑰的私有庫說清楚
  seen.length = 0;
  r = await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: PRIV, branch: 'main' });
  assert.equal(r.status, 200, '用已存的金鑰測試連線：' + r.text.slice(0, 200));
  assert.deepEqual([r.body.private, r.body.usedKey], [true, true]);
  assert.ok(seen.every(x => x.auth === 'Bearer ' + KEY), '帶已存的金鑰');
  noKey(r, '測試連線回應');
  r = await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: PRIV, branch: 'main', readKey: WRONG });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /讀取金鑰無效/); noKey(r, '金鑰錯的回應');
  r = await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: 'https://github.com/example/private-repo-other', branch: 'main' });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /如果這是私有庫，請到程式庫設定填唯讀的讀取金鑰/, '沒金鑰的私有庫');

  // 3. 送審抓差異帶金鑰
  await req(liu.token, `/api/projects/${pj}/review-settings`, 'PUT', { cards: 'code', diffUpload: true });
  const mkAi = async (owner, name, tl) => {
    const a = (await req(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    await db.run('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tl);
    return a;
  };
  const pg = await mkAi(liu, '作者PG', 'claude'), cx = await mkAi(hua, '審查Codex', 'codex');
  const card = (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title: '私有庫的變更', ownerId: id(pg), requestId: 'c-read-key' })).body;
  seen.length = 0;
  r = await req(pg.token, `/api/cards/${card.cardId}/review-request`, 'POST', { version: SHA, note: '測試私有庫抓差異', repo: '私有', reviewerId: id(cx) });
  assert.equal(r.status < 300, true, '送審：' + r.text.slice(0, 300));
  noKey(r, '送審回應');
  assert.ok(seen.some(x => /\/commits\//.test(x.path) && x.auth === 'Bearer ' + KEY), '送審抓差異帶了金鑰：' + JSON.stringify(seen));
  const got = await req(liu.token, `/api/cards/${card.cardId}`);
  noKey(got, '卡片詳情');
  const reqEv = got.body.review?.history?.find(e => e.ev === 'request');
  assert.ok(reqEv?.summary?.files === 1 && !reqEv.fetchIssue, '私有庫也抓到變更（沒有 fetchIssue）：' + JSON.stringify(reqEv));
  const msgs = await db.all('SELECT text FROM messages');
  assert.ok(msgs.every(m => !m.text.includes(KEY)), '群組訊息不含金鑰');

  // 4. 換金鑰、清除、網址改了丟掉舊金鑰
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ ...items[0], readKey: KEY2 }, items[1]] });
  assert.equal(r.status, 200); noKey(r, '換金鑰回應');
  seen.length = 0;
  await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: PRIV, branch: 'main' });
  assert.ok(seen.every(x => x.auth === 'Bearer ' + KEY2), '換成新金鑰');
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ name: '私有', url: PRIV, branch: 'main', primary: true }, items[1]] });
  assert.equal((await repos())[0].hasReadKey, true, '沒填金鑰＝照舊');
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ name: '私有', url: PRIV, branch: 'main', primary: true, clearReadKey: true }, items[1]] });
  assert.equal((await repos())[0].hasReadKey, false, '清除金鑰');
  assert.ok((await db.all('SELECT text FROM project_events WHERE project_id = ?', '預設專案')).some(e => /清除「私有」的讀取金鑰/.test(e.text)), '清除寫進專案紀錄');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'repokeys:預設專案'")).n, 0, '沒有金鑰就不留空的設定');
  await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ ...items[0], readKey: KEY }, items[1]] });
  await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: [{ name: '私有', url: PRIV + '-moved', branch: 'main', primary: true }, items[1]] });
  assert.deepEqual((await repos()).map(x => x.hasReadKey), [false, false], '網址改了，舊金鑰不跟過去');

  // 4b. 同一個程式庫設兩列（不同分支）：金鑰只有一把，依網址合併；清除任一列就清掉，兩種順序都驗；互相衝突擋下
  const two = (a, b) => [{ name: '主線', url: PRIV, branch: 'main', primary: true, ...a }, { name: '發布', url: PRIV + '.git', branch: 'release', primary: false, ...b }];
  for (const order of ['first', 'second']) {
    r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: two({ readKey: KEY }, {}) });
    assert.equal(r.status, 200, '兩列同庫設金鑰：' + r.text.slice(0, 200));
    assert.deepEqual((await repos()).map(x => x.hasReadKey), [true, true], '同庫兩列都顯示已設定');
    r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: order === 'first' ? two({ clearReadKey: true }, {}) : two({}, { clearReadKey: true }) });
    assert.equal(r.status, 200, '清除（' + order + '）');
    assert.deepEqual((await repos()).map(x => x.hasReadKey), [false, false], '清除任一列，同庫兩列都沒有金鑰（' + order + '）');
    seen.length = 0;
    r = await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: PRIV, branch: 'release' });
    assert.equal(r.status, 400, '清除後連線讀不到私有庫（' + order + '）');
    assert.ok(seen.every(x => x.auth === ''), '清除後不帶舊憑證（' + order + '）');
  }
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: two({ readKey: KEY }, {}) });
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: two({ readKey: KEY2 }, { clearReadKey: true }) });
  assert.equal(r.status, 400, '同庫一列設定、一列清除：擋下'); noKey(r, '衝突回應');
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: two({ clearReadKey: true }, { readKey: KEY2 }) });
  assert.equal(r.status, 400, '順序反過來也擋');
  r = await req(liu.token, `/api/projects/${pj}/repo`, 'PUT', { items: two({ readKey: KEY }, { readKey: KEY2 }) });
  assert.equal(r.status, 400, '同庫兩列填不同金鑰：擋下'); noKey(r, '不同金鑰回應');
  seen.length = 0;
  await req(liu.token, `/api/projects/${pj}/repo/test`, 'POST', { url: PRIV, branch: 'main' });
  assert.ok(seen.every(x => x.auth === 'Bearer ' + KEY), '被擋下的請求不改原本的金鑰');

  // 5. 畫面：密碼欄、只寫不讀的說明、拿掉「不放 Token」那句
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /name="readKey" type="password" autocomplete="new-password"/, '讀取金鑰是密碼欄');
  assert.match(js, /私有庫請在「讀取金鑰」填唯讀 Token（只存不顯示，可換、可清）/, '說明改成讀取金鑰');
  assert.ok(!js.includes('只放連結，不放帳密或 Token。'), '拿掉「不放 Token」那句');
  console.log('repo-read-key-test：全部通過');
} catch (e) {
  console.error('repo-read-key-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('repo-read-key-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
