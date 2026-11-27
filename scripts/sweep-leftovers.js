// 全套跑完找測試留下的程序。
// 只停身分可靠的：從這個程序往上，每一層父程序都還活著、建立時間對得上，一路接到 run-all 自己或它開的某支測試。
// 中間有一層父程序已經結束，就只剩 PPID 和時間可以比，PID 可能已經被別的程序重用，這種只列出、不停。
// 停的時候綁定那個程序實例（Windows 用程序 handle 核對建立時間再停），不是拿快照裡的 PID 直接停。
import { spawnSync } from 'node:child_process';

const SLACK_MS = 2000; // 建立時間比對的誤差（ps 只到秒）

// 目前的程序清單：[{ pid, ppid, at（建立時間 ms）, cmd }]；讀不到回 null
// 要列全部程序：只列 node／chrome 的話，中間隔著 bash 之類的父程序會被當成「已結束」，再撞到 PID 重用就會認錯人
export function listProcesses() {
  listProcesses.error = '';
  try {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; at = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }); // 忙的時候 WMI 查詢會慢，30 秒曾不夠
      if (r.status !== 0) return fail(r);
      const j = JSON.parse(r.stdout || '[]');
      return withoutLister((Array.isArray(j) ? j : [j]).map(p => ({ pid: Number(p.pid), ppid: Number(p.ppid), at: Date.parse(p.at), cmd: p.cmd || '' })), r.pid);
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) return fail(r);
    const list = [];
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line);
      if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), at: Date.parse(m[3]), cmd: m[4] });
    }
    return withoutLister(list, r.pid);
  } catch (e) { listProcesses.error = e.message; return null; }
}
// 讀不到清單時把原因留在 listProcesses.error（逾時、結束碼、stderr），給呼叫端印出來
function fail(r) {
  listProcesses.error = r.error?.code === 'ETIMEDOUT' ? '逾時' : r.error ? r.error.message : `結束碼 ${r.status}${r.signal ? '／' + r.signal : ''}：${(r.stderr || '').trim().slice(0, 200)}`;
  return null;
}

// 拿掉列清單用的 powershell／ps 自己和它底下的 conhost：拿到清單時它們已經結束，不是測試留下的
const withoutLister = (list, pid) => list.filter(p => p.pid !== pid && p.ppid !== pid);

// roots：Map<pid, [{ at, end, f }]>：run-all 自己與它開過的每支測試（同一個 PID 可能先後被兩支測試用到；end 是測試結束時間，還在跑就沒有）
// 回傳 { owned: [{ ...p, f }]（身分可靠，可以停）, unsure: [{ ...p, f? }]（只列出：父程序斷掉、只能猜是哪支測試的，或指令帶這次暫存資料夾但接不到來源） }
export function pickLeftovers(list, { since, roots, tmp, self = process.pid }) {
  const byPid = new Map(list.map(p => [p.pid, p]));
  const rootOf = (pid, at) => (roots.get(pid) || []).find(r => Math.abs(r.at - at) <= SLACK_MS);
  // 往上找：{ f }＝每層都活著接到 run-all 或某支測試；{ guess }＝中間斷掉，只憑 PPID 和時間猜得到是哪支測試；null＝接不到
  const ownerOf = p => {
    let cur = p;
    for (let i = 0; i < 32; i++) {
      const parent = byPid.get(cur.ppid);
      if (parent) {
        if (parent.at > cur.at + SLACK_MS) return null; // 父程序比自己晚建：自己原本的父程序已結束、PID 被重用
        const r = rootOf(parent.pid, parent.at);
        if (r) return { f: r.f };
        if (parent.at < since - SLACK_MS) return null; // 在全套之前就有的程序（例如別的 AI 的 claude）
        cur = parent;
        continue;
      }
      // 父程序已經結束：只能猜（自己在那支測試跑的期間建的），不算可靠身分
      const starts = (roots.get(cur.ppid) || []).filter(r => r.at <= cur.at + SLACK_MS && cur.at <= (r.end ?? Infinity) + SLACK_MS);
      return starts.length ? { guess: starts[starts.length - 1].f } : null;
    }
    return null;
  };
  const owned = [], unsure = [], t = String(tmp || '').toLowerCase();
  for (const p of list) {
    if (p.pid === self || rootOf(p.pid, p.at) || !(p.at >= since - SLACK_MS)) continue;
    const o = ownerOf(p);
    if (o?.f) owned.push({ ...p, f: o.f });
    else if (o?.guess) unsure.push({ ...p, f: o.guess });
    else if (t && p.cmd.toLowerCase().includes(t)) unsure.push(p);
  }
  return { owned, unsure };
}

// 停一批程序，每個都綁定建立時間（at）：回傳 [{ pid, r }]，r＝stopped（停了）／gone（已經結束）／reused（PID 已換人，沒停）／alive（停完還在）／其他字串（錯誤）
// Windows：用 Process 物件拿到 handle，核對 StartTime 後用同一個 handle 停，PID 中途被重用也停不到別人。
// 其他系統：沒有 handle 可用，停之前重讀一次建立時間核對（ps 只到秒，PID 是遞增配發，重用要繞一圈）。
export function stopInstances(targets) {
  if (!targets.length) return [];
  if (process.platform === 'win32') {
    const ps = `$ts = $env:AIGILE_SWEEP_TARGETS | ConvertFrom-Json
$out = foreach ($t in $ts) {
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$t.pid)
    $want = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$t.at).UtcDateTime
    if ([math]::Abs(($p.StartTime.ToUniversalTime() - $want).TotalMilliseconds) -gt ${SLACK_MS}) { [pscustomobject]@{ pid = $t.pid; r = 'reused' } }
    else { $p.Kill(); [void]$p.WaitForExit(3000); [pscustomobject]@{ pid = $t.pid; r = $(if ($p.HasExited) { 'stopped' } else { 'alive' }) } }
  } catch [System.ArgumentException] { [pscustomobject]@{ pid = $t.pid; r = 'gone' } }
  catch { [pscustomobject]@{ pid = $t.pid; r = $_.Exception.Message } }
}
@($out) | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, AIGILE_SWEEP_TARGETS: JSON.stringify(targets.map(p => ({ pid: p.pid, at: p.at }))) } });
    if (r.status !== 0) return targets.map(p => ({ pid: p.pid, r: '停程序的 powershell 失敗' }));
    const j = JSON.parse(r.stdout || '[]');
    return (Array.isArray(j) ? j : [j]).map(x => ({ pid: Number(x.pid), r: String(x.r) }));
  }
  return targets.map(p => {
    const q = spawnSync('ps', ['-o', 'lstart=', '-p', String(p.pid)], { encoding: 'utf8', timeout: 10_000 });
    const at = Date.parse((q.stdout || '').trim());
    if (!at) return { pid: p.pid, r: 'gone' };
    if (Math.abs(at - p.at) > SLACK_MS) return { pid: p.pid, r: 'reused' };
    try { process.kill(p.pid, 'SIGKILL'); } catch (e) { return { pid: p.pid, r: e.code === 'ESRCH' ? 'gone' : e.code || e.message }; }
    return { pid: p.pid, r: 'stopped' };
  });
}

// 停掉身分可靠的程序：回傳 { stopped（停了或已經結束）, skipped（PID 已換人，沒停）, failed（停不掉，照實回報） }
export function stopLeftovers(owned, { stop = stopInstances } = {}) {
  const res = new Map(stop(owned).map(x => [x.pid, x.r]));
  const stopped = [], skipped = [], failed = [];
  for (const p of owned) {
    const r = res.get(p.pid) ?? '沒有回報結果';
    if (r === 'stopped' || r === 'gone') stopped.push(p);
    else if (r === 'reused') skipped.push(p);
    else failed.push({ ...p, why: r === 'alive' ? '停完還在' : r });
  }
  return { stopped, skipped, failed };
}
