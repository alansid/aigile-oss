// 前景啟動器與接入檢查沿用指定的 Codex；關窗的門鈴不啟動它
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
  const result = await wake({ AIGILE_CODEX_BIN: FAKE, CODEX_BIN: FAKE, FAKE_CODEX_LOG: log });
  assert.equal(result.code, 1);
  assert.match(result.out, /視窗沒開/);
  assert.equal(fs.existsSync(log), false, 'closed session never launches the configured binary');
  for (const f of ['aigile-start.mjs']) {
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
