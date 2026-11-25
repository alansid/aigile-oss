// 驗收測試（開源版）：專案級卡片範本與檢核
// 用法：node scripts/card-templates-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { evaluateTemplateChecks } from '../src/card-templates.js';
import { mcpDispatch } from '../src/mcp.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ctpl-oss-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};

try {
  const admin = (await call(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
  const member = (await call(null, '/api/join', 'POST', { name: '一般成員', role: '業務' })).body;
  assert.equal((await call(admin.token, `/api/participants/${member.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  const ai = (await call(admin.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '開發助手',
    duties: 'd', style: 's', autonomy: 'a', mustConfirm: 'm', handoff: 'h',
  })).body;
  const aiTok = await testToken(db, ai.participantId);
  const pj = encodeURIComponent('預設專案');

  const rAdmin = await call(admin.token, `/api/projects/${pj}/card-templates`);
  assert.equal(rAdmin.status, 200);
  assert.equal(rAdmin.body.canEdit, true);
  assert.deepEqual(rAdmin.body.templates.map(t => t.id), ['builtin_bug', 'builtin_feature']);
  assert.equal((await call(member.token, `/api/projects/${pj}/card-templates`, 'POST', { name: '越權', type: '工作' })).status, 403);
  assert.equal((await call(admin.token, `/api/projects/${pj}/card-templates`, 'POST', { name: '錯', type: '人類紀錄' })).status, 400);

  const created = await call(admin.token, `/api/projects/${pj}/card-templates`, 'POST', {
    name: '客戶需求', type: '工作', titlePrefix: '[需求] ',
    reason: '客戶：\n痛點：', criteria: '交付：',
    checks: [{ field: 'reason', section: '客戶', rule: 'not_empty' }],
  });
  assert.equal(created.status, 201);
  const customId = created.body.template.id;
  assert.equal((await call(admin.token, `/api/projects/${pj}/card-templates/builtin_bug`, 'DELETE')).status, 409);
  assert.equal((await call(admin.token, `/api/projects/${pj}/card-templates/${customId}`, 'DELETE')).status, 409);
  assert.equal((await call(admin.token, `/api/projects/${pj}/card-templates/${customId}`, 'PATCH', { enabled: false })).status, 200);
  assert.equal((await call(admin.token, `/api/projects/${pj}/card-templates/${customId}`, 'DELETE')).status, 200);

  const bugTpl = rAdmin.body.templates.find(t => t.id === 'builtin_bug');
  const chkEn = evaluateTemplateChecks(bugTpl, {
    title: '[Bug] Wrong currency in quote export',
    reason: 'Steps to reproduce:\n1. Open quote Q-1024\n2. Click Export\nExpected: USD\nActual: TWD\nEnvironment: Chrome 131',
    criteria: 'Add a test',
  });
  assert.equal(chkEn.passed, 6);

  const cHuman = await call(member.token, '/api/cards', 'POST', {
    requestId: 'req_ctpl_oss_1',
    project: '預設專案',
    templateId: 'builtin_bug',
    title: '[Bug] 報價單匯出幣別顯示錯',
    reason: '重現步驟：\n1. 開報價單 Q-1024\n預期：USD\n實際：USD\n環境：',
    criteria: '補一個測試',
  });
  assert.equal(cHuman.status, 201);
  assert.equal(cHuman.body.template, '🐞 Bug 回報');
  assert.equal(cHuman.body.templateCheck.failed.length, 3);
  const got = await call(member.token, `/api/cards/${cHuman.body.cardId}`);
  assert.equal(got.body.template, '🐞 Bug 回報');
  assert.ok(got.body.log.some(l => /用「🐞 Bug 回報」建立，略過 3 項檢核：重現步驟、實際、環境/.test(l.text)));

  const aiMe = await db.get('SELECT * FROM participants WHERE id = ?', ai.participantId);
  const mcpCall = async (name, args) => {
    const apiFn = async (method, p, body) => call(aiTok, p, method, body);
    const resp = await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { api: apiFn, me: aiMe });
    return JSON.parse(resp.result.content[0].text);
  };
  const aiCard = await mcpCall('aigile_card_create', {
    project: '預設專案', template: 'Bug report', title: 'Export currency wrong',
    reason: 'Steps to reproduce:\n1. Open quote\nExpected: USD\nActual: TWD\nEnvironment:',
  });
  assert.equal(aiCard.title, '[Bug] Export currency wrong');
  assert.equal(aiCard.template, '🐞 Bug 回報');
  assert.equal(aiCard.failedChecks.length, 2);

  const aiMissing = await mcpCall('aigile_card_create', { project: '預設專案', template: 'nope', title: 'Still creates card' });
  assert.ok(aiMissing.cardId && aiMissing.warnings?.some(w => /找不到範本「nope」/.test(w)));

  console.log('card-templates-test：全部通過');
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
