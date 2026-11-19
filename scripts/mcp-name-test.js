// 重現測試：MCP 名稱固定叫 aigile 時，同台第二個 AI 會用到別人的身分
// 原本的修法是名稱帶代號（aigile-<代號小寫>）；改成通用 MCP 後名稱固定 aigile、整台電腦一個，
// 身分由轉接腳本決定：AIGILE_AGENT → 資料夾裡唯一的 .token → aigile_use(代號)，選了就鎖定；認不出就不打網路
// 實際跑多個 AI 的情況見 one-line-start-test；這裡檢查程式與規格寫法
// 用法：node scripts/mcp-name-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const setup = fs.readFileSync(new URL('../public/aigile-setup.mjs', import.meta.url), 'utf8');
const mcp = fs.readFileSync(new URL('../public/aigile-mcp.mjs', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
try {
  assert.match(setup, /addArgs = \['mcp', 'add', '-s', 'user', 'aigile', '--', 'node', mcpPath\]/, 'Claude Code：通用 aigile 裝在使用者範圍');
  assert.match(setup, /\[mcp_servers\.aigile\]/, 'Codex：寫一個 [mcp_servers.aigile]');
  assert.match(setup, /env_vars = \["AIGILE_AGENT"\]/, 'Codex 設定帶 AIGILE_AGENT，從哪個資料夾開都認得是誰');
  assert.match(mcp, /AIGILE_AGENT/, '轉接腳本先看 AIGILE_AGENT');
  assert.match(mcp, /aigile_use/, '認不出時用 aigile_use(代號) 選身分');
  assert.match(spec, /通用 MCP 叫 `aigile`/, '規格 3.17 寫通用 MCP');
  assert.match(spec, /身分依序：`AIGILE_AGENT`→資料夾唯一的 `\.token`→`aigile_use\(代號\)`，選了就鎖定/, '規格寫身分怎麼決定');
  assert.match(spec, /舊的 `aigile-<代號小寫>` 照用/, '舊名稱照樣能用');
  console.log('mcp-name-test：全部通過');
} catch (e) {
  console.error('mcp-name-test 失敗：', e.message);
  process.exitCode = 1;
}
