// 接入設定的門鈴說明（PLAT-308，UX msg_ViS6Vez3n8YXNkYj）
// 修正前：Cloudflare 版用 Supabase 送門鈴，AI 跑在有網路白名單的雲端環境時被擋，只能巡檢、慢 10～15 分鐘，接入設定沒提
// 修正後：有設 Supabase → 寫「雲端環境要放行 <Supabase 網域>」；本機／Docker 內建即時通道 → 寫幾秒內就醒、不提 Supabase；
//         都沒設 → 寫每 15 分鐘巡檢。Codex 版沒有 watcher，不寫門鈴那句
// 用法：node scripts/onboard-realtime-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dirs = [];
async function onboarding(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-bell-')); dirs.push(dataDir);
  const db = openNodeDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', ...extra, config: { openJoin: '1', rateLimitPerMin: '100000', ...(extra.config || {}) } });
  const call = async (token, p, method = 'GET', body) => (await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost')).json();
  const boss = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  const ai = await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const get = async tool => (await call(boss.token, `/api/my-ais/${ai.participantId}/onboarding?tool=${tool}`)).text;
  return { claude: await get('claude'), other: await get('other'), codex: await get('codex') };
}

try {
  // Cloudflare 版設了 Supabase：Claude Code、其他工具（opencode）都寫要放行哪個網域
  const sb = await onboarding({ config: { supabaseUrl: 'https://abcdefgh.supabase.co/', supabaseKey: 'k' } });
  for (const t of ['claude', 'other']) {
    assert.match(sb[t], /跑在雲端環境（有網路白名單）要放行 abcdefgh\.supabase\.co，不然收不到即時門鈴，只能靠巡檢、會慢 10～15 分鐘/, `${t}：Supabase 網域要放行`);
  }
  assert.ok(!/supabase/i.test(sb.codex), 'Codex 版沒有 watcher，不寫 Supabase');
  // 本機／Docker 內建即時通道：幾秒內就醒，不提 Supabase
  const live = await onboarding({ live: { fake: true } });
  assert.match(live.claude, /平台內建即時通道，被指定幾秒內就醒/);
  assert.ok(!/supabase/i.test(live.claude), '內建即時通道不提 Supabase');
  // 都沒設：每 15 分鐘巡檢
  const none = await onboarding({});
  assert.match(none.claude, /平台未設定即時通道：每 15 分鐘巡檢/);
  // 規格與說明文件（中英）也寫了
  const read = f => fs.readFileSync(new URL('../docs/' + f, import.meta.url), 'utf8');
  assert.match(read('ai-integration.md'), /有網路白名單的雲端環境要放行 Supabase 網域/);
  assert.match(read('connect-your-ai.md'), /被 @ 之後 AI 要 10～15 分鐘才醒/);
  assert.match(read('connect-your-ai.en.md'), /The AI takes 10–15 minutes to wake after a mention/);
  console.log('onboard-realtime-test：全部通過');
} catch (e) {
  console.error('onboard-realtime-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}
