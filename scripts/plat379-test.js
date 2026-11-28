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
const apiRef = fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docText: rules, config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.text() };
};

try {
  // 1. 規格文件檢查
  assert.ok(rules.includes('同意 commit（針對第 N 則）'), 'ai-integration.md 含同意 commit 規則');
  assert.ok(rules.includes('40 碼 SHA'), 'ai-integration.md 要求完整 40 碼 SHA');
  assert.ok(rules.includes('開源 GitHub 只留 main、不推工作分支；審查範圍照該輪實際存到的差異：開源沒存到只審平台版，僅摘要只核對摘要，送審說明照寫。'), 'ai-integration.md 寫明開源只留 main，審查範圍照該輪實際存到的差異');
  // Codex 不再另開背景回合（codex exec）；真正另開的背景回合（Antigravity agy -p）仍不能 commit
  assert.ok(rules.includes('真正另開的背景回合') && rules.includes('不適用前景授權'), 'ai-integration.md 註明背景回合不適用前景授權（不 commit）');
  assert.match(apiRef, /擋掉 `git commit`／`push`／`merge`/, 'api-reference.md 註明背景回合擋掉 git commit');
  assert.ok(apiRef.includes('依 ai-integration 4.2 執行') && apiRef.includes('真正背景程序維持原限制'), 'api-reference.md 叫醒授權指向 ai-integration 4.2');

  // 2. 接入設定（Codex）
  const liu = JSON.parse((await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body);
  const ai = JSON.parse((await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body);
  const md = JSON.parse((await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding?tool=codex`)).body).text;
  // 接入設定指向規格 4.2（同意 commit 的完整寫法在規格裡），只認所屬人類在群組回覆本則
  assert.ok(md.includes('前景叫醒依規格 4.2'), 'codex 接入設定指向規格 4.2');
  assert.ok(md.includes('所屬人類在群組回覆本則才做'), 'codex 接入設定只認所屬人類在群組回覆（私訊、別人轉述不算）');
  assert.ok(md.includes('開了審查先 commit、推平台工作分支'), 'codex 接入設定：審查通過就 commit');
  assert.ok(md.includes('40 碼 SHA'), 'codex 接入設定要求 40 碼 SHA');

  // 3. aigile-codex.mjs 語法與前景／背景 prompt 區分
  const codexJs = new URL('../public/aigile-codex.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  execFileSync(process.execPath, ['--check', codexJs], { windowsHide: true });
  const src = fs.readFileSync(codexJs, 'utf8');
  assert.ok(src.includes('deliverForeground(DIR, prompt)'));
  assert.ok(src.includes("only when your human owner replies in the group '[回覆] 同意 commit（針對第 N 則）' to your own message"), '前景 prompt 只認所屬人類在群組回覆');
  assert.ok(src.includes('[回覆] 同意 commit（針對第 N 則）'), '前景 prompt 允許人類群組同意 commit');

  console.log('plat379-test：全部通過');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
