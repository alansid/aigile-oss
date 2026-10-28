// 驗收測試：技能包整包上傳（Claude Code 外掛，一包多個技能），裝成外掛給指定 AI 選用
// 修正前：一次只收一個技能（1 MB、100 檔、最上層要 SKILL.md），整包過不了；拆成單一技能會斷掉互相叫用
// 測：認得技能包（.claude-plugin/plugin.json）、上限（文字 5 MB、800 檔；單一技能維持 1 MB、100 檔）、
//     超過 2 MB 的包拆存（skills.files 只存小清單，本體在分塊儲存）、腳本分「會執行的」與測試資料、
//     同步裝到 .aigile/<代號>/plugins/<名稱>/ 並印絕對路徑的啟動參數、Codex 不裝、下架移除、只發給指定的 AI、規格 3.16
// 用法：node scripts/skill-pack-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { canonical, isScript, runsScript } from '../src/skills.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
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

// 小的技能包：兩個技能（b 叫用 a）、一個 agent、一個會執行的腳本、一個測試資料
const pack = (name = 'demo-pack', extra = []) => [
  { path: '.claude-plugin/plugin.json', text: JSON.stringify({ name, description: '示範技能包' }) },
  { path: 'skills/alpha/SKILL.md', text: '---\nname: alpha\ndescription: 第一個\n---\nalpha 規則\n' },
  { path: 'skills/beta/SKILL.md', text: '---\nname: beta\ndescription: 第二個\n---\n讀 <pack>/skills/alpha/SKILL.md 照做\n' },
  { path: 'skills/beta/scripts/run.mjs', text: '#!/usr/bin/env node\n// 把清單排好印出來\nconsole.log(1)\n' },
  { path: 'skills/beta/scripts/test/corpus/case.out', text: '測試資料\n' },
  { path: 'agents/helper.md', text: '---\nname: helper\n---\n幫手\n' },
  ...extra];

try {
  // 0. 腳本分類
  assert.ok(isScript('skills/beta/scripts/test/corpus/case.out') && !runsScript('skills/beta/scripts/test/corpus/case.out'), '測試資料算腳本、不算會執行的');
  assert.ok(isScript('skills/beta/scripts/run.mjs') && runsScript('skills/beta/scripts/run.mjs'), '會執行的');
  assert.ok(!runsScript('skills/x/scripts/foo.test.ts') && !runsScript('skills/x/tests/a.py'), '測試檔不算會執行的');
  assert.ok(isScript('scripts/run.sh') && !isScript('docs/readme.md'), '單一技能照舊');

  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const mkAi = async (name, roleKey) => {
    const r = await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
    const row = await db.get('SELECT token, code FROM participants WHERE id = ?', r.body.participantId);
    return { id: r.body.participantId, tok: r.body.token, ag: `${roleKey}_${row.code}` };
  };
  const pg = await mkAi('程式助手', 'PG'), po = await mkAi('產品助手', 'PO');
  const up = (files, target = { aiIds: [pg.id] }) => call(boss.token, '/api/projects/預設專案/skills', 'POST', { files, ...target });

  // 1. 認得技能包：名稱看 plugin.json、技能與 agent 數、腳本分類；含腳本 → 管理員上傳直接上架
  let r = await up(pack());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.kind, r.body.name, r.body.description, r.body.status], ['pack', 'demo-pack', '示範技能包', 'published']);
  assert.deepEqual(r.body.pack, { skills: 2, agents: 1, files: 6, runs: 1 }, '技能 2、agent 1、檔 6、會執行的腳本 1');
  assert.equal(r.body.scripts, 2, '腳本 2 個（會執行的 1、測試資料 1）');
  const demoId = r.body.skillId;
  // 只發給指定的 AI
  const items = async ai => (await call(ai.tok, '/api/me/skills')).body.items;
  assert.deepEqual((await items(pg)).map(x => [x.name, x.kind, x.own]), [['demo-pack', 'pack', true]], 'PG 拿到技能包（一律裝自己的代號資料夾）');
  assert.deepEqual(await items(po), [], 'PO 拿不到');

  // 2. 檢查
  assert.equal((await up(pack('Bad_Name'))).status, 400, 'plugin.json 的 name 要合規則');
  assert.equal((await up([{ path: '.claude-plugin/plugin.json', text: '{壞掉' }, { path: 'skills/a/SKILL.md', text: 'x' }])).status, 400, 'plugin.json 要是 JSON');
  assert.equal((await up([{ path: '.claude-plugin/plugin.json', text: '{"name":"empty-pack"}' }, { path: 'README.md', text: 'x' }])).status, 400, '沒有技能');
  const many = Array.from({ length: 800 }, (_, i) => ({ path: `skills/alpha/ref/f${i}.md`, text: 'x' }));
  assert.equal((await up(pack('many-pack', many))).status, 400, '超過 800 個檔');
  assert.match((await up(pack('many-pack', many.slice(0, 790)))).body.error?.message || 'ok', /ok/, '800 個檔內可以');
  const big = Array.from({ length: 6 }, (_, i) => ({ path: `skills/alpha/ref/big${i}.md`, text: 'a'.repeat(900 * 1024) }));
  assert.equal((await up(pack('huge-pack', big))).status, 400, '文字超過 5 MB');
  const single = Array.from({ length: 101 }, (_, i) => ({ path: `ref/f${i}.md`, text: 'x' }));
  assert.equal((await up([{ path: 'SKILL.md', text: '---\nname: one\ndescription: x\n---\n' }, ...single])).status, 400, '單一技能維持 100 檔');

  // 3. 超過 D1 單列 2 MB 的包：本體拆存在分塊儲存，skills.files 只存小清單；AI 下載拿得到完整檔案、雜湊對得上
  const mid = Array.from({ length: 4 }, (_, i) => ({ path: `skills/alpha/ref/mid${i}.md`, text: `第 ${i} 份\n` + 'b'.repeat(800 * 1024) }));
  r = await up(pack('mid-pack', mid));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await db.get('SELECT files, size FROM skills WHERE id = ?', r.body.skillId);
  assert.ok(row.files.length < 2000 && row.size > 3 * 1024 * 1024, `files 欄只存小清單（${row.files.length} 字），內容 ${(row.size / 1048576).toFixed(1)} MB`);
  const chunks = await db.get('SELECT COUNT(*) AS n, MAX(LENGTH(data)) AS mx FROM file_chunks WHERE file_id = ?', JSON.parse(row.files).pack.key);
  assert.ok(chunks.n >= 7 && chunks.mx <= 512 * 1024, `分塊存（${chunks.n} 塊，每塊 ≤ 512 KB）`);
  await call(boss.token, `/api/my-ais/${pg.id}/skills/${r.body.skillId}`, 'PUT', { allow: true }); // 含腳本要主人允許才能下載
  const dl = (await call(pg.tok, `/api/me/skills/${r.body.skillId}/files`)).body;
  assert.equal(dl.files.length, 10, '下載拿到全部檔案');
  assert.equal(crypto.createHash('sha256').update(canonical(dl.files)).digest('hex'), dl.sha256, '雜湊對得上');
  const det = (await call(boss.token, `/api/skills/${r.body.skillId}`)).body;
  assert.deepEqual([det.kind, det.files.length], ['pack', 10], '技能詳情讀得到技能包的檔案');
  const lib = (await call(boss.token, '/api/skills')).body.items.find(s => s.name === 'mid-pack');
  assert.deepEqual([lib.kind, lib.pack.skills], ['pack', 2], '技能清單標技能包（不讀整包）');
  for (const n of ['mid-pack', 'many-pack']) await call(boss.token, `/api/projects/預設專案/skills/${n}/remove`, 'POST');

  // 4. 同步：主人允許（含腳本）→ 裝到 .aigile/<代號>/plugins/<名稱>/，印絕對路徑的啟動參數；不在共用區
  await call(boss.token, `/api/my-ais/${pg.id}/skills/${demoId}`, 'PUT', { allow: true });
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, `.aigile/${pg.ag}`), { recursive: true }); fs.writeFileSync(path.join(wd, `.aigile/${pg.ag}/.token`), pg.tok);
  const plug = path.join(wd, `.aigile/${pg.ag}/plugins`);
  let o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  for (const f of ['.claude-plugin/plugin.json', 'skills/alpha/SKILL.md', 'skills/beta/SKILL.md', 'skills/beta/scripts/run.mjs', 'agents/helper.md']) assert.ok(fs.existsSync(path.join(plug, 'demo-pack', f)), '裝好 ' + f);
  assert.ok(!fs.existsSync(path.join(wd, '.claude/skills/demo-pack')), '不在共用區');
  const abs = path.resolve(plug);
  assert.ok(o.out.includes(`claude --plugin-dir "${abs}"`), '印絕對路徑的啟動參數：' + o.out);
  const state = (await call(boss.token, `/api/my-ais/${pg.id}/skills`)).body.items.find(x => x.name === 'demo-pack');
  assert.equal(state.state, 'latest', '同步清單顯示最新（裝在自己的代號資料夾，不是「要處理」）');
  // 再同步一次：沒有新版就不重裝（技能包最上層沒有 SKILL.md，不能用它判斷裝好了）
  const mark0 = fs.statSync(path.join(plug, 'demo-pack', '.aigile-skill.json')).mtimeMs;
  o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /新裝 0、更新 0、移除 0/, '沒有新版不重裝：' + o.out);
  assert.equal(fs.statSync(path.join(plug, 'demo-pack', '.aigile-skill.json')).mtimeMs, mark0, '檔案沒被重寫');

  // 5. Codex 先不支援：不裝、說明原因
  const wd2 = fs.mkdtempSync(path.join(dataDir, 'w2-'));
  fs.mkdirSync(path.join(wd2, `.aigile/${pg.ag}`), { recursive: true }); fs.writeFileSync(path.join(wd2, `.aigile/${pg.ag}/.token`), pg.tok);
  o = await run(wd2, ['--agent', pg.ag, '--base', BASE, '--tool', 'codex', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /demo-pack（技能包，codex 先不支援，沒裝）/);
  assert.ok(!fs.existsSync(path.join(wd2, `.aigile/${pg.ag}/plugins`)), 'Codex 沒裝');

  // 6. 下架 → 同步後移除
  await call(boss.token, '/api/projects/預設專案/skills/demo-pack/remove', 'POST');
  o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.ok(!fs.existsSync(path.join(plug, 'demo-pack')), '下架後移除');

  // 7. 規格 3.16
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /\*\*技能包\*\*（最上層有 `\.claude-plugin\/plugin\.json`）裝 `\.aigile\/<代號>\/plugins\/<名稱>\/`，用 `claude --plugin-dir <絕對路徑>` 啟動才載入/, '規格寫技能包');
  assert.match(spec, /會寫使用者層級設定（`~\/\.claude` 等）的技能可以留在包裡，但不要執行/, '規格寫會寫使用者層級設定的技能不要執行（使用者 10/27 選 A）');
  assert.ok([...spec].length <= 20000, '規格 2 萬字內');
  console.log('skill-pack-test：全部通過');
} catch (e) {
  console.error('skill-pack-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  server.close();
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
