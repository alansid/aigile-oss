#!/usr/bin/env node
// Aigile-Switch Claude Code hook：接入檢查寫進工作資料夾的 .claude/settings.local.json（不進 git、不動全機設定）。零依賴，Node 22+。
//
//   node .aigile/watcher/aigile-hook.mjs session   SessionStart（clear、compact）：印「重新接上」提示當開場內容，/clear 後不用再貼接入設定
//   node .aigile/watcher/aigile-hook.mjs stop      Stop（回合結束）：等待腳本不在就擋一次、請 AI 重開；同一次不在只提醒一次
//
// 認身分：環境變數 AIGILE_AGENT（一行啟動會帶）→ 資料夾只有一隻 AI 有 .token 就用它；都不是就什麼都不做（不擋）。
// 不印 Token；平台連不上也不擋（只印一行說明）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2];
const CODE_RE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?$/;
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const agentsIn = root => { try { return fs.readdirSync(path.join(root, '.aigile'), { withFileTypes: true }).filter(d => d.isDirectory() && CODE_RE.test(d.name) && read(path.join(root, '.aigile', d.name, '.token')).trim()).map(d => d.name); } catch { return []; } };
// 跟通用 MCP 一樣：往上找第一個有 AI Token 的 .aigile/，到家目錄就停（家目錄的只給在家目錄開的對話）；找不到＝沒接平台，什麼都不做
const findWork = () => {
  const start = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.env.AIGILE_DIR || process.cwd());
  const home = path.resolve(os.homedir()); // 真的家目錄（AIGILE_HOME 只管轉接腳本放哪，不影響往上找到哪裡停）
  for (let d = start; ; d = path.dirname(d)) {
    if (d === home && d !== start) return null;
    if (agentsIn(d).length) return d;
    if (path.dirname(d) === d) return null;
  }
};
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// 一律不呼叫 process.exit，設 exitCode 讓程式自然結束。Windows 上 Node 24 讀 stdin＋fetch 後馬上 process.exit
// 會間歇觸發 libuv 斷言（UV_HANDLE_CLOSING），結束碼變 127，Claude Code 就丟掉 hook 的輸出、/clear 接不回來
const stdin = () => new Promise(res => {
  let s = '', done = false;
  const end = v => { if (done) return; done = true; try { process.stdin.pause(); process.stdin.destroy(); } catch {} res(v); };
  if (process.stdin.isTTY) return end({});
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => (s += d));
  process.stdin.on('end', () => { try { end(JSON.parse(s || '{}')); } catch { end({}); } });
  process.stdin.on('error', () => end({}));
  setTimeout(() => end({}), 3000).unref();
});
const write = s => new Promise(ok => process.stdout.write(s, () => ok()));

async function main() {
  const WORK = findWork();
  if (!WORK) return;
  const dirOf = a => path.join(WORK, '.aigile', a);
  const hasToken = a => !!read(path.join(dirOf(a), '.token')).trim();
  // 認不出唯一身分（沒有 AIGILE_AGENT、資料夾又有多隻 AI）→ 一律不做事、不擋：這個資料夾的別隻 AI 或沒接平台的對話不受影響
  const env0 = (process.env.AIGILE_AGENT || '').trim();
  const list = agentsIn(WORK);
  const AGENT = env0 ? (CODE_RE.test(env0) && hasToken(env0) ? env0 : '') : list.length === 1 ? list[0] : '';
  const input = await stdin();
  if (!AGENT) return;
  const DIR = dirOf(AGENT);
  const rel = p => path.relative(WORK, p).replace(/\\/g, '/');
  const wait = `node --env-file=${rel(path.join(DIR, 'watcher.env'))} .aigile/watcher/aigile-wait.mjs --agent ${AGENT}`;

  if (MODE === 'session' && read(path.join(DIR, 'transport.txt')).trim() === 'rest') {
    return write(`[Aigile] ${AGENT}: resume using ${rel(DIR)}/ai-integration.md and api-reference.md in REST mode. Preserve your cursor and owner approval rules. Wait command: ${wait}\n`);
  }
  if (MODE === 'session' && input.source === 'compact') {
    // 壓縮時不帶整份設定（約 5,600 字，每次壓縮都多吃一次），只印一句；不打網路
    return write(`[Aigile] 對話剛壓縮：你是 ${AGENT}。照 ${rel(path.join(DIR, 'reconnect.md'))} 與工作記憶（aigile_memory、.aigile/${AGENT}/state.json）接續，不要重新簽到、游標沿用；等待腳本要開著（不在就在 ${WORK.split(path.sep).join('/')} 用背景執行：${wait}）。\n`);
  }
  if (MODE === 'session') {
    const base = (/^AIGILE_BASE=(.*)$/m.exec(read(path.join(DIR, 'watcher.env')))?.[1] || '').trim().replace(/\/+$/, '');
    const token = read(path.join(DIR, '.token')).trim();
    let text = '';
    try {
      const line = fs.existsSync(path.join(DIR, 'started-by-line')) ? '&start=1' : ''; // 用一行啟動接的＝已同意待命
      const r = await fetch(`${base}/api/me/reconnect?tool=claude${line}`, { headers: { Authorization: `Bearer ${token}`, 'X-Aigile-Source': 'hook', Connection: 'close' }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) text = await r.text();
      else { text = `（平台回 HTTP ${r.status}${r.status === 401 ? '：Token 失效，請所屬人類在網頁重發' : ''}）`; await r.arrayBuffer().catch(() => {}); }
    } catch (e) { text = `（連不到 ${base || '平台'}：${e.cause?.code || e.name}）`; }
    // 存一份給 AI 用搜尋讀（不含 Token）
    if (text.length > 200) try { fs.writeFileSync(path.join(DIR, 'reconnect.md'), text); } catch {}
    return write(`[Aigile] 對話剛清空：你是 ${AGENT}，照下面的「重新接上」設定接回（不要重新簽到、游標沿用；全文也存在 ${rel(path.join(DIR, 'reconnect.md'))}）。\n\n${text}\n`);
  }
  if (MODE === 'stop') {
    if (input.stop_hook_active) return; // 已經因為 hook 繼續過一次：不再擋
    const tool = /^SKILL_TOOL=(.*)$/m.exec(read(path.join(DIR, 'watcher.env')))?.[1]?.trim();
    if (tool && tool !== 'claude') return; // Codex／手動模式不跑等待腳本
    if (!alive(Number(read(path.join(DIR, 'watcher.pid')).trim()))) return; // watcher 沒在跑＝沒在待命（還沒同意或手動模式）：不擋
    const flag = path.join(DIR, 'wait-reminded');
    // 等待腳本每分鐘碰一下 wait.pid；超過 5 分鐘沒更新＝舊檔（PID 可能被瀏覽器等別的程式重用），不算在跑
    const wp = path.join(DIR, 'wait.pid');
    let fresh = false; try { fresh = Date.now() - fs.statSync(wp).mtimeMs < 5 * 60_000; } catch {}
    if (fresh && alive(Number(read(wp).trim()))) { try { fs.rmSync(flag, { force: true }); } catch {} return; }
    if (fs.existsSync(flag)) return; // 這次不在已經提醒過：失敗只提醒一次
    try { fs.writeFileSync(flag, new Date().toISOString()); } catch {}
    return write(JSON.stringify({ decision: 'block', reason: `[Aigile] 等待腳本不在（${rel(path.join(DIR, 'wait.pid'))} 的程序沒在跑），這樣有人找你不會被叫醒。請在 ${WORK.split(path.sep).join('/')} 用背景執行重開：${wait}（逾時設最長，不要用 Monitor 或 sleep 迴圈）。重開失敗就照實告訴所屬人類，這個提醒只出現一次。` }) + '\n');
  }
}
process.exitCode = 0;
await main().catch(e => { process.stderr.write(`[aigile-hook] ${e.message}\n`); }); // hook 出錯也不擋對話（結束碼照樣 0）
