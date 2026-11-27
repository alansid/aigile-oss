import { killTree } from './test-process.js';
import { listProcesses, pickLeftovers, stopLeftovers } from './sweep-leftovers.js';
// npm test 一次跑完全部測試（scripts/*-test.js 與冒煙測試 smoke.js），最後列出沒過的。
// 依序跑（各測試自己開暫存資料夾與隨機埠，但有幾個會起 watcher 子程序，並行容易互相拖慢逾時）。
// 用法：
//   npm test                 全部
//   npm test -- c341 s4      只跑檔名含這些字的
//   npm test -- --no-retry   沒過不自動重跑（預設沒過會重跑一次，重跑過了列為「偶發」，結束碼照算失敗）
// 環境變數 TEST_TIMEOUT_SEC：單一測試最多跑幾秒，預設 300；逾時算失敗
// 環境變數 AIGILE_TEST_PG_URL：改在 Postgres 跑同一套（要先 npm install；只准本機或 CI 的 postgres 服務），
//   例：AIGILE_TEST_PG_URL=postgres://postgres:test@127.0.0.1:5432/aigile_test npm test
//   每個測試資料夾一個 t_ 開頭的 schema，開始前與跑完都會清掉
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const RUN_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-run-')); // 這次全套專用的暫存資料夾：測試的暫存檔都放這裡，跑完找殘留程序只認這個資料夾（不會停到別人同時在跑的測試）
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-home-')); // 接入檢查會寫 ~/.aigile/，測試用暫存的家目錄
const CODEX_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codexhome-')); // Codex 版會改 ~/.codex/config.toml，測試用暫存的
const GEMINI_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-geminihome-')); // Antigravity CLI 的 ~/.gemini 也隔離
const COPILOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-copilothome-')); // Copilot CLI 版會改 ~/.copilot/mcp-config.json，也隔離

const dir = fileURLToPath(new URL('.', import.meta.url));
const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
const TIMEOUT_MS = (Number(process.env.TEST_TIMEOUT_SEC) || 300) * 1000;
const NO_RETRY = process.argv.includes('--no-retry'); // 要看第一次就失敗的真實狀況時用
const files = fs.readdirSync(dir).filter(f => /-test\.js$/.test(f) || f === 'smoke.js').sort()
  .filter(f => !filters.length || filters.some(k => f.includes(k)));
if (!files.length) { console.error(`沒有符合「${filters.join(' ')}」的測試`); process.exit(1); }

// run-all 自己與它開過的每支測試（PID → 開始、結束時間），全套跑完用來核對殘留程序是不是這次開的
const roots = new Map([[process.pid, [{ at: Date.now() - process.uptime() * 1000, f: 'run-all' }]]]);
const run = f => new Promise(resolve => {
  const started = Date.now();
  let out = '', timedOut = false;
  const p = spawn(process.execPath, [f], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TEMP: RUN_TMP, TMP: RUN_TMP, TMPDIR: RUN_TMP, FORCE_COLOR: '0', AIGILE_HOME: process.env.AIGILE_HOME || HOME_TMP, AIGILE_TEST_CODEX_HOME: CODEX_TMP, CODEX_HOME: CODEX_TMP, COPILOT_HOME: COPILOT_TMP, AIGILE_TEST_COPILOT_HOME: COPILOT_TMP, AIGILE_TEST_GEMINI_HOME: GEMINI_TMP, AIGILE_GEMINI_HOME: GEMINI_TMP, AIGILE_CODEX_BIN: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), AIGILE_ANTIGRAVITY_BIN: fileURLToPath(new URL('./fake-antigravity.mjs', import.meta.url)) } });
  const root = { at: started, f: f.replace(/^scripts\//, '') };
  if (p.pid) roots.set(p.pid, [...(roots.get(p.pid) || []), root]);
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => { timedOut = true; killTree(p); }, TIMEOUT_MS);
  p.on('close', code => { root.end = Date.now(); clearTimeout(timer); resolve({ f, ok: code === 0 && !timedOut, code, timedOut, sec: ((Date.now() - started) / 1000).toFixed(1), out }); });
});

// Postgres 模式：清掉上次留下的測試 schema（只動 t_ 加 20 碼的）
const PG_URL = process.env.AIGILE_TEST_PG_URL;
async function dropTestSchemas() {
  const { assertTestPgUrl } = await import('../src/db-pg.js');
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: assertTestPgUrl(PG_URL) });
  await c.connect();
  try {
    const { rows } = await c.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^t_[0-9a-f]{20}$'");
    for (const r of rows) await c.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  } finally { await c.end(); }
}
if (PG_URL) { await dropTestSchemas(); console.log('資料庫：Postgres（AIGILE_TEST_PG_URL）\n'); }

const failed = [], flaky = [];
const t0 = Date.now();
for (const f of files) {
  let r = await run('scripts/' + f);
  const last = r.out.trim().split('\n').pop() || '';
  // 沒過先自動重跑一次；重跑過了算「偶發」（另外列出、結束碼照算失敗），才看得出哪些是時好時壞
  let retried = null;
  if (!r.ok && !NO_RETRY) { retried = r; r = await run('scripts/' + f); }
  const shown = retried || r, flake = retried && r.ok;
  console.log(`${r.ok ? (flake ? '⟳' : '✓') : '✗'} ${f.padEnd(28)} ${shown.sec.padStart(6)}s  ${r.ok && !flake ? last.slice(0, 80) : shown.timedOut ? `逾時（${TIMEOUT_MS / 1000} 秒）` : `exit ${shown.code}`}${flake ? `　→ 重跑通過（${r.sec}s），偶發` : ''}`);
  if (!r.ok || flake) console.log(shown.out.trim().split('\n').slice(-20).map(l => '    ' + l).join('\n'));
  if (flake) flaky.push(f); else if (!r.ok) failed.push(f);
}
const left = await sweepLeftovers(t0);
console.log(`\n${files.length - failed.length - flaky.length}/${files.length} 通過，共 ${((Date.now() - t0) / 1000).toFixed(0)} 秒${failed.length ? `；沒過：${failed.join('、')}` : ''}${flaky.length ? `；偶發（重跑才過）：${flaky.join('、')}` : ''}${left}`);
if (PG_URL) await dropTestSchemas();
process.exitCode = failed.length || flaky.length ? 1 : 0;

// 全套期間開出來卻沒關掉的程序：從程序樹核對得出是這次全套開的才用 PID 停掉，停完再確認；
// 對不上來源、但指令帶這次暫存資料夾的只列出不停（可能是別人同時在跑的東西）
async function sweepLeftovers(since) {
  const list = listProcesses();
  try {
    if (!list) { console.log(`  ⚠ 讀不到程序清單（${listProcesses.error}），沒檢查殘留程序`); return ''; }
    const { owned, unsure } = pickLeftovers(list, { since, roots, tmp: RUN_TMP });
    for (const p of owned) console.log(`  ⚠ ${p.f} 留下程序 ${p.pid}：${p.cmd.slice(0, 120)}`);
    for (const p of unsure) console.log(`  ? 對不上來源的程序 ${p.pid}${p.f ? `（父程序已結束，可能是 ${p.f} 的）` : ''}（沒停）：${p.cmd.slice(0, 120)}`);
    const { stopped, skipped, failed: stuck } = stopLeftovers(owned);
    for (const p of skipped) console.log(`  ? 程序 ${p.pid} 要停時 PID 已換成別的程序（沒停）`);
    for (const p of stuck) console.log(`  ✗ 停不掉程序 ${p.pid}（${p.why}）`);
    return [owned.length && `；測試留下的程序 ${owned.length} 個（已停 ${stopped.length}${skipped.length ? `、PID 已換人沒停 ${skipped.length}` : ''}${stuck.length ? `、停不掉 ${stuck.length}` : ''}）`, unsure.length && `；對不上來源的程序 ${unsure.length} 個（只列出）`].filter(Boolean).join('');
  } finally {
    try { fs.rmSync(RUN_TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
