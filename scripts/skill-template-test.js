// 驗收測試（PLAT-365）：技能庫內建範本技能，各專案按「套用」複製再改
// 測：範本內容規則（只有 SKILL.md、沒有腳本、中英都有、名稱合法、不寫團隊／人名／平台專屬說法、上傳檢查過得去）、
//     GET /api/skill-templates（人類才能讀、照語言給）、套用（走一般上傳，可以先改內容）、清單與抽屜標示來自哪個範本、
//     範本有新版時標 outdated（不自動覆蓋）、改了內容拿掉標記就不再標、AI 收到的就是專案版內容
// 用法：node scripts/skill-template-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { SKILL_TEMPLATES, templateIn, templateMarkOf } from '../src/skill-templates.js';
import { parseFrontmatter, isScript } from '../src/skills.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-tpl-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const len = s => [...s].length;

try {
  // 1. 範本內容規則
  const NAMES = ['commit-convention', 'handover-format', 'report-and-ask', 'testing-rules', 'code-review-checklist', 'security-checklist', 'kb-curation']; // 加知識庫整理
  assert.deepEqual(SKILL_TEMPLATES.map(t => t.name), NAMES, '第一批 6 個＋知識庫整理');
  for (const t of SKILL_TEMPLATES) {
    for (const lang of ['zh', 'en']) {
      const x = templateIn(t, lang), fm = parseFrontmatter(x.text);
      assert.equal(fm?.name, t.name, `${t.name}（${lang}）frontmatter 的 name 跟範本名稱一樣`);
      assert.ok(fm.description && x.description === fm.description, `${t.name}（${lang}）有 description`);
      assert.deepEqual(templateMarkOf(x.text), { name: t.name, version: t.version }, `${t.name}（${lang}）帶範本標記`);
      assert.ok(len(x.text) <= 2600, `${t.name}（${lang}）${len(x.text)} 字，SKILL.md 只放硬規則（約 1,500 字）`);
      assert.ok(x.title, `${t.name}（${lang}）有標題`);
      // 不寫團隊、人名、平台專屬說法（Aigile、血汗、平台網址、MCP 工具名、卡號前綴 PLAT／C-）
      assert.ok(!/aigile(?!-template)|Aigile|血汗|昱志|PLAT-|\bC-\d|mcp__|aigile_|watcher|\.aigile\//i.test(x.text.replace(/aigile-template: [a-z-]+@\d+/, '')), `${t.name}（${lang}）沒有平台專屬說法`);
      if (lang === 'en') assert.ok(!/[一-鿿]/.test(x.text.replace(/\[(接單|進度|完成|需確認|受阻)\]|問題N：|問題1：|選項：/g, '')), `${t.name}（en）除了協定標籤沒有中文`);
    }
  }
  assert.ok(!SKILL_TEMPLATES.some(t => isScript('SKILL.md')), '範本只有 SKILL.md，不算腳本');

  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body; // 一般成員
  await call(boss.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const ai = await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const aiTok = ai.body.token;

  // 2. 讀範本：人類才能讀；照語言給
  const zh = await call(boss.token, '/api/skill-templates');
  assert.equal(zh.status, 200); assert.equal(zh.body.lang, 'zh');
  assert.deepEqual(zh.body.items.map(x => x.name), NAMES);
  assert.match(zh.body.items[0].text, /Commit 訊息慣例/);
  // 新增技能視窗用的圖示、分類、推薦角色（UX #6386）：每個範本都有，分類都在清單裡
  assert.deepEqual(zh.body.categories, ['git', 'quality', 'handoff', 'security']);
  for (const t of zh.body.items) { assert.ok(t.icon, `${t.name} 有圖示`); assert.ok(zh.body.categories.includes(t.category), `${t.name} 分類`); assert.ok(Array.isArray(t.roles), `${t.name} 推薦角色`); }
  const en = await call(wang.token, '/api/skill-templates?lang=en');
  assert.equal(en.body.lang, 'en'); assert.match(en.body.items[0].text, /# Commit message convention/, '一般成員也能看範本（英文）');
  assert.equal((await call(aiTok, '/api/skill-templates')).status, 403, 'AI 不用讀範本');
  assert.equal((await call(null, '/api/skill-templates')).status, 401, '要登入');

  // 3. 套用：leader／管理員把範本內容（可以先改）走一般上傳，純文字直接上架
  const tpl = zh.body.items.find(x => x.name === 'commit-convention');
  const edited = tpl.text.replace('第一行 50 字內', '第一行 40 字內');
  const up = await call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: edited }], roles: [] });
  assert.equal(up.status, 201, JSON.stringify(up.body)); assert.equal(up.body.status, 'published', '純文字直接上架');
  assert.deepEqual(up.body.template, { name: 'commit-convention', version: 1, latest: 1, outdated: false }, '上傳回應標示來自哪個範本');
  // 清單（技能分頁、專案技能庫）與抽屜都標
  const list = await call(boss.token, '/api/skills');
  assert.deepEqual(list.body.items.find(x => x.name === 'commit-convention').template, { name: 'commit-convention', version: 1, latest: 1, outdated: false }, '技能分頁標範本');
  const pjList = await call(wang.token, '/api/projects/預設專案/skills');
  assert.equal(pjList.body.items.find(x => x.name === 'commit-convention').template?.name, 'commit-convention', '專案技能庫也標');
  const one = await call(boss.token, `/api/skills/${up.body.skillId}`);
  assert.equal(one.body.template?.version, 1, '抽屜也標');
  assert.match(one.body.files[0].text, /第一行 40 字內/, '存的是專案改過的內容');
  // AI 收到的是專案版
  const mineList = (await call(aiTok, '/api/me/skills')).body.items;
  const files = await call(aiTok, `/api/me/skills/${mineList.find(x => x.name === 'commit-convention').skillId}/files`);
  assert.match(files.body.files[0].text, /第一行 40 字內/, 'AI 裝到的是專案改過的版本');

  // 4. 範本有新版：舊標記（@0 模擬專案套用的是舊版）→ outdated，不自動覆蓋
  const old = tpl.text.replace('commit-convention@1', 'commit-convention@0').replace('第一行 50 字內', '第一行 30 字內');
  const up2 = await call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: old }], roles: [] });
  assert.equal(up2.status, 201); assert.equal(up2.body.version, 2, '同名＝同一個技能的新版');
  assert.deepEqual(up2.body.template, { name: 'commit-convention', version: 0, latest: 1, outdated: true }, '範本比專案版新 → outdated');
  const after = (await call(boss.token, '/api/skills')).body.items.find(x => x.name === 'commit-convention');
  assert.equal(after.template.outdated, true, '清單標「範本有新版」');
  assert.match((await call(boss.token, `/api/skills/${after.skillId}`)).body.files[0].text, /第一行 30 字內/, '沒有自動覆蓋專案內容');

  // 5. 拿掉標記（專案自己改寫）就不再標；沒套用過的技能沒有 template
  const plain = old.replace(/\nmetadata:\n  aigile-template: [^\n]+/, '');
  const up3 = await call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: plain }], roles: [] });
  assert.equal(up3.status, 201); assert.equal(up3.body.template, undefined, '拿掉標記就不標');
  const other = await call(wang.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: my-rule\ndescription: 自己寫的\n---\n規則\n' }, { path: 'notes.md', text: 'aigile-template: testing-rules@1 只是說明文字' }], roles: [] });
  assert.equal(other.status, 201); assert.equal(other.body.template, undefined, '標記只看 SKILL.md（回應）');
  const otherOne = await call(wang.token, `/api/skills/${other.body.skillId}`);
  assert.equal(otherOne.body.template, undefined, '標記只看 SKILL.md（抽屜）');
  assert.equal((await call(boss.token, '/api/skills')).body.items.find(x => x.name === 'my-rule').template, undefined, '標記只看 SKILL.md（清單）');

  // 6. 英文範本照樣能套用（一般成員上傳純文字也直接上架，跟現有規則一樣）
  const enTpl = en.body.items.find(x => x.name === 'security-checklist');
  const up4 = await call(wang.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: enTpl.text }], roles: ['PG'] });
  assert.equal(up4.status, 201); assert.equal(up4.body.template?.name, 'security-checklist');
  console.log('skill-template-test：全部通過');
} catch (e) {
  console.error('skill-template-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
