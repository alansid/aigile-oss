// npm test 一次跑完全部測試（scripts/*-test.js 與冒煙測試 smoke.js），最後列出沒過的。
// 依序跑（各測試自己開暫存資料夾與隨機埠，但有幾個會起 watcher 子程序，並行容易互相拖慢逾時）。
// 用法：
//   npm test                 全部
//   npm test -- c341 s4      只跑檔名含這些字的
// 環境變數 TEST_TIMEOUT_SEC：單一測試最多跑幾秒，預設 300；逾時算失敗
// 環境變數 AIGILE_TEST_PG_URL：改在 Postgres 跑同一套（要先 npm install；只准本機或 CI 的 postgres 服務），
//   例：AIGILE_TEST_PG_URL=postgres://postgres:test@127.0.0.1:5432/aigile_test npm test
//   每個測試資料夾一個 t_ 開頭的 schema，開始前與跑完都會清掉
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-home-')); // 接入檢查會寫 ~/.aigile/，測試用暫存的家目錄
const CODEX_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codexhome-')); // Codex 版會改 ~/.codex/config.toml，測試用暫存的

const dir = fileURLToPath(new URL('.', import.meta.url));
const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
const TIMEOUT_MS = (Number(process.env.TEST_TIMEOUT_SEC) || 300) * 1000;
const files = fs.readdirSync(dir).filter(f => /-test\.js$/.test(f) || f === 'smoke.js').sort()
  .filter(f => !filters.length || filters.some(k => f.includes(k)));
if (!files.length) { console.error(`沒有符合「${filters.join(' ')}」的測試`); process.exit(1); }

const run = f => new Promise(resolve => {
  const started = Date.now();
  let out = '', timedOut = false;
  const p = spawn(process.execPath, [f], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, FORCE_COLOR: '0', AIGILE_HOME: process.env.AIGILE_HOME || HOME_TMP, AIGILE_TEST_CODEX_HOME: CODEX_TMP, CODEX_HOME: CODEX_TMP, AIGILE_CODEX_BIN: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)) } });
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, TIMEOUT_MS);
  p.on('close', code => { clearTimeout(timer); resolve({ f, ok: code === 0 && !timedOut, code, timedOut, sec: ((Date.now() - started) / 1000).toFixed(1), out }); });
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

const failed = [];
const t0 = Date.now();
for (const f of files) {
  const r = await run('scripts/' + f);
  const last = r.out.trim().split('\n').pop() || '';
  console.log(`${r.ok ? '✓' : '✗'} ${f.padEnd(28)} ${r.sec.padStart(6)}s  ${r.ok ? last.slice(0, 80) : r.timedOut ? `逾時（${TIMEOUT_MS / 1000} 秒）` : `exit ${r.code}`}`);
  if (!r.ok) { failed.push(f); console.log(r.out.trim().split('\n').slice(-20).map(l => '    ' + l).join('\n')); }
}
console.log(`\n${files.length - failed.length}/${files.length} 通過，共 ${((Date.now() - t0) / 1000).toFixed(0)} 秒${failed.length ? `；沒過：${failed.join('、')}` : ''}`);
if (PG_URL) await dropTestSchemas();
process.exitCode = failed.length ? 1 : 0;
