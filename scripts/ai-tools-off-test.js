// 管理員可以關掉用不了的 AI 工具（全站一份、只擋新接入）
// A. GET/PUT /api/ai-tools：只有管理員能改；至少留一個開著；值只能是 claude、codex、copilot、other
// B. 關掉的工具：完整接入文字、一次性連結（產生時、讀取時）、一行啟動都拿不到（API 直接打也一樣）
// C. 已接好的 AI 照常：重新接上、讀收件匣、/api/me；「我的 AI」帶 toolsOff 與每隻 AI 上次回報的工具
// D. 改設定寫進群組異動紀錄（誰、何時、開關哪個），沒變不記
// 網頁：工具選項只列開著的、提示文字、群組分頁的設定卡、英文字典（靜態檢查）
// 用法：node scripts/ai-tools-off-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { ROLES } from '../src/roles.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p364-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const r0 = ROLES.find(x => x.key === 'PG');
const newAi = (tok, name) => call(tok, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r0.role, name, duties: r0.duties, style: r0.style, autonomy: r0.autonomy, mustConfirm: r0.mustConfirm, handoff: r0.handoff });
const tokenOf = id => testToken(db, id);
const groupLog = async tok => (await call(tok, '/api/group/events?limit=30')).body.items.map(e => e.text).filter(t => /AI 工具/.test(t));

try {
  const admin = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body; // 第一位人類＝群組管理員
  const bob = (await call(null, '/api/join', 'POST', { name: '小明', role: 'PG' })).body;
  const ai = (await newAi(admin.token, '副駕')).body;
  let aiTok = await tokenOf(ai.participantId);

  // A. 讀取：預設全開；人類都能讀；AI 不能讀
  let r = await call(admin.token, '/api/ai-tools');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tools.map(t => [t.key, t.name, t.on]), [['claude', 'Claude Code', true], ['codex', 'Codex', true], ['antigravity', 'Antigravity CLI', true], ['copilot', 'Copilot CLI', true], ['other', '其他', true]], '預設五個都開');
  assert.deepEqual(await groupLog(admin.token), [], '一開始沒有紀錄');
  r = await call(bob.token, '/api/ai-tools');
  assert.equal(r.status, 200);
  assert.equal((await call(aiTok, '/api/ai-tools')).status, 403, 'AI 不能讀');

  // A. 修改：非管理員 403、全關 409、怪值 400
  r = await call(bob.token, '/api/ai-tools', 'PUT', { off: ['claude'] });
  assert.equal(r.status, 403); assert.equal(r.body.error?.code || r.body.code, 'NOT_ADMIN');
  r = await call(admin.token, '/api/ai-tools', 'PUT', { off: ['claude', 'codex', 'antigravity', 'copilot', 'other'] });
  assert.equal(r.status, 409, '全關要被擋'); assert.match(r.text, /至少要留一個/);
  assert.equal((await call(admin.token, '/api/ai-tools', 'PUT', { off: ['cursor'] })).status, 400, '不認得的工具');
  assert.equal((await call(admin.token, '/api/ai-tools', 'PUT', { off: 'claude' })).status, 400, 'off 要是陣列');
  assert.equal((await call(admin.token, '/api/ai-tools', 'PUT', {})).status, 400, '沒帶 off');
  assert.deepEqual((await call(admin.token, '/api/ai-tools')).body.off, [], '被擋的修改沒寫進去');

  // 關之前：先用 Claude Code 接好（接入檢查回報 tool=claude）、先產一條 Copilot CLI 的一次性連結
  assert.equal((await call(aiTok, '/api/me/skills/sync-status', 'POST', { state: 'running', tool: 'claude' })).status, 200);
  const early = await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool: 'copilot', start: true, autoStandby: true });
  assert.equal(early.status, 200); assert.ok(early.body.url);

  // D. 關掉 Claude Code 與 Copilot CLI：留紀錄
  r = await call(admin.token, '/api/ai-tools', 'PUT', { off: ['copilot', 'claude'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.off, ['claude', 'copilot'], '照工具順序存');
  assert.deepEqual(r.body.tools.filter(t => !t.on).map(t => t.key), ['claude', 'copilot']);
  let ev = (await call(admin.token, '/api/group/events?limit=30')).body.items.filter(e => /AI 工具/.test(e.text));
  assert.deepEqual(ev.map(e => e.text), ['王大明 關閉 AI 工具：Claude Code、Copilot CLI'], '群組異動紀錄：誰、開關哪個');
  assert.ok(!Number.isNaN(Date.parse(ev[0].at)), '有時間'); assert.equal(ev[0].actorId, admin.participant.participantId);
  r = await call(admin.token, '/api/ai-tools', 'PUT', { off: ['claude', 'copilot'] });
  assert.equal((await groupLog(admin.token)).length, 1, '沒變不多記');
  assert.deepEqual((await call(bob.token, '/api/ai-tools')).body.off, ['claude', 'copilot'], '全站一份：別人看到的一樣');

  // B. 關掉的工具拿不到接入內容
  for (const q of ['?tool=claude', '?tool=copilot', '', '?tool=bogus']) { // 沒帶或不認得＝預設 Claude Code，照 Claude Code 算
    r = await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding${q}`);
    assert.equal(r.status, 403, `完整接入文字 ${q || '（沒帶工具）'} 要擋`);
    assert.equal(r.body.error?.code || r.body.code, 'TOOL_DISABLED');
    assert.match(r.text, /已被管理員關閉/);
  }
  for (const tool of ['claude', 'copilot', undefined]) {
    r = await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool, start: true, autoStandby: true });
    assert.equal(r.status, 403, `一次性連結／一行啟動 tool=${tool} 要擋`);
    assert.ok(!r.body.startLine && !r.body.url, '沒有連結、沒有一行啟動');
  }
  // 關掉之前產的連結，讀的時候也不給
  r = await call(null, new URL(early.body.url).pathname);
  assert.equal(r.status, 403, '先產的 Copilot CLI 連結讀的時候也擋');
  assert.match(r.text, /Copilot CLI 已被管理員關閉/);
  assert.doesNotMatch(r.text, /## 一、/, '沒有接入內容');
  // 開著的照常
  r = await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding?tool=codex`);
  assert.equal(r.status, 200); assert.match(r.body.text, /Codex/);
  r = await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool: 'other', autoStandby: true });
  assert.equal(r.status, 200, '其他照常');
  const setup = await call(null, new URL(r.body.url).pathname);
  assert.equal(setup.status, 200); assert.match(setup.text, /## 一、/, '開著的工具連結讀得到');

  aiTok = await tokenOf(ai.participantId); // 開源版讀連結的那一刻會換新 Token，改用新的
  // C. 已接好的 AI 照常
  assert.equal((await call(aiTok, '/api/me')).status, 200, '/api/me 照常');
  assert.equal((await call(aiTok, '/api/notifications')).status, 200, '收通知照常');
  assert.equal((await call(aiTok, '/api/messages?limit=5')).status, 200, '讀訊息照常');
  r = await call(aiTok, '/api/me/reconnect?tool=claude&start=1');
  assert.equal(r.status, 200, '重新接上（一行啟動重開、/clear）照常'); assert.match(r.text, /重新接上/);
  r = await call(admin.token, '/api/my-ais');
  assert.deepEqual(r.body.toolsOff, ['claude', 'copilot'], '「我的 AI」帶關掉的工具');
  assert.equal(r.body.items.find(x => x.participantId === ai.participantId).tool, 'claude', '帶上次接入檢查回報的工具（給提示用）');

  // D. 打開：紀錄最新的在前
  r = await call(admin.token, '/api/ai-tools', 'PUT', { off: ['copilot'] });
  assert.deepEqual(await groupLog(admin.token), ['王大明 打開 AI 工具：Claude Code', '王大明 關閉 AI 工具：Claude Code、Copilot CLI'], '打開記一筆、在最前面');
  assert.equal((await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding?tool=claude`)).status, 200, '打開後又拿得到');
  // 只剩一個開著時，關它要被擋
  r = await call(admin.token, '/api/ai-tools', 'PUT', { off: ['claude', 'codex', 'antigravity', 'copilot'] });
  assert.equal(r.status, 200, '留一個（其他）可以');
  assert.equal((await call(admin.token, '/api/ai-tools', 'PUT', { off: ['claude', 'codex', 'antigravity', 'copilot', 'other'] })).status, 409);
  // 資料壞掉（全關）時當都開，不讓人完全接不了
  await db.run("UPDATE app_settings SET value = ? WHERE key = 'ai_tools'", JSON.stringify({ off: ['claude', 'codex', 'antigravity', 'copilot', 'other'], log: [] }));
  assert.deepEqual((await call(admin.token, '/api/ai-tools')).body.off, [], '全關的壞資料當都開');
  await db.run("UPDATE app_settings SET value = 'not json' WHERE key = 'ai_tools'");
  assert.equal((await call(admin.token, `/api/my-ais/${ai.participantId}/onboarding?tool=claude`)).status, 200, '壞 JSON 當都開');

  // 網頁（靜態檢查）
  const js = fs.readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  assert.match(js, /maToolsOn\(\)\.map\(\(\[v, l\]\) => `<button type="button" data-act="tool"/, '接入分頁的工具選項只列開著的');
  assert.match(js, /maToolsOn\(\)\.map\(\(\[v, l\]\) => `<button type="button" data-tok-tool=/, '重發視窗的工具選項只列開著的');
  assert.ok(!/AI_TOOLS\.map\(\(\[v, l\]\) => `<button/.test(js), '沒有地方還列出全部工具');
  assert.match(js, /已被管理員關閉，重新接入請改用其他工具/, '主人看得到提示');
  assert.match(js, /items = d\.items; maToolsOff = new Set\(d\.toolsOff/, '從 /api/my-ais 讀關掉的工具');
  assert.match(js, /\$\{groupToolsHtml\(\)\}/, '設定卡放在群組分頁（只有管理員有這個分頁）');
  assert.match(js, /至少要留一個工具開著/, '網頁也先擋全關');
  const en = fs.readFileSync(fileURLToPath(new URL('../public/i18n/en.js', import.meta.url)), 'utf8');
  for (const k of ['可以用的 AI 工具', '這個工具（{0}）已被管理員關閉，重新接入請改用其他工具。已經接好的照常運作，不用動。', '{0} 已被管理員關閉，請改用其他工具接入。', '至少要留一個工具開著，不然新的 AI 都接不進來。']) assert.ok(en.includes(JSON.stringify(k)), `英文字典有「${k}」`);
  console.log('ai-tools-off-test 通過');
} finally {
  try { db.close?.(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
