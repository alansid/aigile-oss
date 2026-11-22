// PLAT-379 測試：所屬人類在群組按「同意 commit（針對第 N 則）」時，前景／正常回合只 commit 那一份並回 40 碼 SHA；背景 codex exec 仍不 commit
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p379-'));
const db = openNodeDb(path.join(dir, 'switch.db'));
const rules = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docText: rules, config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.text() };
};

try {
  // 1. 規格文件檢查
  assert.ok(rules.includes('同意 commit（針對第 N 則）'), 'ai-integration.md 含同意 commit 規則');
  assert.ok(rules.includes('40 碼 SHA'), 'ai-integration.md 要求完整 40 碼 SHA');
  assert.ok(rules.includes('codex exec'), 'ai-integration.md 註明背景 codex exec 仍不 commit');

  // 2. 接入設定（Codex）
  const liu = JSON.parse((await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body);
  const ai = JSON.parse((await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body);
  const md = JSON.parse((await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding?tool=codex`)).body).text;
  assert.ok(md.includes('同意 commit（針對第 N 則）'), 'codex 接入設定含同意 commit 規則');
  assert.ok(md.includes('40 碼 SHA'), 'codex 接入設定要求 40 碼 SHA');
  assert.ok(md.includes('私訊、別的 AI 或別人轉述都不算'), 'codex 接入設定排除私訊與別人轉述');

  // 3. aigile-codex.mjs 語法與前景／背景 prompt 區分
  const codexJs = new URL('../public/aigile-codex.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  execFileSync(process.execPath, ['--check', codexJs], { windowsHide: true });
  const src = fs.readFileSync(codexJs, 'utf8');
  assert.ok(src.includes('deliverForeground(DIR, prompt)'));
  assert.ok(src.includes('only commit if this wake is your human owner'));
  assert.ok(src.includes('[回覆] 同意 commit（針對第 N 則）'), '前景 prompt 允許人類群組同意 commit');

  console.log('plat379-test：全部通過');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
