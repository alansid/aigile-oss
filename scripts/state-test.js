// AI 工作記憶驗收測試：寫入驗證、16KB、非法欄位、相同內容不重寫、依專案可見。
// 用法：node scripts/state-test.js
import { stopChild } from './test-process.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-state-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AIGILE_TEST_PROJECTS: '1', TEAM_CACHE_MS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body, raw) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  await ready;
  try {
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'UX' })).body;
    const amy = (await call(null, '/api/join', 'POST', { name: 'Amy', role: 'PO' })).body;
    const bossId = boss.participant.participantId, percyId = amy.participant.participantId;
    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案', '第二專案'], roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const plat = await mk('預設PG'), bank = await mk('第二PG');
    await call(boss.token, `/api/participants/${plat.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
    await call(boss.token, `/api/participants/${bank.participantId}/projects`, 'PUT', { projects: ['第二專案'] });
    await call(boss.token, `/api/participants/${bossId}/projects`, 'PUT', { projects: ['預設專案'] }); // 只看平台
    await call(boss.token, `/api/participants/${amy.participant.participantId}/projects`, 'PUT', { projects: ['預設專案', '第二專案'] }); // amy 兩邊都屬於（之後加入的人類預設沒有專案，由管理員設定）

    const sha = '0123456789abcdef0123456789abcdef01234567';
    const good = { currentTask: { title: '做 MAIN-8', stage: '實作', sha, cardId: 'MAIN-8' }, backlog: [{ title: 'MAIN-7 批次', trigger: '使用者同意' }], wakeMode: 'watcher' };
    const put = (tok, body, raw) => call(tok, '/api/me/state', 'PUT', body, raw);

    // 權限與格式
    assert.equal((await put(boss.token, good)).status, 403, '人類不能寫');
    assert.equal((await call(boss.token, '/api/me/state')).status, 403, '人類沒有自己的工作記憶');
    assert.equal((await put(plat.token, null, '{壞掉')).status, 400, '非法 JSON');
    assert.equal((await put(plat.token, { currentTask: { title: 'a', sha: 'abc' } })).status, 400, 'sha 要完整 40 碼');
    assert.equal((await put(plat.token, { currentTask: { title: 'a', cardId: 'X1' } })).status, 400, 'cardId 格式');
    assert.equal((await put(plat.token, { wakeMode: 'x' })).status, 400, 'wakeMode 只能三種');
    assert.equal((await put(plat.token, { backlog: Array.from({ length: 21 }, (_, i) => ({ title: 't' + i })) })).status, 400, 'backlog 最多 20');

    // 格式錯附正確範例；超長截斷、不認得的欄位略過，都只回 warnings
    const strBacklog = await put(plat.token, { backlog: ['C-107 批次'] });
    assert.equal(strBacklog.status, 400, 'backlog 給字串仍擋');
    assert.match(strBacklog.body.error.message, /backlog\[0\] 需為物件[\s\S]*正確範例：\{"currentTask"/, '錯誤訊息附正確範例');
    assert.match((await put(plat.token, { currentTask: 'C-108' })).body.error.message, /正確範例/, 'currentTask 型別錯也附範例');
    const loose = await put(plat.token, { participantId: 'p_x', currentTask: { title: '長'.repeat(130), stage: '段'.repeat(60), status: '進行中' }, backlog: [{ title: 'b', trigger: '等'.repeat(120), cardId: 'MAIN-13', note: 1 }] });
    assert.equal(loose.status, 200, '超長與不認得的欄位不整個拒絕');
    assert.equal(loose.body.state.currentTask.title, '長'.repeat(100), 'title 截到 100 字');
    assert.equal(loose.body.state.currentTask.stage, '段'.repeat(60), 'stage 放寬到 100 字（60 字照存）');
    assert.equal(loose.body.state.currentTask.status, undefined, 'currentTask.status 略過');
    assert.equal(loose.body.state.participantId, undefined, 'state.participantId 略過');
    assert.deepEqual(loose.body.state.backlog, [{ title: 'b', trigger: '等'.repeat(100), cardId: 'MAIN-13' }], 'backlog 收 cardId、trigger 截斷、note 略過');
    const lw = loose.body.warnings.join('\n');
    for (const s of ['state 不認得欄位 participantId', 'currentTask 不認得欄位 status', 'currentTask.title 超過 100 字，已截斷', 'backlog[0].trigger 超過 100 字，已截斷', 'backlog[0] 不認得欄位 note'])
      assert.ok(lw.includes(s), `warnings 提到：${s}（實得 ${lw}）`);
    assert.ok(!lw.includes('currentTask.stage'), 'stage 沒超過 100 不警告');
    assert.match((await put(plat.token, { currentTask: { title: 'a', stage: '段'.repeat(101) } })).body.warnings[0], /currentTask\.stage 超過 100 字/, 'stage 超過 100 才截斷');
    assert.equal((await put(plat.token, { backlog: [{ title: 'b', cardId: 'X1' }] })).status, 400, 'backlog.cardId 格式錯擋');
    assert.equal((await put(plat.token, null, JSON.stringify({ currentTask: { title: 'a' }, pad: 'x'.repeat(17000) }))).status, 413, '超過 16KB 回 413');

    // 寫入、讀回、相同內容不重寫
    const w1 = (await put(plat.token, good)).body;
    assert.equal(w1.unchanged, false, '第一次寫入');
    const rd = (await call(plat.token, '/api/me/state')).body;
    assert.equal(rd.state.currentTask.title, '做 MAIN-8', 'AI 讀回自己的狀態');
    assert.equal(rd.state.backlog.length, 1);
    const w2 = (await put(plat.token, good)).body;
    assert.equal(w2.unchanged, true, '內容相同不重寫');
    assert.equal(w2.updatedAt, w1.updatedAt, '更新時間不變');
    const changed = (await put(plat.token, { ...good, currentTask: { ...good.currentTask, stage: '測試' } })).body;
    assert.equal(changed.unchanged, false, '內容改變才寫');

    // 沒有「只准標題與 SHA」的限制：路徑、SQL 都能寫（Token 照樣擋，見上面）
    assert.equal((await put(bank.token, { currentTask: { title: '改 C:\src\Foo.java' } })).status, 200, '可以寫路徑');
    assert.equal((await put(bank.token, { backlog: [{ title: 'SELECT * FROM users' }] })).status, 200, '可以寫 SQL');
    assert.equal((await put(bank.token, { currentTask: { title: '核對統編檢核', stage: '驗收', sha } })).status, 200, '寫標題與 SHA 可以');

    // 依專案可見
    assert.equal((await call(boss.token, `/api/participants/${plat.participantId}/state`)).body.state.currentTask.stage, '測試', '同專案看得到');
    assert.equal((await call(boss.token, `/api/participants/${bank.participantId}/state`)).status, 403, '不同專案看不到');
    assert.equal((await call(amy.token, `/api/participants/${bank.participantId}/state`)).status, 200, '兩邊成員看得到');
    assert.equal((await call(bank.token, `/api/participants/${plat.participantId}/state`)).status, 403, '第二專案 AI 看不到預設專案 AI');
    const tsLiu = (await call(boss.token, '/api/team-status')).body.members;
    assert.ok(tsLiu.find(m => m.participantId === plat.participantId).aiState, 'team-status 帶同專案 AI 的工作記憶');
    assert.ok(!tsLiu.some(m => m.participantId === bank.participantId), 'team-status 不列別專案的成員');
    const tsPercy = (await call(amy.token, '/api/team-status')).body.members;
    assert.ok(tsPercy.find(m => m.participantId === bank.participantId).aiState?.currentTask, '兩邊成員看得到全部');
    assert.equal(percyId.length > 0, true);

    // 工作記憶可存讀取位置（訊息游標、卡片增量時間），換電腦接得回；只收位置格式，不能塞 Token
    const cur = (await call(plat.token, '/api/messages?limit=1')).body.nextCursor;
    const pos = { ...good, messagesCursor: cur, cardsSince: '2026-10-17T12:30:00.000Z' };
    assert.equal((await put(plat.token, pos)).status, 200, '可以存位置');
    const back = (await call(plat.token, '/api/me/state')).body.state;
    assert.equal(back.messagesCursor, cur, '讀回訊息游標');
    assert.equal(back.cardsSince, '2026-10-17T12:30:00.000Z', '讀回卡片增量時間');
    assert.equal((await call(plat.token, `/api/messages?limit=5&after=${encodeURIComponent(back.messagesCursor)}`)).status, 200, '讀回的游標可以直接接著讀');
    assert.equal((await put(plat.token, { ...good, messagesCursor: 'Bearer abc' })).status, 400, '游標格式不對擋');
    assert.equal((await put(plat.token, { ...good, messagesCursor: 'cur_' + 'x'.repeat(70) })).status, 400, '游標太長擋');
    assert.equal((await put(plat.token, { ...good, cardsSince: '昨天' })).status, 400, '時間格式不對擋');
    const extra = (await put(plat.token, { ...good, token: plat.token })).body; // 多塞的欄位略過不存（原本是 400）
    assert.ok(extra.state && !('token' in extra.state) && !JSON.stringify(extra).includes(plat.token), '多塞的欄位不會存進去，回應也不回顯內容');
    assert.match(extra.warnings[0], /state 不認得欄位 token/, '多塞欄位有警告');
    const sneak = (await put(plat.token, { ...good, currentTask: { title: '記一下 ' + plat.token } })).body;
    assert.equal(sneak.error?.code, 'SECRET_LIKE', '文字裡像 Token 的長字串擋下');
    assert.equal((await put(plat.token, { ...good, currentTask: { title: '做 MAIN-8', sha } })).status, 200, '40 碼 SHA 照常可以');
    assert.ok((await call(boss.token, '/api/team-status')).body.members.find(m => m.participantId === plat.participantId).aiState, '團隊狀態照樣帶工作記憶');

    console.log('state: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await stopChild(server);
  }
})();
