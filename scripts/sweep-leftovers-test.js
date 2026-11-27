// 全套跑完清殘留程序：只停身分可靠的（父程序一路活著接到全套），其餘只列出；停的時候綁定程序實例，停不掉照實回報
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { listProcesses, pickLeftovers, stopLeftovers, stopInstances } from './sweep-leftovers.js';

let child; // 真的子程序；中途失敗也要在 finally 停掉，不然它會讓這支測試一直不結束
try {
  // ── 挑選：全部用假的程序清單，不碰真的程序 ──
  const since = 1_000_000, RUN = 100, tmp = 'C:\\Temp\\aigile-run-AbC';
  // run-all（PID 100，還活著）開過：a-test（PID 200，已結束）、b-test（PID 300，已結束）、c-test（PID 950，很早就跑完）
  const roots = new Map([
    [RUN, [{ at: since - 5000, f: 'run-all' }]],
    [200, [{ at: since + 1000, end: since + 8000, f: 'a-test.js' }]],
    [300, [{ at: since + 9000, end: since + 15_000, f: 'b-test.js' }]],
    [950, [{ at: since + 500, end: since + 600, f: 'c-test.js' }]],
  ]);
  const list = [
    { pid: RUN, ppid: 1, at: since - 5000, cmd: 'node scripts/run-all.js' },
    { pid: 301, ppid: RUN, at: since + 9500, cmd: 'node fake-watcher.mjs' },            // 直接掛在活著的 run-all 底下 → 停
    { pid: 601, ppid: RUN, at: since + 8000, cmd: 'node late-parent' },              // 同上 → 停
    { pid: 603, ppid: 601, at: since + 8100, cmd: 'chrome --type=renderer' },         // 父程序 601 活著、接得到 run-all → 停（指令不帶暫存資料夾也算）
    { pid: 600, ppid: 601, at: since + 4000, cmd: 'node child-of-late-parent' },     // 父程序比自己晚建（PID 重用）→ 不理
    { pid: 201, ppid: 200, at: since + 2000, cmd: `chrome --user-data-dir=${tmp}\\x` }, // 父程序（a-test）已結束：只能猜 → 只列出、不停
    { pid: 202, ppid: 201, at: since + 2100, cmd: 'chrome --type=renderer' },           // 往上第二層斷掉 → 只列出、不停
    { pid: 400, ppid: 1, at: since + 3000, cmd: `node other.js ${tmp.toUpperCase()}\\y` }, // 帶暫存資料夾但接不到來源 → 只列出
    { pid: 401, ppid: 1, at: since + 3000, cmd: 'node 別人的 watcher' },                 // 跟這次無關 → 不理
    { pid: 500, ppid: 200, at: since - 60_000, cmd: `node ${tmp}\\old` },              // 全套開始前就在 → 不理
    { pid: 300, ppid: 1, at: since + 20_000, cmd: 'node 重用了 300 的程序' },            // PID 300 被別的程序重用
    { pid: 302, ppid: 300, at: since + 21_000, cmd: `node ${tmp}\\z` },               // 父程序是重用 PID 的那支 → 接不到 b-test，只列出
    // 實際發生過：別的 AI 在全套中途重開等待腳本，它的父程序 bash 剛好拿到 c-test 用過的 PID 950
    { pid: 900, ppid: 1, at: since - 90_000, cmd: 'claude' },
    { pid: 950, ppid: 900, at: since + 30_000, cmd: 'bash -c node aigile-wait.mjs' },
    { pid: 951, ppid: 950, at: since + 30_100, cmd: 'node aigile-wait.mjs --agent PO_X' }, // bash 活著、往上接到全套前就在的 claude → 不理
  ];
  const { owned, unsure } = pickLeftovers(list, { since, roots, tmp, self: 999 });
  const ids = a => a.map(p => p.pid).sort((x, y) => x - y);
  assert.deepEqual(owned.map(p => [p.pid, p.f]).sort((a, b) => a[0] - b[0]), [[301, 'run-all'], [601, 'run-all'], [603, 'run-all']], '只停父程序一路活著接到全套的');
  assert.deepEqual(ids(unsure), [201, 202, 302, 400], '父程序斷掉的、帶暫存資料夾但接不到的，只列出');
  assert.deepEqual(unsure.filter(p => p.f).map(p => [p.pid, p.f]).sort((a, b) => a[0] - b[0]), [[201, 'a-test.js'], [202, 'a-test.js']], '只列出的可以附上猜的來源');
  assert.ok(![RUN, 401, 500, 600, 900, 950, 951].some(id => owned.concat(unsure).some(p => p.pid === id)), 'run-all 自己、無關、全套前就在、別人中途開的都不理');
  // 清單漏了 bash（看起來像父程序已結束），等待腳本又是 c-test 結束很久之後才建的 → 連猜都不算
  const noBash = pickLeftovers(list.filter(p => p.pid !== 950), { since, roots, tmp, self: 999 });
  assert.ok(!noBash.owned.concat(noBash.unsure).some(p => p.pid === 951), '父程序看不到時，測試結束後才建的不算那支測試的');
  // 同一個 PID 先後給兩支測試用（700：x-test 已結束、y-test 還在跑）：只認目前活著這一個
  const reuse = new Map([[RUN, [{ at: since - 5000, f: 'run-all' }]], [700, [{ at: since + 1000, end: since + 9000, f: 'x-test.js' }, { at: since + 50_000, f: 'y-test.js' }]]]);
  const r2 = pickLeftovers([
    { pid: 700, ppid: RUN, at: since + 50_000, cmd: 'node y-test.js' },
    { pid: 701, ppid: 700, at: since + 51_000, cmd: 'node a' }, // 活著的 y-test 開的 → 停
    { pid: 702, ppid: 700, at: since + 2000, cmd: 'node b' },   // x-test 開的，但現在的 700 是後來才建的 y-test → 不能算 y-test 的
  ], { since, roots: reuse, tmp, self: 999 });
  assert.deepEqual(r2.owned.map(p => [p.pid, p.f]), [[701, 'y-test.js']], 'PID 重用時不認錯父程序');

  // ── 停：用假的 stop，不碰真的程序 ──
  const asked = [];
  const res = stopLeftovers([1, 2, 3, 4, 5, 6].map(pid => ({ pid, at: pid })), {
    stop: ts => { asked.push(...ts.map(t => [t.pid, t.at])); return [{ pid: 1, r: 'stopped' }, { pid: 2, r: 'Access is denied' }, { pid: 3, r: 'alive' }, { pid: 4, r: 'gone' }, { pid: 5, r: 'reused' }]; },
  });
  assert.deepEqual(asked, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], '停的時候帶建立時間，讓停的那邊核對是不是同一個程序');
  assert.deepEqual(ids(res.stopped), [1, 4], '停了、或要停時已經結束的算已停');
  assert.deepEqual(ids(res.skipped), [5], 'PID 已換成別的程序的沒停');
  assert.deepEqual(res.failed.map(p => [p.pid, p.why]).sort(), [[2, 'Access is denied'], [3, '停完還在'], [6, '沒有回報結果']], '停不掉的照實回報');

  // ── 真的程序：只碰這支測試自己開的子程序 ──
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const childAt = Date.now();
  await new Promise(r => setTimeout(r, 300));
  const real = listProcesses();
  assert.ok(real, '讀得到程序清單：' + listProcesses.error);
  assert.ok(real.some(p => p.pid === process.ppid), '清單要有全部程序（連開這支測試的 shell 也在），不能只列 node');
  assert.ok(!real.some(p => /Get-CimInstance Win32_Process|pid=,ppid=,lstart=/.test(p.cmd)), '列清單用的 powershell／ps 自己不在清單裡');
  const me = real.find(p => p.pid === child.pid);
  assert.ok(me && me.ppid === process.pid, '子程序的父程序是自己：' + JSON.stringify(me));
  const selfAt = real.find(p => p.pid === process.pid)?.at;
  const live = pickLeftovers(real, { since: childAt - 5000, roots: new Map([[process.pid, [{ at: selfAt, f: 'me' }]]]), tmp: '', self: -1 });
  assert.deepEqual(live.owned.filter(p => p.pid === child.pid).map(p => p.f), ['me'], '真的程序樹也核對得出來');
  // 建立時間對不上（當成 PID 已換人）→ 不停，子程序還活著
  assert.deepEqual(stopInstances([{ pid: child.pid, at: me.at + 60_000 }]), [{ pid: child.pid, r: 'reused' }], '建立時間對不上就不停');
  assert.equal(child.exitCode === null && child.signalCode === null, true, '子程序還活著');
  const exited = new Promise(r => child.once('exit', r));
  const done = stopLeftovers([me]);
  assert.deepEqual(ids(done.stopped), [child.pid], '對得上就停得掉：' + JSON.stringify(done));
  await exited;
  assert.deepEqual(stopInstances([{ pid: child.pid, at: me.at }]), [{ pid: child.pid, r: 'gone' }], '已經結束的回 gone');
  console.log('sweep-leftovers-test：全部通過');
} catch (e) {
  console.error('sweep-leftovers-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}
