// 知識庫設定測試：說明第 6 章教學＋整理 AI 沒裝技能的提醒
// A. GET /kb/settings 的候選 AI 帶 kbSkill：none（沒發給它）→ sent（套用「知識庫整理」範本發給它、還沒同步）→ installed（同步回報已裝）
// B. 「📚 知識庫整理 AI」視窗：選到 none 的 AI 顯示「還沒有『知識庫整理』技能…去裝技能 ›」；sent 顯示「請它的主人…按『同步』」；
//    已裝、「不自動整理」不顯示；黃字不擋儲存；「去裝技能 ›」到成員與本專案角色 › 技能
// C. 知識庫目錄是空的：說明下面有「第一次用？看教學：知識庫怎麼設定 ›」連到 /help/6
// D. 說明第 6 章：章名照 UX 原稿；「打開知識庫」到這個專案的「文件 › 📚 知識庫」
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/kb-setup-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { SKILL_TEMPLATES, templateIn } from '../src/skill-templates.js';

if (!findBrowser()) { console.log('kb-setup-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('kbsetup');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), KB = `/api/projects/${PJ}/kb`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), lead = await join('林小安', 'SM');
  const id = x => x.participant.participantId;
  await call(liu.token, `/api/participants/${id(lead)}/projects`, 'PUT', { projects: ['預設專案'] });
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const mkAi = async name => (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: '產品負責', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const kbAi = await mkAi('整理助手'), other = await mkAi('另一隻');
  const state = async () => Object.fromEntries((await call(lead.token, `${KB}/settings`)).body.candidates.map(c => [c.name, c.kbSkill]));

  // ---------- A 技能狀態 ----------
  assert.deepEqual(await state(), { 整理助手: 'none', 另一隻: 'none' }, 'A 還沒套範本：都是 none');
  const tpl = templateIn(SKILL_TEMPLATES.find(t => t.name === 'kb-curation'), 'zh');
  const sk = await call(lead.token, `/api/projects/${PJ}/skills`, 'POST', { files: [{ path: 'SKILL.md', text: tpl.text }], aiIds: [kbAi.participantId] });
  assert.equal(sk.status, 201, 'A 套用範本：' + JSON.stringify(sk.body).slice(0, 200));
  { const s = await state(); assert.deepEqual(s, { 整理助手: 'sent', 另一隻: 'none' }, 'A 只發給整理助手：sent，另一隻還是 none：' + JSON.stringify(s) + JSON.stringify(sk.body).slice(0, 300)); }
  await call(kit.aiToken(kbAi.participantId), '/api/me/skills/installed', 'POST', { skillIds: [sk.body.skillId] });
  assert.deepEqual(await state(), { 整理助手: 'installed', 另一隻: 'none' }, 'A 同步回報後：installed');
  await call(kit.aiToken(kbAi.participantId), '/api/me/skills/installed', 'POST', { skillIds: [] }); // 先回到「發了還沒裝」，畫面測 sent

  const { js, login } = await kit.browser(1280, 900);
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const pick = name => js(`(() => { const l = [...document.querySelectorAll('.kb-ai-opt')].find(x => x.querySelector('b').textContent === ${JSON.stringify(name)}); l.querySelector('input').click(); return true; })()`);
  const warn = async () => (await js("document.querySelector('.kb-skill-warn').hidden") ? '' : await text('.kb-skill-warn'));
  const openSetting = async () => {
    await login(lead.token, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
    await click('[data-pset]');
    await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"kbai\"]')"), 5000, '⚙ 選單');
    await click('#pset-menu [data-pset-act="kbai"]');
    await until(() => js("document.querySelectorAll('.kb-ai-opt').length === 3"), 5000, '設定視窗');
  };

  // ---------- C 空的知識庫：教學連結 ----------
  await login(lead.token, '/p/main/files');
  await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
  await click('[data-files-tab="kb"]');
  await until(() => js("!!document.querySelector('.kb-empty')"), 8000, 'C 空的知識庫');
  assert.equal(await js("document.querySelector('.kb-empty a[href=\"/help/6\"]')?.textContent"), '第一次用？看教學：知識庫怎麼設定 ›', 'C 教學連結');

  // ---------- B 設定視窗的黃字 ----------
  await openSetting();
  assert.equal(await warn(), '', 'B 預設「不自動整理」：不顯示');
  await pick('另一隻');
  assert.equal(await warn(), '⚠ 這隻 AI 還沒有「知識庫整理」技能，整理出來的頁會少很多。去裝技能 ›', 'B 沒發給它');
  await pick('整理助手');
  assert.equal(await warn(), '⚠ 「知識庫整理」技能已發給這隻 AI，還沒裝好。請它的主人在「我的 AI › 🧩 技能」按「同步」。', 'B 發了還沒同步');
  await pick('不自動整理');
  assert.equal(await warn(), '', 'B 選回不自動整理：不顯示');
  await pick('另一隻');
  await click('[data-kbs="1"]');
  await until(async () => (await call(lead.token, `${KB}/settings`)).body.aiId === other.participantId, 5000, 'B 黃字不擋儲存');
  await openSetting();
  await pick('另一隻');
  await click('[data-kb-skill]');
  await until(() => js("!document.querySelector('.kb-ai-opt') && /\\/members/.test(location.pathname)"), 8000, 'B 去裝技能：到成員與本專案角色');
  await until(() => js("document.querySelector('[data-pm-tab=\"skills\"]')?.getAttribute('aria-selected') === 'true' || !!document.querySelector('.sk-bar')"), 8000, 'B 開在技能分頁');
  await call(kit.aiToken(kbAi.participantId), '/api/me/skills/installed', 'POST', { skillIds: [sk.body.skillId] });
  await openSetting();
  await pick('整理助手');
  assert.equal(await warn(), '', 'B 已裝：不顯示');

  // ---------- D 說明第 6 章 ----------
  await login(lead.token, '/help/6');
  await until(() => js("!!document.querySelector('[data-help-try=\"kb\"]')"), 10000, 'D 第 6 章');
  assert.match(await text('.help-page h2, .help-ch h2, h2'), /知識庫：讓 AI 讀懂你的文件/, 'D 章名');
  await click('[data-help-try="kb"]');
  await until(() => js("document.querySelector('[data-files-tab=\"kb\"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#kb-q, .kb-empty')"), 10000, 'D 打開知識庫分頁');
  console.log('kb-setup-ui-test：全部通過（技能狀態、沒裝技能黃字、不擋儲存、去裝技能、空知識庫教學連結、說明第 6 章試試看）');
} catch (e) {
  console.error('kb-setup-ui-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
