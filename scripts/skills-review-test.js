// 重現測試：技能庫
// - AI 同時在兩個專案、兩邊有同名技能 → 技能資料夾只能放一份；修正前上傳照收，修正後擋並說明
// - 版本號 MAX+1 與 INSERT 分開 → 同時上傳會同版本；修正後同一句 SQL 算，且 (project, name, version) 唯一
// - 唯讀成員能上傳技能；修正後上傳、核准都回 403 READ_ONLY
// - 管理員不在專案就看不到、不能核准；修正後可以
// 用法：node scripts/skills-review-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const skill = (name, extra = [], body = '照著做') => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${body}\n` }, ...extra];
const up = (tok, pj, files, roles) => call(tok, `/api/projects/${encodeURIComponent(pj)}/skills`, 'POST', { files, ...(roles ? { roles } : {}) });

try {
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO'); // 管理員
  const wang = await join('王小明', 'UX'), chen = await join('陳大文', 'PG'), lin = await join('林小華', 'PG'), wu = await join('吳大同', 'PG');
  const id = p => p.participant.participantId;
  const setPj = (p, projects) => call(boss.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects });
  await setPj(boss, ['預設專案']); await setPj(wang, ['預設專案']); await setPj(chen, ['預設專案']); await setPj(lin, ['預設專案', '第二專案']); await setPj(wu, ['第二專案']);
  const M = changes => call(boss.token, '/api/members/matrix', 'PUT', { changes });
  await M([{ id: id(wang), leaderOf: ['預設專案'] }]);
  const mkAi = async (owner, name, projects, roleKey = 'PG') => (await call(owner.token, '/api/my-ais', 'POST', { projects, roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const both = await mkAi(lin, '兩邊都在的PG', ['預設專案', '第二專案']);
  assert.ok(both.participantId, '建得出兩個專案的 AI');

  // N4：平台有給 PG 的 dup；第二專案再傳同名、也給 PG → 那台兩邊都在的 PG 會收到兩份 → 擋
  assert.equal((await up(boss.token, '預設專案', skill('dup'), ['PG'])).status, 201);
  let r = await up(lin.token, '第二專案', skill('dup'), ['PG']);
  assert.equal(r.body.error?.code, 'NAME_CLASH', 'N4 撞名要擋：' + JSON.stringify(r.body));
  assert.match(r.body.error.message, /「預設專案」已經有同名技能「dup」，會一起發給 兩邊都在的PG/, '訊息講清楚撞到哪、發給誰');
  assert.match(r.body.error.message, /name 改掉/, '告訴他怎麼改');
  r = await up(wu.token, '第二專案', skill('dup'), ['PG']);
  assert.match(r.body.error?.message || '', /^另一個專案已經有/, '上傳者不在另一個專案：不說專案名');
  assert.equal((await up(lin.token, '第二專案', skill('dup'), ['UX'])).status, 201, '角色錯開（沒有同一台 AI 會收到兩份）就可以');
  assert.equal((await up(lin.token, '第二專案', skill('bank-dup'), ['PG'])).status, 201, '改名就可以');

  // N5：同時上傳同名 → 版本號不重複；資料庫也不讓同版本存在
  const rs = await Promise.all([1, 2, 3, 4, 5].map(i => up(boss.token, '預設專案', skill('race', [], '版本 ' + i))));
  const ok = rs.filter(x => x.status === 201).map(x => x.body.version);
  assert.ok(rs.every(x => x.status === 201 || x.body.error?.code === 'BUSY'), '不是成功就是請他再按一次：' + rs.map(x => x.status).join(','));
  assert.equal(new Set(ok).size, ok.length, 'N5 同時上傳不會同版本：' + ok.join(','));
  const vers = (await db.all("SELECT version FROM skills WHERE project = '預設專案' AND name = 'race' ORDER BY version")).map(x => x.version);
  assert.deepEqual(vers, vers.map((_, i) => i + 1), '版本號連續 1..n：' + vers.join(','));
  await assert.rejects(db.run("INSERT INTO skills (id, project, name, version, description, files, sha256, size, has_scripts, roles, status, uploaded_by, uploaded_at) VALUES ('sk_dup', '預設專案', 'race', 1, 'x', '[]', 'x', 1, 0, '[]', 'pending', 'x', 'x')"), /UNIQUE/, 'N5 (project, name, version) 唯一');

  // N6：唯讀成員不能上傳；唯讀的 leader 不能核准
  const pend = (await up(chen.token, '預設專案', skill('needs-review', [{ path: 'scripts/a.sh', text: 'echo 1\n' }]))).body;
  assert.equal(pend.status, 'pending');
  r = await M([{ id: id(chen), readOnlyIn: ['預設專案'] }]);
  assert.equal(r.status, 200, '設唯讀：' + JSON.stringify(r.body));
  r = await up(chen.token, '預設專案', skill('ro-upload'));
  assert.equal(r.body.error?.code, 'READ_ONLY', 'N6 唯讀成員上傳回 403：' + JSON.stringify(r.body));
  assert.equal(r.status, 403);
  assert.equal((await call(chen.token, '/api/skills')).body.projects.find(p => p.id === '預設專案').canUpload, false, '畫面也不給上傳鈕');
  r = await M([{ id: id(wang), readOnlyIn: ['預設專案'] }]);
  assert.notEqual(r.status, 200, 'leader 本來就不能設唯讀（核准端的唯讀檢查只是保險）');
  // 唯讀的人就算被設成 leader 也不能核准：直接寫設定模擬（平台介面不允許這樣設）
  await db.run("INSERT INTO app_settings (key, value) VALUES ('read_only', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ 預設專案: [id(chen), id(wang)] }));
  await new Promise(ok => setTimeout(ok, 10_100)); // 唯讀設定有 10 秒快取
  r = await call(wang.token, `/api/skills/${pend.skillId}/review`, 'POST', { action: 'approve' });
  assert.equal(r.body.error?.code, 'READ_ONLY', 'N6 唯讀的 leader 不能核准：' + JSON.stringify(r.body));
  assert.ok(!(await call(wang.token, `/api/skills/${pend.skillId}`)).body.canReview, '唯讀 leader 畫面不給核准');

  // N7：管理員（只在平台）看得到、核准得了第二專案的技能
  const bank = (await up(wu.token, '第二專案', skill('bank-tool', [{ path: 'scripts/b.sh', text: 'echo b\n' }]))).body;
  assert.equal(bank.status, 'pending', '第二專案一般成員上傳含腳本的 → 待核准');
  r = await call(boss.token, '/api/projects/第二專案/skills');
  assert.equal(r.status, 200, 'N7 管理員不在專案也能看清單：' + JSON.stringify(r.body));
  assert.ok(r.body.items.some(x => x.name === 'bank-tool' && x.status === 'pending'), '看得到待核准的');
  r = await call(boss.token, `/api/skills/${bank.skillId}`);
  assert.ok(r.status === 200 && r.body.canReview, 'N7 管理員看得到全文、可以核准：' + r.status);
  r = await call(boss.token, `/api/skills/${bank.skillId}/review`, 'POST', { action: 'approve', note: '看過' });
  assert.equal(r.body.status, 'published', 'N7 管理員核准上架：' + JSON.stringify(r.body));
  assert.equal((await call(chen.token, `/api/skills/${bank.skillId}`)).status, 404, '一般成員不在專案還是看不到');
  console.log('skills-review-test：全部通過');
} catch (e) {
  console.error('skills-review-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
