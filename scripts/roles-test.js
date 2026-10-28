// 每個專案各自的人類角色：上線帶入、新成員未設定、誰能改、?project=、成員與權限一起存、移出清掉、邀請、隔離。
// 用法：node scripts/roles-test.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3991;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-roles-'));
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

(async () => {
  await ready;
  try {
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'Sponsor' })).body; // 第一位＝管理員、所有專案
    const amy = (await call(null, '/api/join', 'POST', { name: 'Amy', role: 'PO' })).body;
    const mate = (await call(null, '/api/join', 'POST', { name: '陳建宏', role: 'BA' })).body;
    const id = x => x.participant.participantId;
    const M = (tok, changes, dryRun) => call(tok, '/api/members/matrix', 'PUT', { changes, dryRun });
    // 準備「上線前」的狀態：用單人設定（不會先觸發角色帶入），模擬已經在專案裡的人
    for (const p of [amy, mate]) await call(boss.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案', '第二專案'] });
    const people = async (tok = boss.token, q = '') => new Map((await call(tok, '/api/participants' + q)).body.items.map(p => [p.participantId, p]));

    // ⑥ 上線時把現有人類的角色帶到他所在的每個專案
    let P = await people();
    // 管理員不帶（他在每個專案）；其他人照舊帶到每個專案
    assert.deepEqual(P.get(id(boss)).projectRoles, { 預設專案: '', 第二專案: '' }, '管理員不自動帶角色');
    assert.deepEqual(P.get(id(amy)).projectRoles, { 預設專案: 'PO', 第二專案: 'PO' }, '現有角色帶到每個專案');
    assert.deepEqual(P.get(id(mate)).projectRoles, { 預設專案: 'BA', 第二專案: 'BA' });
    assert.deepEqual((await call(mate.token, '/api/me')).body.projectRoles, { 預設專案: 'BA', 第二專案: 'BA' }, '/api/me 也帶自己的');
    assert.deepEqual((await call(boss.token, '/api/me')).body.projectRoles, { 預設專案: '', 第二專案: '' }, '管理員的 /api/me 也是未設定');

    // ⑤ 之後新加入的：未設定
    const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
    await M(boss.token, [{ id: id(wang), projects: ['預設專案'] }]);
    P = await people();
    assert.deepEqual(P.get(id(wang)).projectRoles, { 預設專案: '' }, '新加入專案的人類預設未設定');

    // ④ 本人只改自己
    const R = (tok, who, roles) => call(tok, `/api/participants/${who}/project-roles`, 'PUT', { roles });
    assert.equal((await R(wang.token, id(wang), { 預設專案: 'PG' })).body.projectRoles['預設專案'], 'PG', '本人改自己');
    assert.equal((await R(wang.token, id(mate), { 預設專案: 'PG' })).status, 403, '不能改別人');
    assert.equal((await R(wang.token, id(wang), { 第二專案: 'PG' })).status, 400, '不在的專案不能設');
    // ④ leader 只改自己專案
    await M(boss.token, [{ id: id(amy), leaderOf: ['預設專案'] }]);
    assert.equal((await R(amy.token, id(mate), { 預設專案: 'QA' })).status, 200, '平台 leader 改平台的角色');
    assert.equal((await R(amy.token, id(mate), { 第二專案: 'QA' })).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能改別的專案');
    // ④ 管理員全部；「其他」最多 10 字
    assert.equal((await R(boss.token, id(mate), { 第二專案: '資料治理' })).body.projectRoles.第二專案, '資料治理', '管理員可改、可自填');
    assert.equal((await R(boss.token, id(mate), { 第二專案: '一二三四五六七八九十十一' })).status, 400, '自填超過 10 字擋下');
    assert.equal((await R(boss.token, id(mate), { 第二專案: '' })).body.projectRoles.第二專案, '', '可以清成未設定');
    await R(boss.token, id(mate), { 第二專案: '資料治理' });

    // ⑩ ?project= 時 role 給該專案的角色；沒帶給原本的值（AI 不用改）
    assert.equal((await people(boss.token, '?project=預設專案')).get(id(mate)).role, 'QA');
    assert.equal((await people(boss.token, '?project=第二專案')).get(id(mate)).role, '資料治理');
    assert.equal((await people()).get(id(mate)).role, 'BA', '沒帶專案照舊');
    const ts = (await call(boss.token, '/api/team-status?project=預設專案')).body.members.find(m => m.participantId === id(mate));
    assert.equal(ts.role, 'QA', 'team-status 帶專案也給該專案的角色');
    assert.deepEqual(ts.projectRoles, { 預設專案: 'QA', 第二專案: '資料治理' }, 'team-status 也有 projectRoles');

    // ① 成員與權限：角色跟加入／移出一起存（先預覽再存）
    const dry = (await M(boss.token, [{ id: id(wang), projectRoles: { 預設專案: 'UX' } }], true)).body;
    assert.deepEqual(dry.roleChanges.map(c => [c.name, c.project, c.role]), [['王小明', '預設專案', 'UX']], '預覽列出角色變更');
    assert.equal((await people()).get(id(wang)).projectRoles['預設專案'], 'PG', '預覽不寫入');
    await M(boss.token, [{ id: id(wang), projects: ['預設專案', '第二專案'], projectRoles: { 預設專案: 'UX', 第二專案: 'BU' } }]);
    assert.deepEqual((await people()).get(id(wang)).projectRoles, { 預設專案: 'UX', 第二專案: 'BU' }, '加入專案同時設角色');
    assert.equal((await M(amy.token, [{ id: id(wang), projectRoles: { 第二專案: 'PO' } }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能在成員與權限改別的專案角色');
    assert.equal((await M(amy.token, [{ id: id(wang), projectRoles: { 預設專案: 'QA' } }])).status, 200, 'leader 改自己專案的角色');
    // 移出專案，那個專案的角色一起清掉；再加入＝未設定
    await M(boss.token, [{ id: id(wang), projects: ['預設專案'] }]);
    assert.deepEqual((await people()).get(id(wang)).projectRoles, { 預設專案: 'QA' }, '移出第二專案');
    await M(boss.token, [{ id: id(wang), projects: ['預設專案', '第二專案'] }]);
    assert.deepEqual((await people()).get(id(wang)).projectRoles, { 預設專案: 'QA', 第二專案: '' }, '再加入＝未設定');

    // ⑧ AI 角色不分專案
    const r = ROLES.find(x => x.key === 'PG');
    const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r.role, name: '小幫手', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    assert.equal((await R(boss.token, ai.participantId, { 預設專案: 'PO' })).status, 404, 'AI 不能設專案角色');
    assert.equal((await M(boss.token, [{ id: ai.participantId, projectRoles: { 預設專案: 'PO' } }])).status, 400);
    assert.equal((await people()).get(ai.participantId).projectRoles, undefined, 'AI 沒有 projectRoles');
    assert.equal((await R(ai.token, id(wang), { 預設專案: 'PO' })).status, 403, 'AI 不能改人類的角色');

    // ⑨ 邀請：勾的每個專案各一個角色，加入時帶進去
    const inv = (await call(boss.token, '/api/invites', 'POST', { name: '陳小美', projects: ['預設專案', '第二專案'], roles: { 預設專案: 'BU', 第二專案: 'QA' } })).body;
    assert.equal(inv.invite.role, '預設專案 BU、第二專案 QA', '邀請清單顯示每個專案的角色');
    assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '某某', projects: ['預設專案'], roles: { 第二專案: 'QA' } })).status, 400, '沒勾的專案不能設角色');
    const tok = inv.url.split('/invite/')[1];
    assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tok })).body.role, '預設專案 BU、第二專案 QA', '被邀請頁看到好讀的角色');
    const mei = (await call(null, '/api/auth/invite', 'POST', { token: tok, name: '陳小美' })).body;
    const meiP = [...(await people()).values()].find(p => p.name === '陳小美');
    assert.deepEqual(meiP.projectRoles, { 預設專案: 'BU', 第二專案: 'QA' }, '加入時帶進每個專案的角色');
    assert.ok(mei.token || mei.deviceToken || mei.participant, '邀請加入成功');

    // 隔離：只屬平台的人看別人的 projectRoles 只看到平台
    const solo = (await call(null, '/api/join', 'POST', { name: '小平', role: 'UX' })).body;
    await M(boss.token, [{ id: id(solo), projects: ['預設專案'] }]);
    const seen = (await people(solo.token)).get(id(mate));
    assert.deepEqual(seen.projectRoles, { 預設專案: 'QA' }, '不露出別專案的角色');
    const seenTs = (await call(solo.token, '/api/team-status')).body.members.find(m => m.participantId === id(mate));
    assert.deepEqual(seenTs.projectRoles, { 預設專案: 'QA' }, 'team-status 也一樣');

    // 只在平台的人（含 AI）看 team-status、訊息作者，看不到別的專案名稱或代號；管理員看得到全部
    await call(boss.token, '/api/projects', 'POST', { name: '試用' });
    const others = ['第二專案', ...(await call(boss.token, '/api/projects')).body.items.map(p => p.id).filter(x => !['預設專案', '第二專案'].includes(x))];
    const leak = obj => others.filter(x => JSON.stringify(obj).includes(`"${x}"`));
    const tsSolo = (await call(solo.token, '/api/team-status')).body;
    assert.deepEqual(tsSolo.members.find(m => m.participantId === id(boss)).projects, ['預設專案'], 'team-status 別人的 projects 只列看的人也在的專案');
    assert.deepEqual(leak(tsSolo.members), [], 'team-status 不露出其他專案名稱或代號');
    const tsAi = (await call(ai.token, '/api/team-status')).body;
    assert.deepEqual(leak(tsAi.members), [], '只在平台的 AI 也看不到');
    await call(mate.token, '/api/messages', 'POST', { requestId: 'k-t1', project: '預設專案', text: '平台的訊息' });
    const msgs = (await call(solo.token, '/api/messages?limit=20')).body.items;
    assert.deepEqual(msgs.find(m => m.text === '平台的訊息').author.projects, ['預設專案'], '訊息作者的 projects 也只列看的人也在的');
    assert.deepEqual(leak(msgs.map(m => m.author)), [], '訊息不露出其他專案');
    assert.deepEqual((await call(solo.token, '/api/me')).body.projects, ['預設專案'], '自己的照舊');
    assert.ok((await call(boss.token, '/api/team-status')).body.members.find(m => m.participantId === id(mate)).projects.includes('第二專案'), '管理員看得到全部');

    // 只在試用的人看團隊狀態：的目前工作、張數、待處理則數只算試用，看不到平台／第二專案的卡名
    const tryId = others.find(x => x !== '第二專案');
    await M(boss.token, [{ id: id(solo), projects: [tryId] }]);
    await call(boss.token, '/api/cards', 'POST', { requestId: 't1a', project: '預設專案', title: '成員與權限整頁改版', ownerId: id(boss), status: '進行中' });
    await call(boss.token, '/api/cards', 'POST', { requestId: 't1b', project: '第二專案', title: '第二專案的秘密卡', ownerId: id(boss), status: '待處理' });
    await call(mate.token, '/api/messages', 'POST', { requestId: 't1m', project: '第二專案', text: '[進度] 第二專案那邊的進度', recipientIds: [id(boss)] });
    const bossAll = (await call(boss.token, '/api/team-status')).body.members.find(m => m.participantId === id(boss));
    assert.equal(bossAll.status?.source, 'card', '管理員看自己照舊是卡片');
    assert.ok(bossAll.status.cardCount >= 2 && bossAll.pendingCount >= 1, '管理員看全部的張數與待處理 ' + JSON.stringify({ c: bossAll.status.cardCount, p: bossAll.pendingCount, kp: (await people()).get(id(mate)).projects }));
    const bossTry = (await call(solo.token, '/api/team-status')).body.members.find(m => m.participantId === id(boss));
    assert.ok(bossTry, '試用的人看得到管理員');
    assert.ok(!/成員與權限整頁改版|第二專案的秘密卡|第二專案那邊的進度/.test(JSON.stringify(bossTry)), '看不到平台／第二專案的卡名與訊息');
    assert.ok(!bossTry.status || bossTry.status.source !== 'card', '試用沒有他的卡，就沒有卡片的目前工作與張數');
    assert.ok(bossTry.pendingCount < bossAll.pendingCount, '待處理則數只算看得到的專案');
    const tryCard = (await call(boss.token, '/api/cards', 'POST', { requestId: 't1c', project: tryId, title: '試用的卡', ownerId: id(boss), status: '待處理' })).body;
    const bossTry2 = (await call(solo.token, '/api/team-status')).body.members.find(m => m.participantId === id(boss));
    assert.equal(bossTry2.status?.cardId, tryCard.cardId, '試用的卡照常顯示');
    assert.equal(bossTry2.status.cardCount, 1, '張數只算試用');

    // 新專案一開始的成員＝建立者＋「目前的」跨專案角色（關掉之後就不會自動加入）
    const po = (await call(null, '/api/join', 'POST', { name: '產品負責人', role: 'PO' })).body; // 新成員角色是 PO 也不自動跨專案
    await call(boss.token, `/api/participants/${id(po)}/projects`, 'PUT', { projects: ['預設專案', '第二專案'] });
    assert.ok(!(await call(boss.token, '/api/projects')).body.crossRoleIds.includes(id(po)), '新成員角色是 PO 也不自動跨專案');
    await M(boss.token, [{ id: id(po), crossRole: true }]); // 管理員手動開
    const pA = (await call(boss.token, '/api/projects', 'POST', { name: '新專案甲' })).body.id;
    assert.ok((await people()).get(id(po)).projects.includes(pA), '跨專案角色自動加入新專案');
    await M(boss.token, [{ id: id(po), crossRole: false, projects: ['預設專案'] }]);
    const pB = (await call(boss.token, '/api/projects', 'POST', { name: '新專案乙' })).body.id;
    const inB = [...(await people()).values()].filter(p => (p.projects || []).includes(pB)).map(p => p.name);
    const everyone = await people();
    const crossNow = (await call(boss.token, '/api/projects')).body.crossRoleIds.map(x => everyone.get(x)?.name);
    assert.ok(!inB.includes('產品負責人'), '關掉跨專案角色後，新專案不再自動加入他');
    assert.deepEqual(inB.sort(), ['林志明', ...crossNow.filter(n => n && n !== '林志明')].sort(), '新專案＝建立者＋目前的跨專案角色');

    console.log('roles: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
