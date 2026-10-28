// 驗收測試：技能「發給誰」可選所有 AI／指定角色（含 SA 與專案自訂角色）／指定 AI，上架後可改、不用重傳
// 修正前：只能選固定 8 種角色（沒有 SA、沒有專案自訂角色），不能指定哪幾隻 AI，改發給誰要重傳
// 測：可選角色、上傳時三種發給誰、輸入檢查、改發給誰（權限、不升版、通知新加與被拿掉的主人）、
//     五處用同一個判斷（安裝、私訊主人、待允許數、安裝統計、同名檢查）、AI 移出專案或停用就不發、
//     安裝位置（指定 → 代號資料夾；改回所有 AI → 搬回共用區，不兩邊都留）、規格 3.16
// 用法：node scripts/skill-target-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { targetOf, encTarget } from '../src/skills.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, args) => new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), ...args], { cwd, env: { ...process.env, AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: '', AIGILE_CLAUDE_BIN: fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)) } }, (e, out) => ok({ code: e ? e.code : 0, out })));
const skill = (name, extra = []) => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${name} 的規則\n` }, ...extra];

try {
  // 0. 解析：舊資料是陣列，新的指定 AI 是 {"ais":[…]}
  assert.deepEqual(targetOf({ roles: '["PG","QA"]' }), { roles: ['PG', 'QA'], ais: [] }, '舊陣列＝指定角色');
  assert.deepEqual(targetOf({ roles: '[]' }), { roles: [], ais: [] }, '空陣列＝所有 AI');
  assert.deepEqual(targetOf({ roles: '{"ais":["p_b","p_a"]}' }), { roles: [], ais: ['p_b', 'p_a'] }, '物件＝指定 AI');
  assert.deepEqual(targetOf({ roles: '壞掉' }), { roles: [], ais: [] }, '壞資料當所有 AI');
  assert.equal(encTarget({ roles: ['QA', 'PG'], ais: [] }), '["PG","QA"]', '指定角色照舊存陣列');
  assert.equal(encTarget({ roles: [], ais: ['p_b', 'p_a'] }), '{"ais":["p_a","p_b"]}');

  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body; // 一般成員
  await call(boss.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  // 平台的自訂角色「營養顧問」（NUT）
  await db.run("INSERT INTO app_settings (key, value) VALUES ('roles:預設專案', ?)", JSON.stringify([{ key: 'NUT', role: '營養顧問', status: 'active', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }]));
  const mkAi = async (owner, name, roleKey) => {
    const r = await call(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
    assert.ok(r.body.participantId, name + '：' + JSON.stringify(r.body));
    const row = await db.get('SELECT token, code FROM participants WHERE id = ?', r.body.participantId);
    return { id: r.body.participantId, tok: r.body.token, ag: `${roleKey}_${row.code}`, owner };
  };
  const pg = await mkAi(boss, '程式助手', 'PG'), po = await mkAi(boss, '產品助手', 'PO'), sa = await mkAi(boss, '系統分析助手', 'SA'), nut = await mkAi(wang, '營養助手', 'NUT');
  const mine = async ai => (await call(ai.tok, '/api/me/skills')).body.items.map(x => x.name).sort();
  const up = (who, name, target, extra) => call(who.token, '/api/projects/預設專案/skills', 'POST', { files: skill(name, extra), ...target });
  const setTo = (who, name, target) => call(who.token, `/api/projects/預設專案/skills/${name}/target`, 'PUT', target);
  const dms = async (owner, re) => (await db.all("SELECT text FROM dms WHERE human_id = ? AND text LIKE '%' || ? || '%'", owner.participant.participantId, re)).length;

  // 1. 可選的角色：平台角色（含 SA）＋專案自訂角色；畫面要的 AI 清單
  const lib = (await call(boss.token, '/api/skills')).body;
  const pj = lib.projects.find(p => p.id === '預設專案');
  assert.ok(pj.roles.some(o => o.key === 'SA') && pj.roles.some(o => o.key === 'NUT' && o.label === '營養顧問' && o.custom), '角色清單有 SA 和專案自訂角色：' + JSON.stringify(pj.roles.map(o => o.key)));
  assert.deepEqual(pj.ais.map(a => a.name).sort(), ['產品助手', '程式助手', '系統分析助手', '營養助手'].sort(), '列這個專案的 AI');

  // 2. 上傳：所有 AI／指定角色（SA、自訂角色）／指定 AI
  assert.equal((await up(boss, 'all-tool', {})).status, 201);
  assert.equal((await up(boss, 'sa-rules', { roles: ['SA'] })).status, 201, '可以指定 SA');
  assert.equal((await up(boss, 'nut-rules', { roles: ['NUT'] })).status, 201, '可以指定專案自訂角色');
  let r = await up(boss, 'pg-only', { aiIds: [pg.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.aiIds, r.body.roles, r.body.ais.map(a => a.name)], [[pg.id], [], ['程式助手']], '回應帶指定的 AI');
  assert.deepEqual(await mine(pg), ['all-tool', 'pg-only']);
  assert.deepEqual(await mine(sa), ['all-tool', 'sa-rules']);
  assert.deepEqual(await mine(nut), ['all-tool', 'nut-rules']);
  assert.deepEqual(await mine(po), ['all-tool'], 'PO 拿不到指定給別人的');
  const meItem = (await call(pg.tok, '/api/me/skills')).body.items;
  assert.deepEqual(meItem.map(x => [x.name, x.own, x.to]), [['all-tool', false, 'all'], ['pg-only', true, 'ais']], '/api/me/skills 帶 own（有指定＝裝代號資料夾）與 to');

  // 3. 輸入檢查
  assert.equal((await up(boss, 'bad-1', { roles: ['XYZ'] })).status, 400, '沒有這個角色');
  assert.equal((await up(boss, 'bad-2', { roles: ['PG'], aiIds: [pg.id] })).status, 400, '角色和 AI 只能擇一');
  assert.equal((await up(boss, 'bad-3', { aiIds: [wang.participant.participantId] })).status, 400, '人類不能當 AI 選');
  assert.equal((await up(boss, 'bad-4', { aiIds: ['p_nobody'] })).status, 400, '不存在的 AI');
  assert.equal((await up(boss, 'pg-only', { aiIds: [pg.id] })).body.error?.code, 'SAME_CONTENT', '內容和發給誰都一樣：不用重傳');

  // 4. 改發給誰：只有 leader／管理員；不升版本；新加的主人收到「也發給」、被拿掉的收到「不再發給」
  assert.equal((await setTo(wang, 'pg-only', { aiIds: [nut.id] })).status, 403, '一般成員不能改');
  r = await setTo(boss, 'pg-only', { aiIds: [nut.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, 1, '不升版本');
  assert.deepEqual(r.body.aiIds, [nut.id]);
  assert.deepEqual(await mine(pg), ['all-tool'], '被拿掉的 AI 不再拿到');
  assert.deepEqual(await mine(nut), ['all-tool', 'nut-rules', 'pg-only'], '新加的 AI 拿到');
  assert.ok(await dms(wang, '現在也發給你的 1 隻 AI') >= 1, '新加 AI 的主人收到通知');
  assert.ok(await dms(boss, '不再發給你的 1 隻 AI') >= 1, '被拿掉 AI 的主人收到通知');
  assert.equal((await setTo(boss, 'nope', {})).status, 404, '沒有這個技能');
  assert.equal((await setTo(boss, 'pg-only', { roles: ['XYZ'] })).status, 400, '改的時候也檢查角色');

  // 5. 待允許數、安裝統計：含腳本的技能只指定給 SA
  assert.equal((await up(boss, 'sa-script', { aiIds: [sa.id] }, [{ path: 'scripts/run.sh', text: 'echo hi\n' }])).status, 201);
  const stat = (await call(boss.token, '/api/skills')).body.items.find(s => s.name === 'sa-script').install;
  assert.deepEqual([stat.target, stat.waitingOwner], [1, 1], '安裝統計只算指定的那隻');
  const myAis = (await call(boss.token, '/api/my-ais')).body.items;
  const wait = id => myAis.find(a => a.participantId === id)?.skillsWaiting;
  assert.deepEqual([wait(sa.id), wait(pg.id)], [1, 0], '待允許數只算指定的那隻');
  const det = (await call(boss.token, `/api/skills/${(await call(boss.token, '/api/skills')).body.items.find(s => s.name === 'sa-script').skillId}`)).body;
  assert.deepEqual(det.installs.map(a => a.name), ['系統分析助手'], '技能詳情的「裝到哪些 AI」只列指定的');

  // 6. AI 移出專案、停用：就不再發給它（名單還在也不發）
  r = await call(boss.token, `/api/my-ais/${sa.id}`, 'PATCH', { projects: ['第二專案'] }); // 換到別的專案
  assert.equal(r.status, 200, '主人把 AI 移出專案：' + JSON.stringify(r.body));
  assert.deepEqual(await mine(sa), [], '移出專案就拿不到（名單裡還有它）');
  const skId = name => db.get("SELECT id FROM skills WHERE name = ? AND status = 'published'", name).then(x => x.id);
  const view2 = (await call(boss.token, `/api/skills/${await skId('sa-script')}`)).body;
  assert.equal(view2.installs.length, 0, '移出專案的 AI 不算在裝到哪些 AI');
  assert.ok(view2.ais[0].gone, '詳情標出已不在專案');
  assert.equal((await call(wang.token, `/api/my-ais/${nut.id}/disable`, 'POST')).status, 200, '停用');
  const stat2 = (await call(boss.token, '/api/skills')).body.items.find(s => s.name === 'pg-only').install;
  assert.equal(stat2.target, 0, '停用的 AI 不再算');
  assert.equal((await call(wang.token, `/api/my-ais/${nut.id}/enable`, 'POST')).status, 200, '啟用');

  // 7. 安裝位置：指定 → 代號資料夾；改回所有 AI → 搬回共用區（不兩邊都留）；再改回指定 → 搬回代號資料夾
  assert.equal((await setTo(boss, 'pg-only', { aiIds: [pg.id] })).status, 200);
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, `.aigile/${pg.ag}`), { recursive: true }); fs.writeFileSync(path.join(wd, `.aigile/${pg.ag}/.token`), pg.tok);
  const shared = n => path.join(wd, '.claude/skills', n, 'SKILL.md'), own = n => path.join(wd, `.aigile/${pg.ag}/skills`, n, 'SKILL.md');
  const sync = async () => { const o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--tool', 'claude', '--skills-only']); assert.equal(o.code, 0, o.out); return o.out; };
  await sync();
  assert.ok(fs.existsSync(own('pg-only')) && !fs.existsSync(shared('pg-only')), '指定 AI → 代號資料夾');
  assert.ok(fs.existsSync(shared('all-tool')) && !fs.existsSync(own('all-tool')), '所有 AI → 共用區');
  const place = async () => (await db.all('SELECT i.place, s.name FROM skill_installs i JOIN skills s ON s.id = i.skill_id WHERE i.ai_id = ? ORDER BY s.name', pg.id)).map(x => `${x.name}:${x.place}`);
  assert.deepEqual(await place(), ['all-tool:shared', 'pg-only:own']);
  assert.equal((await setTo(boss, 'pg-only', {})).status, 200, '改成所有 AI');
  await sync();
  assert.ok(fs.existsSync(shared('pg-only')) && !fs.existsSync(path.dirname(own('pg-only'))), '改回所有 AI → 搬回共用區，代號資料夾那份拿掉');
  // 清單弄丟也一樣：只看自己裝的標記
  fs.rmSync(path.join(wd, `.aigile/${pg.ag}/skills.json`));
  assert.equal((await setTo(boss, 'pg-only', { roles: ['PG'] })).status, 200, '改成指定角色');
  await sync();
  assert.ok(fs.existsSync(own('pg-only')) && !fs.existsSync(path.dirname(shared('pg-only'))), '再改回指定 → 搬回代號資料夾、共用區那份拿掉（清單弄丟也搬）');
  assert.deepEqual(await place(), ['all-tool:shared', 'pg-only:own']);

  // 8. 我的 AI › 技能 看得到發給誰
  const maSk = (await call(boss.token, `/api/my-ais/${pg.id}/skills`)).body.items;
  assert.deepEqual(maSk.map(x => [x.name, x.to]), [['all-tool', 'all'], ['pg-only', 'roles']], '我的 AI 看得到發給誰');

  // 9. 規格 3.16
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /可指定給哪些角色或哪幾隻 AI/, '規格寫可指定 AI');
  assert.match(spec, /有指定的一律裝 `\.aigile\/<代號>\/skills\/<名稱>\/`/, '規格寫有指定的裝代號資料夾');
  assert.ok([...spec].length <= 20000, '規格 2 萬字內');
  console.log('skill-target-test：全部通過');
} catch (e) {
  console.error('skill-target-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  server.close();
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
