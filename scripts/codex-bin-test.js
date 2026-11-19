// 重現測試：Codex 喚醒腳本找 codex 的順序跟一行啟動、接入檢查不同
// 修正前：aigile-codex.mjs 只看 CODEX_BIN，只設 AIGILE_CODEX_BIN 時前景用指定的 codex、背景叫醒卻跑到 PATH 上真的 codex
// 修正後：三支都是 AIGILE_CODEX_BIN → CODEX_BIN → codex；.mjs／.js 用 node 跑
// 用法：node scripts/codex-bin-test.js（只用假的 codex，不跑真的 Codex）
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CX = fileURLToPath(new URL('../public/aigile-codex.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codex-bin-'));
const wake = env => new Promise(r => execFile(process.execPath, [CX, '--agent', 'PG_T', '--mode', 'fresh'], { cwd: dir, timeout: 60_000,
  env: { ...process.env, CODEX_BIN: '', AIGILE_CODEX_BIN: '', CODEX_HOME: path.join(dir, 'codex-home'), PATH: path.join(dir, 'empty-path'), ...env } }, (e, out, err) => r({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
try {
  fs.mkdirSync(path.join(dir, '.aigile', 'PG_T'), { recursive: true });
  const log = path.join(dir, 'fake.log');
  // 只設 AIGILE_CODEX_BIN（一行啟動、接入檢查用的名字）：喚醒腳本也要用它
  let r = await wake({ AIGILE_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, FAKE_CODEX_THREAD: '01a1f18c-0000-4000-8000-000000000001' });
  assert.ok(fs.existsSync(log), '叫到 AIGILE_CODEX_BIN 指定的 codex：' + r.out.slice(-300));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(calls.some(a => a[0] === 'exec'), '用 codex exec 跑一輪：' + JSON.stringify(calls));
  // 兩個都設：AIGILE_CODEX_BIN 優先（跟 aigile-start.mjs 同一個順序）
  const log2 = path.join(dir, 'fake2.log');
  fs.rmSync(path.join(dir, '.aigile', 'PG_T', 'codex.json'), { force: true });
  r = await wake({ AIGILE_CODEX_BIN: FAKE, CODEX_BIN: path.join(dir, 'not-here.mjs'), FAKE_CODEX_LOG: log2, FAKE_CODEX_THREAD: '01a1f18c-0000-4000-8000-000000000002' });
  assert.ok(fs.existsSync(log2), 'AIGILE_CODEX_BIN 優先於 CODEX_BIN：' + r.out.slice(-300));
  // 三支腳本的寫法一致
  for (const f of ['aigile-codex.mjs', 'aigile-start.mjs']) {
    const src = fs.readFileSync(fileURLToPath(new URL('../public/' + f, import.meta.url)), 'utf8');
    assert.ok(src.includes("process.env.AIGILE_CODEX_BIN || process.env.CODEX_BIN || 'codex'"), f + '：AIGILE_CODEX_BIN → CODEX_BIN → codex');
  }
  console.log('codex-bin-test：全部通過');
} catch (e) {
  console.error('codex-bin-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
