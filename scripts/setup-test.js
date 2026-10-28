// 接入設定補齊驗收測試：程式庫連結、長期授權、/api/me 的 grants／repos、接入設定（重新接上、watcher.pid、API 代號、章節編號）。
// 用法：node scripts/setup-test.js（加 --print 印出一份接入設定）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-setup-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AIGILE_TEST_PROJECTS: '1', TEAM_CACHE_MS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mkAi = async (tok, name, key, projects) => {
  const r = ROLES.find(x => x.key === key);
  return (await call(tok, '/api/my-ais', 'POST', { name, roleKey: key, role: r.role, projects, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
};
const ob = async (tok, id, aiTok) => (await call(tok, `/api/my-ais/${id}/onboarding`, aiTok ? 'POST' : 'GET', aiTok ? { token: aiTok } : undefined)).body.text;
const sections = t => [...t.matchAll(/^## ([零一二三四五六七八九十]+)、/gm)].map(m => m[1]);

(async () => {
  await ready;
  try {
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const mate = (await call(null, '/api/join', 'POST', { name: '陳建宏', role: 'BA' })).body;
    const kid = mate.participant.participantId;
    await call(boss.token, `/api/participants/${kid}/projects`, 'PUT', { projects: ['預設專案'] });
    await call(boss.token, '/api/projects/預設專案', 'PATCH', { name: '示範專案' });
    const pg = await mkAi(boss.token, 'AB12', 'PG', ['預設專案', '第二專案']);
    const other = await mkAi(boss.token, '第二PG', 'PG', ['第二專案']);
    const kai = await mkAi(mate.token, '陳建宏的BA', 'BA', ['預設專案']);

    // 1. 程式庫連結：管理員與該專案 leader 能改；含帳密或 token 的擋下
    const bad = ['https://user:pw@github.com/a/b', 'https://github.com/a/b?access_token=xyz', 'https://ghp_abcdef123456@github.com/a/b', 'git@github.com:a/b.git', 'ftp://x.com/a', 'https://github.com/a/b?token=1'];
    for (const url of bad) {
      const r = await call(boss.token, '/api/projects/預設專案/repo', 'PUT', { url, branch: 'main' });
      assert.equal(r.status, 400, '擋下 ' + url);
    }
    assert.equal((await call(boss.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/a/b', branch: 'main; rm -rf' })).status, 400, '分支有怪字元擋下');
    assert.equal((await call(mate.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/a/b' })).status, 403, '不是管理員也不是 leader');
    assert.equal((await call(pg.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/a/b' })).status, 403, 'AI 不能改');
    let r = await call(boss.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/example/project', branch: 'main' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.find(p => p.id === '預設專案').repo, { url: 'https://github.com/example/project', branch: 'main' });
    await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: kid, leaderOf: ['預設專案'] }] });
    r = await call(mate.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/example/project', branch: 'dev' });
    assert.equal(r.status, 200, 'leader 能改自己的專案：' + JSON.stringify(r.body));
    assert.equal((await call(mate.token, '/api/projects/第二專案/repo', 'PUT', { url: 'https://github.com/x/y' })).status, 403, 'leader 不能改別的專案');
    const ev = (await call(boss.token, '/api/projects/預設專案/events')).body.items;
    assert.ok(ev.some(e => /設定程式庫：https:\/\/github.com\/example\/project（分支 dev）/.test(e.text)), '寫進異動紀錄');
    await call(boss.token, '/api/projects/預設專案/repo', 'PUT', { url: 'https://github.com/example/project', branch: 'main' });

    // 2. 長期授權：只有所屬人類能改；每隻 AI 都能設
    let g = (await call(boss.token, `/api/my-ais/${pg.participantId}/grants`)).body;
    assert.equal(g.grantable, true); assert.deepEqual(g.items, []); assert.deepEqual(g.choices.map(c => c.key), ['deploy'], '使用者選 C：只有部署');
    assert.match(g.alwaysAsk, /git commit、push、merge、正式資料庫遷移/);
    assert.match(g.never, /刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡/);
    assert.equal((await call(mate.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'quarter' })).status, 404, '別人不能改');
    assert.equal((await call(pg.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'] })).status, 403, 'AI 自己不能改');
    for (const k of ['delete', 'migrate', 'commit', 'push']) assert.equal((await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: [k] })).status, 400, k + ' 不能勾');
    assert.equal((await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], other: 'push 免問' })).status, 400, '不開放自填其他');
    assert.equal((await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: [], until: 'forever' })).status, 400);
    r = await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'quarter' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tw = new Date(Date.now() + 8 * 3600_000), qEndMonth = Math.floor(tw.getUTCMonth() / 3) * 3 + 2;
    const expectEnd = new Date(Date.UTC(tw.getUTCFullYear(), qEndMonth + 1, 0)).toISOString().slice(0, 10);
    assert.equal(new Date(Date.parse(r.body.until) + 8 * 3600_000).toISOString().slice(0, 10), expectEnd, '本季底（台灣時間）');
    assert.equal(new Date(Date.parse(r.body.until) + 8 * 3600_000).toISOString().slice(11, 19), '23:59:59');
    // 10. 沒設長期授權的 AI：grants 是空的，但可以設
    assert.equal((await call(boss.token, `/api/my-ais/${other.participantId}/grants`)).body.grantable, true, '每隻 AI 都能設');

    // 3. /api/me 多 grants、repos；到期後變空
    let me = (await call(pg.token, '/api/me')).body;
    assert.deepEqual(me.grants.items.map(i => i.key), ['deploy']);
    assert.ok(!('other' in me.grants), '沒有其他欄');
    assert.deepEqual(me.repos, { 預設專案: { url: 'https://github.com/example/project', branch: 'main' } }, '只列有填的專案');
    assert.deepEqual((await call(other.token, '/api/me')).body.grants, { items: [], until: null }, '沒設的 grants 是空的');
    assert.ok(!('grants' in (await call(boss.token, '/api/me')).body), '人類沒有 grants');
    // 先拿這份給接入設定用，再測到期
    const obPg = await ob(boss.token, pg.participantId, pg.token); // 帶 AI 現在的 Token，接入設定不換新的
    const obOther = await ob(boss.token, other.participantId, other.token);
    const obKai = await ob(mate.token, kai.participantId, kai.token);
    // 補、待命細節（起）寫在規格 3.12，接入設定指過去
    const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
    assert.match(obPg, /雜湊不符[^\n]*照規格 3\.12/, '接入設定：雜湊不符照規格 3.12');
    assert.match(spec, /先停掉你自己用舊檔在跑的 watcher[^\n]*重新下載一次[^\n]*重下仍不符才停止並回報/, '規格：舊 watcher 先重下');
    assert.ok(!/不符就停止並告訴/.test(obPg + spec), '不再「一不符就停」');
    // opencode 改用 aigile-opencode.mjs（它數次數、接續或開新對話），不用自己寫 wake.cmd
    assert.match(spec, /WAKE_CMD=node \.aigile\/watcher\/aigile-opencode\.mjs --agent <代號> --mode/, 'opencode：WAKE_CMD 指向喚醒腳本');
    assert.match(spec, /opencode run -s <對話>/, 'opencode：接續用對話編號');
    assert.match(spec, /wake\.log/, 'opencode：輸出寫 wake.log');
    assert.match(spec, /工作排程器/, 'opencode：說明背景常駐');
    assert.ok(!/WAKE_CMD=opencode run --continue/.test(obPg + spec), '不再用 --continue');
    // 到期：直接把資料改成過去
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(path.join(dataDir, 'switch.db'));
    const key = 'grants:' + pg.participantId;
    const v = JSON.parse(sdb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key).value);
    sdb.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...v, until: new Date(Date.now() - 3600_000).toISOString() }), key);
    sdb.close();
    assert.deepEqual((await call(pg.token, '/api/me')).body.grants, { items: [], until: null }, '到期後自動變空');
    r = await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: '30d' });
    assert.ok(Math.abs(Date.parse(r.body.until) - Date.now() - 30 * 86_400_000) < 60_000, '30 天');
    r = await call(boss.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'none' });
    assert.equal(r.body.until, null, '不限');

    // 5～9. 接入設定
    if (process.argv.includes('--print')) console.log(obPg);
    const nums = sections(obPg);
    assert.deepEqual(nums, ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'], '9. 章節不跳號：' + nums.join(','));
    assert.ok(obPg.indexOf('## 零、你是重新接上，還是第一次？') < obPg.indexOf('## 一、'), '5. 最前面是「零、重新接上還是第一次」');
    assert.match(obPg, /不要重新簽到；游標沿用 state\.json 的 messagesCursor（換了電腦就用 GET \/api\/me\/state 的 messagesCursor、cardsSince）/, '零節寫從工作記憶讀回位置');
    assert.match(obPg, /messagesCursor（處理完的訊息游標）、cardsSince（卡片增量時間）/, '工作記憶段寫出新欄位');
    assert.match(obPg, /Token 跟 \.aigile\/PG_[A-Z0-9]{4}\/\.token 不同才換/);
    assert.match(obPg, /watcher\.pid 的程序還在(執行)?就不要再開/, '6. watcher.pid');
    assert.match(spec, /被強制結束時手動刪掉/);
    assert.match(obPg, /- 預設專案（示範專案）\n  - 程式庫：https:\/\/github\.com\/example\/project，分支 main\n  - 開工前先確認本機的 git remote 和分支跟這裡一致；不一致先問 林志明/, '7. API 代號、程式庫、分支');
    assert.match(obPg, /- 第二專案（第二專案）\n  - 沒有填程式庫：需要時問 林志明，不要自己猜。/, '7. 沒填寫問所屬人類');
    assert.match(obPg, /每則都帶 project（預設專案、第二專案，或 "all"/);
    assert.match(obPg, /林志明 已長期授權（到 \d{4}\/\d\d\/\d\d 為止，到期自動失效）：\n  - 部署到正式環境（自測全過才部署；不含資料庫遷移）\n- 最新授權/, '8. 列出長期授權與到期日');
    assert.match(obPg, /- git commit、push、merge、正式資料庫遷移，以及沒有長期授權（或已到期）的部署，一律先在本機對話取得 林志明 明確同意；每次 push 都要重新取得授權/);
    assert.match(obPg, /最新授權以 GET \/api\/me 的 grants 為準/);
    assert.match(obPg, /刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡：不能長期授權/);
    assert.match(obPg, /本設定第八節與群組規格/, '規則優先順序指到新編號');
    assert.ok(!/第二專案/.test(obKai), '9. 只列這個 AI 所在的專案');
    assert.match(obKai, /目前沒有長期授權/);
    // 10. 沒設長期授權的 AI：寫「目前沒有長期授權」，章節一樣不跳號
    assert.match(obOther, /目前沒有長期授權/);
    assert.deepEqual(sections(obOther), nums, '沒設授權的 AI 章節一樣不跳號');
    console.log('setup-test 全部通過');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
