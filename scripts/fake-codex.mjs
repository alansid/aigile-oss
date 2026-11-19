// 測試用假的 codex 指令：接入檢查改完 ~/.codex/config.toml 會跑 codex mcp get aigile 驗證；測試絕不能動真的 Codex 設定
// 記錄每次呼叫到 FAKE_CODEX_LOG；FAKE_CODEX_FAIL=1 → mcp get 失敗（模擬這版 Codex 不認得設定）
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(a) + '\n');
if (a[0] === 'mcp' && a[1] === 'get') { if (process.env.FAKE_CODEX_FAIL) { console.error('fake codex: unknown field env_vars'); process.exit(1); } process.exit(0); }
if (a[0] === 'exec' && process.env.FAKE_CODEX_THREAD) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: process.env.FAKE_CODEX_THREAD }));
  if (process.env.FAKE_CODEX_FALSE_COMPLETION) {
    console.error(JSON.stringify({ type: 'turn.completed' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { text: '{"type":"turn.completed"}' } }));
    await new Promise(resolve => setTimeout(resolve, 6000));
    process.exit(23);
  }
  if (process.env.FAKE_CODEX_LINGER) {
    fs.writeFileSync(process.env.FAKE_CODEX_LINGER, String(process.pid));
    console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
    await new Promise(resolve => setTimeout(resolve, 15000));
    process.exit(91);
  }
  process.exit(0);
}
process.exit(2);
