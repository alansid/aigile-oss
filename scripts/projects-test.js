// 專案欄位（平台／第二專案）驗收測試：成員專案設定、訊息預設與繼承、過濾與游標、卡片必填專案、交接限同專案。
// 用法：node scripts/projects-test.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-proj-'));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AIGILE_TEST_PROJECTS: '1', TEAM_CACHE_MS: '0', RATE_LIMIT_PER_MIN: '100000' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const rid = () => 'req_p' + (++n);
const msg = (tok, text, extra = {}) => call(tok, '/api/messages', 'POST', { requestId: rid(), text, ...extra });

(async () => {
  await ready;
  try {
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'UX' })).body;
    const amy = (await call(null, '/api/join', 'POST', { name: 'Amy', role: 'PO' })).body;
    const bossId = boss.participant.participantId, percyId = amy.participant.participantId;
    assert.deepEqual(boss.participant.projects, ['預設專案', '第二專案'], '群組第一位（建立者）預設所有專案');
    assert.deepEqual(amy.participant.projects, [], '之後加入的人類預設沒有專案');
    await call(boss.token, `/api/participants/${percyId}/projects`, 'PUT', { projects: ['預設專案', '第二專案'] }); // 管理員（最早加入的）加入 Amy

    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案', '第二專案'], roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const plat = await mk('平台PG'), bank = await mk('第二專案PG'), both = await mk('兩邊PO');
    assert.deepEqual(plat.participantId && (await call(boss.token, '/api/participants')).body.items.find(p => p.participantId === plat.participantId).projects, ['預設專案', '第二專案'], '新增 AI 時選的專案（這裡選兩邊）');

    // 設定成員專案：只有群組管理員；至少一個；只能是現有專案
    const put = (tok, id, projects) => call(tok, `/api/participants/${id}/projects`, 'PUT', { projects });
    assert.equal((await put(boss.token, plat.participantId, ['預設專案'])).body.projects[0], '預設專案', '管理員可改 AI 的專案');
    assert.equal((await put(boss.token, bank.participantId, ['第二專案'])).status, 200);
    assert.deepEqual((await put(boss.token, both.participantId, ['預設專案'])).body.projects, ['預設專案'], '回應裡的專案是更新後的值');
    await put(boss.token, both.participantId, ['預設專案', '第二專案']); // 還原，後面的測試要用兩邊
    assert.equal((await put(amy.token, plat.participantId, ['預設專案'])).status, 403, '別人不能改');
    assert.equal((await put(plat.token, plat.participantId, ['第二專案'])).status, 403, 'AI 不能改自己');
    assert.equal((await put(boss.token, plat.participantId, [])).status, 400, '至少選一個');
    assert.equal((await put(boss.token, plat.participantId, ['別的'])).status, 400, '只能是平台或第二專案');
    assert.equal((await put(amy.token, percyId, ['預設專案', '第二專案'])).body.error?.code, 'NOT_ADMIN', '一般成員不能自己改（只能看）');
    assert.equal((await put(boss.token, percyId, ['預設專案', '第二專案'])).status, 200, '管理員可改別人');

    // 訊息：預設專案與繼承
    const m1 = (await msg(plat.token, '[進度] 平台訊息')).body;
    assert.equal(m1.project, '預設專案', '單一專案成員預設自己的專案');
    const m2 = (await msg(bank.token, '[進度] 第二專案訊息')).body;
    assert.equal(m2.project, '第二專案');
    assert.equal((await msg(boss.token, '[通知] 兩邊成員沒帶專案')).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員不帶專案擋下');
    const m3 = (await msg(boss.token, '[通知] 兩邊成員明確發全部專案', { project: 'all' })).body;
    assert.equal(m3.project, null, '要發全部專案必須明確帶 all');
    assert.equal((await msg(boss.token, '[回覆] 回覆平台那則', { replyToMessageId: m1.messageId })).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員回覆也要帶專案');
    const m4 = (await msg(boss.token, '[回覆] 回覆平台那則', { replyToMessageId: m1.messageId, project: '預設專案' })).body;
    assert.equal(m4.project, '預設專案');
    const m5 = (await msg(boss.token, '[回覆] 明確指定第二專案', { project: '第二專案' })).body;
    assert.equal(m5.project, '第二專案');
    const m6 = (await msg(plat.token, '[通知] 平台成員發全部專案', { project: 'all' })).body;
    assert.equal(m6.project, null, 'all＝全部專案');
    assert.equal((await msg(plat.token, '[進度] 越界', { project: '第二專案' })).body.error.code, 'PROJECT_FORBIDDEN', '不能發不屬於的專案');
    assert.equal((await msg(plat.token, '[進度] 亂填', { project: 'x' })).status, 400);

    // 過濾：含「全部專案」；mine；沒帶參數維持現狀；游標推進到最新
    const ids = res => res.body.items.map(m => m.messageId);
    const pAll = await call(boss.token, '/api/messages?limit=100');
    assert.ok(ids(pAll).includes(m1.messageId) && ids(pAll).includes(m2.messageId), '沒帶 project 不過濾');
    const pf = await call(boss.token, '/api/messages?limit=100&project=預設專案');
    assert.ok(ids(pf).includes(m1.messageId) && ids(pf).includes(m3.messageId) && ids(pf).includes(m4.messageId), '平台過濾含平台與全部專案');
    assert.ok(!ids(pf).includes(m2.messageId) && !ids(pf).includes(m5.messageId), '平台過濾不含第二專案');
    const mine = await call(plat.token, '/api/messages?limit=100&project=mine');
    assert.ok(!ids(mine).includes(m2.messageId) && ids(mine).includes(m1.messageId), 'mine 依我的專案');
    const mineBoth = await call(boss.token, '/api/messages?limit=100&project=mine');
    assert.ok(ids(mineBoth).includes(m2.messageId), '兩邊成員 mine 不過濾');
    assert.equal((await call(boss.token, '/api/messages?project=xx')).status, 400);
    const first = await call(plat.token, '/api/messages?limit=2&after=' + encodeURIComponent((await call(plat.token, '/api/messages?limit=1')).body.nextCursor) + '&project=第二專案');
    assert.equal(first.body.items.length, 0, '游標在最新之後，沒有新訊息');
    const before = (await call(plat.token, '/api/messages?limit=100')).body.nextCursor;
    await msg(bank.token, '[進度] 第二專案又一則');
    const empty = await call(plat.token, `/api/messages?after=${encodeURIComponent(before)}&project=mine`);
    assert.equal(empty.body.items.length, 0, '平台成員看不到第二專案訊息');
    assert.notEqual(empty.body.nextCursor, before, '過濾後游標仍推進到最新，不重掃不相關訊息');

    // 卡片：必填專案；單一專案成員自動帶；越界；過濾；改專案
    assert.equal((await call(boss.token, '/api/cards', 'POST', { requestId: rid(), title: '兩邊成員沒填專案' })).status, 400, '兩邊成員建卡必填專案');
    const c1 = (await call(boss.token, '/api/cards', 'POST', { requestId: rid(), title: '平台卡', project: '預設專案', ownerId: plat.participantId })).body;
    assert.equal(c1.project, '預設專案');
    const c2 = (await call(bank.token, '/api/cards', 'POST', { requestId: rid(), title: '第二專案卡' })).body;
    assert.equal(c2.project, '第二專案', '單一專案成員自動帶自己的專案');
    assert.equal((await call(plat.token, '/api/cards', 'POST', { requestId: rid(), title: '越界', project: '第二專案' })).body.error.code, 'PROJECT_FORBIDDEN');
    const lf = (await call(boss.token, '/api/cards?project=預設專案')).body.items.map(c => c.cardId);
    assert.ok(lf.includes(c1.cardId) && !lf.includes(c2.cardId), '卡片依專案過濾');
    assert.equal((await call(boss.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '第二專案' })).body.error?.code, 'PROJECT_MISMATCH', '負責人不屬於新專案時擋下');
    assert.equal((await call(boss.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '第二專案', ownerId: null })).body.project, '第二專案', '人類可改卡片專案（同時改負責人）');
    await call(boss.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '預設專案', ownerId: plat.participantId });

    // 交接：只能交給同專案成員或兩邊成員
    const H = (tok, id, toId) => call(tok, `/api/cards/${id}/handover`, 'POST', { toId, note: '交接測試' });
    assert.equal((await H(plat.token, c1.cardId, bank.participantId)).body.error.code, 'PROJECT_MISMATCH', '不能交給不同專案的成員');
    const ho = (await H(plat.token, c1.cardId, percyId)).body;
    assert.equal(ho.owner.participantId, percyId, '可交給兩邊成員');
    assert.equal((await call(boss.token, `/api/messages/${ho.handoverMessageId}`)).body.project, '預設專案', '交接訊息帶卡片的專案');
    assert.ok(both.participantId);


    // ===== ：專案管理 =====
    const pl = (await call(boss.token, '/api/projects')).body.items;
    assert.deepEqual(pl.map(p => p.id), ['預設專案', '第二專案'], '預設兩個專案，id 沿用名稱');
    assert.equal((await call(bank.token, '/api/projects', 'POST', { name: 'AI 不能建' })).status, 403, 'AI 不能新增專案');
    assert.equal((await call(boss.token, '/api/projects', 'POST', { name: '預設專案' })).body.error.code, 'NAME_TAKEN', '同名擋下');
    assert.equal((await call(boss.token, '/api/projects', 'POST', { name: '' })).status, 400, '名稱不能空');
    const mkp = await call(boss.token, '/api/projects', 'POST', { name: '新專案甲' });
    assert.equal(mkp.status, 201); const newId = mkp.body.id;
    const withNew = (await call(boss.token, '/api/participants')).body.items;
    assert.ok(withNew.find(p => p.participantId === bossId).projects.includes(newId), '建立者在新專案');
    assert.ok(!withNew.find(p => p.participantId === plat.participantId).projects.includes(newId), '一般成員不會自動加入新專案');
    // 新專案可用：設成員專案、發卡片
    assert.equal((await put(boss.token, plat.participantId, ['預設專案', newId])).status, 200, '可把成員加入新專案');
    const nc = (await call(boss.token, '/api/cards', 'POST', { requestId: 'req_np1', title: '新專案的卡', project: newId })).body;
    assert.equal(nc.project, newId, '新專案可以建卡');
    // 屬於部分專案（兩個以上）的成員用 project=mine 查詢，要回自己各專案的內容（原本少綁參數會出錯）
    const pm = await call(plat.token, '/api/messages?limit=100&project=mine');
    assert.equal(pm.status, 200, '兩個專案的成員 project=mine 查訊息不出錯');
    const pc = await call(plat.token, '/api/cards?project=mine');
    assert.equal(pc.status, 200, 'project=mine 查卡片不出錯');
    assert.ok(pc.body.items.some(c => c.cardId === nc.cardId), '查得到自己另一個專案的卡');
    // 改名：只改 name，id 不變，卡片仍屬於它
    assert.equal((await call(boss.token, `/api/projects/${newId}`, 'PATCH', { name: '新專案乙' })).status, 200);
    assert.equal((await call(boss.token, '/api/projects')).body.items.find(p => p.id === newId).name, '新專案乙');
    assert.equal((await call(boss.token, `/api/cards/${nc.cardId}`)).body.project, newId, '改名後卡片仍屬同一專案');
    // 封存：有未結案卡擋下；結案後可封存；封存後不能再選、可還原
    assert.equal((await call(boss.token, `/api/projects/${newId}/archive`, 'POST')).body.error.code, 'HAS_OPEN_CARDS', '有未結案卡不能封存');
    await call(boss.token, `/api/cards/${nc.cardId}`, 'PATCH', { status: '已完成' });
    assert.equal((await call(boss.token, `/api/projects/${newId}/archive`, 'POST')).status, 200, '卡片結案後可封存');
    assert.equal((await call(boss.token, '/api/cards', 'POST', { requestId: 'req_np2', title: '封存後建卡', project: newId })).status, 400, '封存的專案不能再建卡');
    assert.equal((await call(boss.token, `/api/projects/${newId}/unarchive`, 'POST')).status, 200, '可還原');
    // 新增 AI 必須選專案：人類有兩個以上專案又沒帶 → 400
    const noProj = await call(boss.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name: '沒選專案', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff });
    assert.equal(noProj.status, 400, '多個專案又沒選 → 要求必選');
    // ===== 專案隔離：訊息、卡片、建議都只看得到自己的專案 =====
    // ① 只有群組管理員（最早加入的人類）能管理專案與成員
    const pr = (await call(amy.token, '/api/projects')).body;
    assert.equal(pr.adminId, bossId, '群組管理員＝最早加入的人類');
    assert.ok(pr.crossRoleIds.includes(percyId), 'PO 是跨專案角色');
    assert.equal((await call(amy.token, '/api/projects', 'POST', { name: '非管理員' })).body.error?.code, 'NOT_ADMIN', '非管理員不能新增專案');
    assert.equal((await call(amy.token, `/api/projects/${newId}`, 'PATCH', { name: 'x' })).body.error?.code, 'NOT_ADMIN', '非管理員不能改名');
    // ③ 跨專案角色固定，不能移出
    assert.equal((await put(boss.token, percyId, ['預設專案'])).body.error?.code, 'CROSS_ROLE_FIXED', 'PO 不能被移出專案');
    // ⑥ AI 的專案不能超出所屬人類
    const lone = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
    const loneId = lone.participant.participantId;
    await put(boss.token, loneId, ['預設專案']);
    const loneAi = (await call(lone.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r.role, name: '小明PG', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    assert.equal((await call(lone.token, '/api/my-ais', 'POST', { projects: ['第二專案'], roleKey: 'PG', role: r.role, name: '小明PG2', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body.error?.code, 'OWNER_NOT_IN_PROJECT', '新增 AI 不能超出自己的專案');
    assert.equal((await put(boss.token, loneAi.participantId, ['預設專案', '第二專案'])).body.error?.code, 'OWNER_NOT_IN_PROJECT', '管理員也不能讓 AI 超出所屬人類');
    // ⑦ 一般成員只能看
    assert.equal((await put(lone.token, loneId, ['預設專案', '第二專案'])).body.error?.code, 'NOT_ADMIN', '一般成員不能自己加入專案');
    // ④ 移出前預告退回幾張卡；移出後卡片退回待處理、未指派
    const oc = (await call(boss.token, '/api/cards', 'POST', { requestId: 'req_mv1', title: '小明PG 的平台卡', project: '預設專案', ownerId: loneAi.participantId, status: '進行中' })).body;
    const dry = (await call(boss.token, '/api/projects/預設專案/members', 'PUT', { dryRun: true, memberIds: pr.items.length && (await call(boss.token, '/api/participants')).body.items.filter(p => (p.projects || []).includes('預設專案') && p.participantId !== loneId).map(p => p.participantId) })).body;
    assert.equal(dry.error?.code, 'NEEDS_ONE_PROJECT', '只屬於這個專案的人不能直接移出');
    await put(boss.token, loneId, ['預設專案', '第二專案']);
    await put(boss.token, loneAi.participantId, ['預設專案', '第二專案']);
    const keep = (await call(boss.token, '/api/participants')).body.items.filter(p => (p.projects || []).includes('預設專案') && p.participantId !== loneAi.participantId).map(p => p.participantId);
    const dry2 = (await call(boss.token, '/api/projects/預設專案/members', 'PUT', { dryRun: true, memberIds: keep })).body;
    assert.deepEqual(dry2.impact.map(x => [x.name, x.returnedCards]), [['小明PG', [oc.cardId]]], '預告：1 張卡會退回待處理');
    assert.equal((await call(boss.token, `/api/cards/${oc.cardId}`)).body.owner?.participantId, loneAi.participantId, 'dryRun 不改資料');
    assert.equal((await call(boss.token, '/api/projects/預設專案/members', 'PUT', { memberIds: keep })).status, 200);
    const oc2 = (await call(boss.token, `/api/cards/${oc.cardId}`)).body;
    assert.ok(!oc2.owner && oc2.status === '待處理', '移出後卡片未指派、退回待處理');
    // ⑤ 異動紀錄
    const ev = (await call(amy.token, '/api/projects/預設專案/events')).body.items.map(e => e.text);
    assert.ok(ev.some(t => t.includes('移除 小明PG（1 張卡退回待處理）')) && ev.some(t => t.includes('加入 王小明')), '異動紀錄記下加入與移除');
    assert.ok((await call(boss.token, `/api/projects/${newId}/events`)).body.items.some(e => e.text.includes('改名：新專案甲 → 新專案乙')), '異動紀錄記下改名');
    // PO ：指派、收件人只能選同專案成員，跨專案擋下並說明
    assert.equal((await call(boss.token, '/api/cards', 'POST', { requestId: 'req_x1', title: '跨專案指派', project: '預設專案', ownerId: bank.participantId })).body.error?.code, 'PROJECT_MISMATCH', '負責人不同專案擋下');
    assert.equal((await call(boss.token, '/api/cards', 'POST', { requestId: 'req_x2', title: '跨專案等誰', project: '預設專案', waitForId: bank.participantId })).body.error?.code, 'PROJECT_MISMATCH', '等誰不同專案擋下');
    const xm = await msg(plat.token, '[回覆] 指定第二專案 PG', { project: '預設專案', recipientIds: [bank.participantId] });
    assert.equal(xm.body.error?.code, 'PROJECT_MISMATCH', '收件人不同專案擋下');
    assert.ok(xm.body.error.message.includes('第二專案PG'), '錯誤訊息說明是誰');
    assert.equal((await msg(plat.token, '[回覆] 全部專案可指定', { project: 'all', recipientIds: [bank.participantId] })).status, 201, '全部專案的訊息可指定任何人');
    // ===== 隔離：伺服器擋，不只畫面 =====
    await put(boss.token, plat.participantId, ['預設專案']);
    await put(boss.token, bank.participantId, ['第二專案']);
    const bm = (await msg(bank.token, '[進度] 第二專案內部進度', { project: '第二專案' })).body;
    const am = (await msg(bank.token, '[通知] 跨專案公告', { project: 'all' })).body;
    const platAll = (await call(plat.token, '/api/messages?limit=100')).body.items.map(m => m.messageId);
    assert.ok(!platAll.includes(bm.messageId), '只屬平台的成員，不帶 project 也讀不到第二專案訊息');
    assert.ok(platAll.includes(am.messageId), '全部專案（跨專案頻道）的訊息人人看得到');
    assert.equal((await call(plat.token, `/api/messages/${bm.messageId}`)).status, 404, '單則讀取也擋');
    assert.ok((await call(boss.token, '/api/messages?limit=100')).body.items.some(m => m.messageId === bm.messageId), '兩邊成員看得到');
    const allBank = (await msg(boss.token, '[通知] 第二專案全體注意', { project: '第二專案', audience: 'all' })).body;
    const platN = (await call(plat.token, '/api/notifications?limit=100')).body.items.map(n => n.messageId);
    const bankN = (await call(bank.token, '/api/notifications?limit=100')).body.items.map(n => n.messageId);
    assert.ok(!platN.includes(allBank.messageId) && bankN.includes(allBank.messageId), '@所有人只送到該專案成員');
    const rp = (await msg(bank.token, '[回覆] 第二專案 PG 回自己那則', { replyToMessageId: bm.messageId })).body;
    assert.equal(rp.project, '第二專案', '單一專案成員回覆＝自己的專案');
    const bc = (await call(boss.token, '/api/cards', 'POST', { requestId: 'req_iso1', title: '第二專案專案的卡', project: '第二專案' })).body;
    assert.ok(!(await call(plat.token, '/api/cards?limit=200')).body.items.some(c => c.cardId === bc.cardId), '只屬平台的成員看不到第二專案的卡');
    assert.equal((await call(plat.token, `/api/cards/${bc.cardId}`)).body.error?.code, 'CARD_FORBIDDEN', '卡片詳情回 403 沒權限（不寫專案名）');
    assert.equal((await call(plat.token, '/api/cards/C-99999')).status, 404, '真的不存在才回 404');
    // ===== ：跨專案隔離破口（健檢 B1～B4、S8）=====
    await put(boss.token, lone.participant.participantId, ['預設專案']); // 只屬平台的人類
    // - 驗證：別專案的人不能驗證
    // 由第二專案 AI 完成（人類完成會自動算驗收）
    assert.equal((await call(boss.token, `/api/cards/${bc.cardId}`, 'PATCH', { ownerId: bank.participantId })).status, 200);
    assert.equal((await call(bank.token, `/api/cards/${bc.cardId}`, 'PATCH', { status: '已完成' })).status, 200);
    assert.equal((await call(plat.token, `/api/cards/${bc.cardId}/verify`, 'POST')).body.error?.code, 'CARD_FORBIDDEN', 'B1：別專案的 AI 不能驗證');
    assert.equal((await call(lone.token, `/api/cards/${bc.cardId}/verify`, 'POST')).body.error?.code, 'CARD_FORBIDDEN', 'B1：別專案的人類不能驗證');
    assert.equal((await call(boss.token, `/api/cards/${bc.cardId}/verify`, 'POST')).status, 200, 'B1：同專案的人照常可驗證');
    // - 掛訊息：別專案的卡不能掛；自己的卡不能掛看不到的訊息
    assert.equal((await call(plat.token, `/api/cards/${bc.cardId}/messages`, 'POST', { messageId: am.messageId })).body.error?.code, 'CARD_FORBIDDEN', 'B1：不能把訊息掛到別專案的卡');
    const pc333 = (await call(plat.token, '/api/cards', 'POST', { requestId: 'req_t1_pc', title: '平台自己的卡', project: '預設專案' })).body;
    assert.equal((await call(plat.token, `/api/cards/${pc333.cardId}/messages`, 'POST', { messageId: bm.messageId })).status, 400, 'B1：看不到的訊息不能掛');
    assert.equal((await call(plat.token, `/api/cards/${pc333.cardId}/messages`, 'POST', { messageId: am.messageId })).status, 200, 'B1：看得到的訊息照常可掛');
    // B1：發文時直接帶 cardId 也要擋——C 號、專案代號（BANK-20 那種）都不能掛別專案的卡
    const bcKey = (await call(boss.token, `/api/cards/${bc.cardId}`)).body.key;
    assert.ok(bcKey && bcKey === bc.cardId && /^C-\d+$/.test(bc.legacyId), '第二專案卡號是專案卡號，舊編號在 legacyId：' + bcKey);
    for (const id of [bc.legacyId, bcKey]) {
      const r = await call(plat.token, '/api/messages', 'POST', { requestId: 'req_t1_m_' + id, project: '預設專案', cardId: id, text: '[測試] 掛別專案的卡' });
      assert.equal(r.body.error?.code, 'CARD_FORBIDDEN', `B1：發文帶 ${id === bcKey ? '專案代號' : 'C 號'}也不能掛別專案的卡（修正前 201、cardLinked: true）`);
    }
    const cross = (await call(boss.token, '/api/messages', 'POST', { requestId: 'req_t1_m3', project: '預設專案', cardId: bcKey, text: '平台訊息' })).body;
    assert.ok(cross.messageId && cross.cardLinked === false && cross.warnings?.some(w => w.includes('沒有掛上卡片')), 'B1：看得到的人把平台訊息帶第二專案卡號 → 照發但不掛、回 warnings');
    assert.ok(!(await call(boss.token, `/api/cards/${bc.cardId}`)).body.messageIds.includes(cross.messageId), 'B1：第二專案卡上沒有這則平台訊息');
    const okLink = await call(boss.token, '/api/messages', 'POST', { requestId: 'req_t1_m4', project: '第二專案', cardId: bcKey, text: '第二專案訊息' });
    assert.equal(okLink.status, 201); assert.equal(okLink.body.cardLinked, true, 'B1：同專案照常可掛');
    // 退回（UX）：掛訊息 API 不准跨專案（發文帶 cardId 那段由 AB12 修、測）
    const xl = (await msg(boss.token, '[回覆] 平台的訊息', { project: '預設專案' })).body;
    assert.equal((await call(boss.token, `/api/cards/${bc.cardId}/messages`, 'POST', { messageId: xl.messageId })).status, 400, '掛訊息 API：平台訊息不能掛到第二專案的卡');
    const xb = (await msg(boss.token, '[回覆] 第二專案的訊息', { project: '第二專案' })).body;
    assert.equal((await call(boss.token, `/api/cards/${bc.cardId}/messages`, 'POST', { messageId: xb.messageId })).status, 200, '掛訊息 API：同專案照常可掛');
    // - 解決 [需確認]：別專案的不能解決
    const bq = (await msg(bank.token, '[需確認] 第二專案要人決定\n\n選項：\n1. 甲\n2. 乙', { project: '第二專案', replyFrom: [bossId] })).body;
    assert.equal((await call(lone.token, `/api/decisions/${bq.messageId}/resolve`, 'POST')).status, 404, 'B1：只屬平台的人類不能解決第二專案的 [需確認]');
    assert.equal((await call(boss.token, `/api/decisions/${bq.messageId}/resolve`, 'POST')).status, 200, 'B1：看得到的人照常可解決');
    // - 專案異動紀錄：只有專案成員或管理員
    assert.equal((await call(plat.token, '/api/projects/第二專案/events')).status, 403, 'B3：非專案成員讀不到別專案異動紀錄');
    assert.equal((await call(lone.token, '/api/projects/第二專案/events')).status, 403, 'B3：非管理員人類也讀不到');
    assert.equal((await call(bank.token, '/api/projects/第二專案/events')).status, 200, 'B3：專案成員讀得到');
    assert.equal((await call(boss.token, '/api/projects/第二專案/events')).status, 200, 'B3：管理員讀得到');
    // - AI 建議：只屬平台的人類看不到、也不能處理第二專案的建議
    const bs = (await call(bank.token, '/api/suggestions', 'POST', { requestId: 'req_t1_s1', kind: 'create', project: '第二專案', title: '第二專案建議', ownerId: bossId, why: '跨專案測試' })).body;
    assert.ok(bs.suggestionId, JSON.stringify(bs));
    assert.ok(!(await call(lone.token, '/api/suggestions?state=pending')).body.items.some(s => s.suggestionId === bs.suggestionId), 'B4：只屬平台的人類列表裡沒有第二專案的建議');
    assert.ok((await call(boss.token, '/api/suggestions?state=pending')).body.items.some(s => s.suggestionId === bs.suggestionId), 'B4：兩邊都屬的人看得到');
    assert.equal((await call(lone.token, `/api/suggestions/${bs.suggestionId}/skip`, 'POST')).status, 404, 'B4：不能略過看不到的建議');
    assert.equal((await call(lone.token, `/api/suggestions/${bs.suggestionId}/apply`, 'POST', {})).status, 404, 'B4：不能採用看不到的建議');
    assert.equal((await call(plat.token, '/api/suggestions', 'POST', { requestId: 'req_t1_s2', kind: 'status', cardId: bc.cardId, status: '進行中', why: 'x' })).body.error?.code, 'CARD_FORBIDDEN', '不能對看不到的卡提建議');
    // - 檔案下載：掛在別專案訊息上的檔案下載不到
    const up = await fetch(`${BASE}/api/files?${new URLSearchParams({ name: '第二專案文件.pdf', declared: 'true', project: '第二專案' })}`, { method: 'POST', headers: { Authorization: `Bearer ${bank.token}` }, body: new TextEncoder().encode('%PDF-1.4\n%%EOF\n') });
    const upb = await up.json();
    assert.equal(up.status, 201, JSON.stringify(upb));
    const fid = upb.file.fileId;
    assert.equal((await fetch(`${BASE}/api/files/${fid}`, { headers: { Authorization: `Bearer ${plat.token}` } })).status, 404, 'S8：別專案的檔案下載不到');
    assert.equal((await fetch(`${BASE}/api/files/${fid}`, { headers: { Authorization: `Bearer ${bank.token}` } })).status, 200, 'S8：同專案照常下載');
    assert.ok((await call(boss.token, '/api/cards?limit=200')).body.items.some(c => c.cardId === bc.cardId), '兩邊成員看得到兩邊的卡');
    const after0 = (await call(plat.token, '/api/messages?limit=1')).body.nextCursor;
    await msg(bank.token, '[進度] 第二專案又一則（隔離）', { project: '第二專案' });
    const inc = (await call(plat.token, `/api/messages?after=${encodeURIComponent(after0)}`)).body;
    assert.equal(inc.items.length, 0, '輪詢拿不到別專案的新訊息');
    assert.notEqual(inc.nextCursor, after0, '游標仍推進到最新');
    // ===== ：外流情境（UX）=====
    assert.equal((await msg(boss.token, '[需確認] 兩邊成員沒帶專案')).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員沒帶 project 擋下');
    assert.equal((await msg(boss.token, '[回覆] 回覆也要帶', { replyToMessageId: am.messageId })).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員回覆全部專案訊息也要帶');
    const bankReply = (await msg(bank.token, '[完成] 第二專案內容回覆跨專案訊息', { replyToMessageId: am.messageId })).body;
    assert.equal(bankReply.project, '第二專案', '只屬一個專案的人回覆全部專案訊息＝自己的專案，不繼承');
    const bankAll = (await msg(bank.token, '[通知] 明確發全部專案', { replyToMessageId: am.messageId, project: 'all' })).body;
    assert.equal(bankAll.project, null, '明確帶 all 才是全部專案');
    assert.equal((await msg(boss.token, '[進度]【第二專案】標題寫第二專案卻發全部', { project: 'all' })).body.error?.code, 'PROJECT_TEXT_MISMATCH', '開頭【第二專案】卻發全部專案');
    assert.equal((await msg(bank.token, '【預設專案】單一專案的人標題寫別的專案')).body.error?.code, 'PROJECT_TEXT_MISMATCH');
    const tagged = (await msg(boss.token, '[進度]【第二專案】正確帶專案', { project: '第二專案' })).body;
    assert.equal(tagged.project, '第二專案');
    assert.equal((await msg(boss.token, '[通知]【全部專案】公告', { project: 'all' })).body.project, null, '【全部專案】可以發 all');
    const upload = (tok, extra = '') => fetch(`${BASE}/api/files?name=a.txt&declared=true${extra}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: 'hello' }).then(r => r.json());
    assert.equal((await upload(boss.token)).error?.code, 'PROJECT_REQUIRED', '上傳文件附的訊息也要帶專案');
    const upOk = await upload(boss.token, '&project=' + encodeURIComponent('第二專案'));
    assert.equal(upOk.message?.project, '第二專案', '上傳文件可帶 project');
    assert.equal((await upload(bank.token)).message?.project, '第二專案', '單一專案成員上傳不帶＝自己的專案');
    const platSees = (await call(plat.token, '/api/messages?limit=100')).body.items.map(m => m.messageId);
    assert.ok(![bankReply.messageId, tagged.messageId, upOk.message?.messageId].some(id => platSees.includes(id)), '只屬平台的帳號拿不到上面情境產生的任何第二專案訊息');
    // PO ：通知列表也隔離。兩邊成員先收到第二專案的指定，被移出第二專案後就不再列出
    await put(boss.token, both.participantId, ['預設專案', '第二專案']);
    const toBoth = (await msg(boss.token, '[需確認] 給兩邊 PG', { project: '第二專案', recipientIds: [both.participantId] })).body;
    assert.ok((await call(both.token, '/api/notifications?limit=100')).body.items.some(n => n.messageId === toBoth.messageId), '屬於第二專案時收得到');
    await put(boss.token, both.participantId, ['預設專案']);
    const bn = (await call(both.token, '/api/notifications?limit=100')).body.items;
    assert.ok(!bn.some(n => n.messageId === toBoth.messageId), '移出第二專案後，第二專案的通知不再列出');
    assert.equal((await call(both.token, '/api/notifications/count')).body.pending, bn.length, '未讀數與列表一致');
    // 亂碼攔截（U+FFFD 或連續 4 個以上問號，網址除外）
    assert.equal((await msg(plat.token, '[進度] ???? 中文變問號了', { project: 'all' })).body.error?.code, 'INVALID_ENCODING', 'AI 發的連續問號擋下');
    assert.equal((await msg(boss.token, '這是什麼????', { project: 'all' })).status, 201, '人類在網頁打 ???? 不擋');
    assert.equal((await msg(plat.token, '[回覆] 全形？？？？不擋', { project: 'all' })).status, 201, '全形問號不擋');
    assert.equal((await msg(boss.token, '[進度] 壞掉的字�', { project: 'all' })).body.error?.code, 'INVALID_ENCODING', 'U+FFFD 擋下');
    assert.equal((await msg(boss.token, '[進度] 真的嗎???', { project: 'all' })).status, 201, '3 個問號不擋');
    assert.equal((await msg(boss.token, '[進度] 連結 https://x.test/a?q=????&b=1 請看', { project: 'all' })).status, 201, '網址裡的問號不擋');
    // ===== ：成員與權限一次儲存、跨專案角色可開關、我的 AI 可改專案 =====
    const M = (tok, changes, dryRun) => call(tok, '/api/members/matrix', 'PUT', { changes, dryRun });
    const projOf = async id => (await call(boss.token, '/api/participants')).body.items.find(p => p.participantId === id).projects;
    assert.equal((await M(amy.token, [])).status, 403, '只有管理員能用成員與權限');
    const mdry = (await M(boss.token, [{ id: both.participantId, projects: ['預設專案', '第二專案'] }, { id: bank.participantId, projects: ['預設專案', '第二專案'] }], true)).body;
    assert.equal(mdry.dryRun, true); assert.equal(mdry.impact.length, 2, 'dryRun 列出兩人的影響');
    assert.deepEqual(await projOf(both.participantId), ['預設專案'], 'dryRun 不寫入');
    const msave = (await M(boss.token, [{ id: both.participantId, projects: ['預設專案', '第二專案'] }, { id: bank.participantId, projects: ['預設專案', '第二專案'] }])).body;
    assert.equal(msave.impact.length, 2);
    assert.deepEqual(await projOf(bank.participantId), ['預設專案', '第二專案'], '一次存多人、多專案');
    await M(boss.token, [{ id: both.participantId, projects: ['預設專案'] }, { id: bank.participantId, projects: ['第二專案'] }]);
    const con = (await M(boss.token, [{ id: plat.participantId, crossRole: true }])).body;
    assert.ok(con.crossRoleIds.includes(plat.participantId), '管理員可把成員設為跨專案角色');
    assert.deepEqual(await projOf(plat.participantId), (await call(boss.token, '/api/projects')).body.items.filter(p => !p.archived).map(p => p.id), '設為跨專案角色＝自動在所有專案');
    assert.equal((await M(boss.token, [{ id: plat.participantId, projects: ['預設專案'] }])).body.error?.code, 'CROSS_ROLE_FIXED', '跨專案角色不能只移出專案');
    const coff = (await M(boss.token, [{ id: plat.participantId, crossRole: false, projects: ['預設專案'] }])).body;
    assert.ok(!coff.crossRoleIds.includes(plat.participantId) && (await projOf(plat.participantId)).join() === '預設專案', '同一次關掉跨專案角色並移出專案');
    assert.ok((await M(boss.token, [{ id: bossId, crossRole: true }])).body.crossRoleIds.includes(bossId));
    assert.equal((await M(boss.token, [{ id: bossId, crossRole: false }])).body.error?.code, 'ADMIN_CROSS_ROLE', '管理員本人不能關掉自己的跨專案角色');
    assert.equal((await M(boss.token, [{ id: percyId, crossRole: false }])).body.crossRoleIds.includes(percyId), false, '預設的跨專案角色（PO）也能關掉');
    assert.equal((await M(boss.token, [{ id: bank.participantId, projects: [] }])).body.error?.code, 'NEEDS_ONE_PROJECT', '至少一個專案');
    const pev = (await call(boss.token, '/api/projects/預設專案/events?limit=50')).body.items.map(e => e.text);
    assert.ok(pev.some(t => /取消 Amy 為跨專案角色/.test(t)), '跨專案角色變更記在異動紀錄');
    // 我的 AI：所屬人類改 AI 的專案
    const adry = (await call(boss.token, `/api/my-ais/${bank.participantId}`, 'PATCH', { projects: ['預設專案'], dryRun: true })).body;
    assert.ok(adry.dryRun && adry.impact[0].removed.includes('第二專案'), '改 AI 專案前先看影響');
    assert.deepEqual(await projOf(bank.participantId), ['第二專案'], 'dryRun 不寫入');
    const asave = (await call(boss.token, `/api/my-ais/${bank.participantId}`, 'PATCH', { projects: ['預設專案', '第二專案'] })).body;
    assert.deepEqual(asave.projects, ['預設專案', '第二專案'], '所屬人類可改自己 AI 的專案');
    assert.equal((await call(amy.token, `/api/my-ais/${bank.participantId}`, 'PATCH', { projects: ['預設專案'] })).status, 404, '不能改別人的 AI');
    // ===== ：專案 leader =====
    await M(boss.token, [{ id: percyId, projects: ['預設專案', '第二專案'] }]);
    assert.equal((await M(amy.token, [{ id: bank.participantId, projects: ['預設專案', '第二專案'] }])).status, 403, '還不是 leader 不能改');
    assert.equal((await M(boss.token, [{ id: bank.participantId, leaderOf: ['預設專案'] }])).body.error?.code, 'INVALID_REQUEST', 'leader 只能是人類');
    const mate = (await call(null, '/api/join', 'POST', { name: '陳建宏', role: 'BA' })).body;
    assert.equal((await M(boss.token, [{ id: mate.participant.participantId, leaderOf: ['預設專案'] }])).body.error?.code, 'LEADER_NOT_MEMBER', '要先在專案才能當 leader');
    const setL = (await M(boss.token, [{ id: percyId, leaderOf: ['預設專案'] }])).body;
    assert.deepEqual(setL.leaders['預設專案'], [percyId], '管理員指定 Amy 為平台 leader');
    assert.equal((await M(amy.token, [{ id: bank.participantId, projects: ['第二專案'] }], true)).status, 200, 'leader 可以看影響');
    const lAdd = (await M(amy.token, [{ id: mate.participant.participantId, projects: ['預設專案'] }])).body;
    assert.equal(lAdd.impact[0].added[0], '預設專案', 'leader 可以把人加入自己的專案');
    assert.equal((await M(amy.token, [{ id: mate.participant.participantId, projects: ['預設專案', '第二專案'] }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能改別的專案');
    assert.equal((await M(amy.token, [{ id: plat.participantId, crossRole: true }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能設跨專案角色');
    assert.equal((await M(amy.token, [{ id: mate.participant.participantId, leaderOf: ['預設專案'] }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能指定 leader');
    assert.equal((await M(amy.token, [{ id: percyId, projects: ['第二專案'] }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能把自己移出');
    assert.equal((await M(amy.token, [{ id: bossId, projects: ['第二專案'] }])).body.error?.code, 'NOT_PROJECT_LEADER', 'leader 不能改管理員／跨專案角色');
    const lev = (await call(boss.token, '/api/projects/預設專案/events?limit=10')).body.items.map(e => e.text);
    assert.ok(lev.some(t => /Amy（預設專案 leader） 加入 陳建宏/.test(t)), 'leader 的變更記在異動紀錄');
    assert.ok((await call(boss.token, '/api/messages?limit=20')).body.items.some(m => /Amy（預設專案 leader）把 陳建宏 加入預設專案/.test(m.text) && m.project === '預設專案'), '通知管理員');
    await M(boss.token, [{ id: percyId, projects: ['第二專案'] }]);
    assert.deepEqual((await call(boss.token, '/api/projects')).body.leaders['預設專案'], [], '移出專案時 leader 身分一起拿掉');
    assert.equal((await M(amy.token, [{ id: mate.participant.participantId, projects: ['預設專案'] }])).status, 403, '不再是 leader 就不能改');
    // ===== ：成員名單、團隊狀態依專案 =====
    await M(boss.token, [{ id: plat.participantId, projects: ['預設專案'] }, { id: bank.participantId, projects: ['第二專案'] }]);
    const pp = (await call(plat.token, '/api/participants')).body.items.map(p => p.participantId);
    assert.ok(pp.includes(plat.participantId) && !pp.includes(bank.participantId), '只屬平台的成員拿不到只屬第二專案的人');
    assert.ok(pp.includes(bossId), '跨專案角色（管理員）看得到');
    assert.deepEqual((await call(plat.token, '/api/participants')).body.items.find(p => p.participantId === bossId).projects, ['預設專案'], '別人的專案只列自己也在的（不露出別專案名稱）');
    const ts = (await call(plat.token, '/api/team-status')).body.members.map(m => m.participantId);
    assert.ok(!ts.includes(bank.participantId), '團隊狀態也依專案');
    assert.ok((await call(boss.token, '/api/participants')).body.items.some(p => p.participantId === bank.participantId), '兩邊都屬的人看得到全部');
    assert.deepEqual((await call(plat.token, '/api/projects')).body.items.map(p => p.id), ['預設專案'], '專案清單只回自己所屬的專案');
    assert.ok((await call(boss.token, '/api/projects')).body.items.length >= 2, '兩邊都屬的人看得到全部專案');
    // ===== ：群組名稱 =====
    assert.equal((await call(null, '/api/group')).body.name, 'Aigile-Switch', '預設群組名稱（不用登入就讀得到）');
    assert.equal((await call(amy.token, '/api/group', 'PUT', { name: '別人改' })).status, 403, '只有管理員能改');
    assert.equal((await call(boss.token, '/api/group', 'PUT', { name: '' })).status, 400, '不能空白');
    assert.equal((await call(boss.token, '/api/group', 'PUT', { name: '新群組名' })).body.name, '新群組名');
    assert.equal((await call(null, '/api/group')).body.name, '新群組名');
    const ob = (await call(boss.token, `/api/my-ais/${plat.participantId}/onboarding`)).body.text;
    assert.ok(ob.startsWith('# 新群組名 接入設定') && ob.includes('加入「新群組名」協作群組'), '接入 PROMPT 跟著改');
    console.log('projects: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
