// 測試用假的 agy 指令：記錄參數、環境變數與 --settings 檔內容，絕不動真的 Antigravity 設定或網路
import fs from 'node:fs';

const a = process.argv.slice(2);
const si = a.indexOf('--settings');
const settings = si >= 0 && a[si + 1] && fs.existsSync(a[si + 1]) ? fs.readFileSync(a[si + 1], 'utf8') : null;
if (process.env.FAKE_AGY_LOG) {
  fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({
    args: a,
    agent: process.env.AIGILE_AGENT || '',
    wakeAgent: process.env.AIGILE_WAKE_AGENT || '',
    foreground: process.env.AIGILE_FOREGROUND || '',
    fgPid: process.env.AIGILE_FG_PID || '',
    settings,
  }) + '\n');
}

if (a[0] === '--version') {
  console.log('1.5.13-fake');
  process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'list') {
  console.log('aigile');
  process.exit(0);
}
if (a.includes('-p') || a.includes('--print')) {
  if (process.env.FAKE_AGY_SLEEP_MS) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_SLEEP_MS)));
  }
  if (process.env.FAKE_AGY_ERROR && (a.includes('--model') || process.env.FAKE_AGY_FAIL_FALLBACK)) {
    console.error(process.env.FAKE_AGY_ERROR);
    process.exit(1);
  }
  const ci = a.indexOf('--conversation');
  const existing = ci >= 0 ? a[ci + 1] : null;
  if (existing && process.env.FAKE_AGY_INVALID_CONVO === existing) {
    console.error('Error: conversation not found');
    process.exit(1);
  }
  const id = existing || process.env.FAKE_AGY_CONVO || `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  console.log(JSON.stringify({ conversation_id: id, status: 'SUCCESS', response: 'OK\n', num_turns: existing ? 2 : 1 }));
  process.exit(0);
}
if (a.includes('-i') || a.includes('--prompt-interactive')) {
  process.exit(0);
}
process.exit(0);
