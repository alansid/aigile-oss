// npm start／node server.js 的啟動參數：-p／--port、--host、環境變數 PORT／HOST
// 修正前：只讀環境變數 PORT（亂填就默默用 3000），listen 不帶位址、固定聽所有網卡；npm start -p 8080 沒有作用
// 用法：node scripts/server-args-test.js（會起兩次本機站，用暫存資料夾，不連外）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseServerArgs, startupLines, ServerArgError } from '../src/server-args.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const throwsArg = (fn, re, msg) => assert.throws(fn, e => e instanceof ServerArgError && re.test(e.message), msg);
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const run = (args, env = {}, ms = 20_000) => new Promise(resolve => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-srvargs-'));
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js'), ...args], { cwd: ROOT, env: { ...process.env, PORT: '', HOST: '', DATA_DIR: dataDir, AIGILE_TEST_PROJECTS: '1', ...env }, stdio: 'pipe' });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => p.kill(), ms);
  p.on('exit', code => { clearTimeout(t); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} resolve({ code, out }); });
  resolve.p = p; run.last = { p, out: () => out };
});

try {
  // 1. 解析：命令列 > 環境變數 > 預設
  assert.deepEqual(parseServerArgs([], {}), { port: 3000, host: null, help: false }, '預設 3000、所有網卡');
  assert.equal(parseServerArgs(['-p', '8080'], {}).port, 8080, '-p 8080');
  assert.equal(parseServerArgs(['--port', '8081'], {}).port, 8081, '--port 8081');
  assert.equal(parseServerArgs(['--port=8082'], {}).port, 8082, '--port=8082');
  assert.equal(parseServerArgs(['-p=8083'], {}).port, 8083, '-p=8083');
  assert.equal(parseServerArgs([], { PORT: '9000' }).port, 9000, '環境變數 PORT');
  assert.equal(parseServerArgs(['-p', '8080'], { PORT: '9000' }).port, 8080, '命令列優先於 PORT');
  assert.equal(parseServerArgs(['--host', '127.0.0.1'], {}).host, '127.0.0.1', '--host');
  assert.equal(parseServerArgs(['--host=::1'], {}).host, '::1', '--host=::1');
  assert.equal(parseServerArgs(['--host', '[::1]'], {}).host, '::1', '[::1] 去掉括號');
  assert.equal(parseServerArgs([], { HOST: '0.0.0.0' }).host, '0.0.0.0', '環境變數 HOST');
  assert.equal(parseServerArgs(['--host', '127.0.0.1'], { HOST: '0.0.0.0' }).host, '127.0.0.1', '命令列優先於 HOST');
  assert.equal(parseServerArgs([], { PORT: '', HOST: '' }).port, 3000, '空的環境變數＝沒設');
  assert.equal(parseServerArgs(['--help'], {}).help, true);
  // 2. 不合法就丟錯，不默默用預設
  throwsArg(() => parseServerArgs(['-p', '0'], {}), /1～65535/, '埠號 0');
  throwsArg(() => parseServerArgs(['-p', '70000'], {}), /1～65535/, '埠號太大');
  throwsArg(() => parseServerArgs(['-p', 'abc'], {}), /1～65535/, '埠號不是數字');
  throwsArg(() => parseServerArgs(['-p'], {}), /後面要接值/, '-p 沒給值');
  throwsArg(() => parseServerArgs(['--host'], {}), /後面要接值/, '--host 沒給值');
  throwsArg(() => parseServerArgs(['--host', '-p'], {}), /位址/, '--host 後面接到別的參數');
  throwsArg(() => parseServerArgs(['--prot', '8080'], {}), /不認得的參數「--prot」/, '打錯字的參數');
  throwsArg(() => parseServerArgs(['8080'], {}), /不認得的參數「8080」/, '只給數字');
  throwsArg(() => parseServerArgs([], { PORT: 'abc' }), /環境變數 PORT/, '環境變數 PORT 亂填也擋');
  // 3. 啟動訊息
  const nets = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.23' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] };
  let l = startupLines(8080, null, nets);
  assert.equal(l[0], 'Aigile-Switch 已啟動：http://localhost:8080');
  assert.match(l[1], /同網段的其他電腦可以用：http:\/\/192\.168\.1\.23:8080（只給這台用：--host 127\.0\.0\.1）/, '聽所有網卡時列出區網 IP');
  assert.ok(!l.join().includes('127.0.0.1:8080'), '不列 loopback');
  l = startupLines(8080, '0.0.0.0', nets); assert.equal(l.length, 2, '0.0.0.0 也算所有網卡');
  l = startupLines(8080, '127.0.0.1', nets); assert.deepEqual(l, ['Aigile-Switch 已啟動：http://127.0.0.1:8080'], '指定位址只印那個網址');
  assert.deepEqual(startupLines(8080, '::1', nets), ['Aigile-Switch 已啟動：http://[::1]:8080'], 'IPv6 加括號');

  // 4. 實際起站：-p 與 --host 生效
  const port = await freePort();
  const pr = run(['-p', String(port), '--host', '127.0.0.1']);
  const { p, out } = run.last;
  for (let k = 0; k < 150 && !/已啟動/.test(out()); k++) await new Promise(r => setTimeout(r, 100));
  assert.match(out(), new RegExp(`已啟動：http://127\\.0\\.0\\.1:${port}`), '啟動訊息是實際網址：' + out());
  const g = await (await fetch(`http://127.0.0.1:${port}/api/group`)).json();
  assert.ok(g.name, '-p 指定的埠號連得到');
  p.kill(); await pr;
  // 5. 參數不對：印說明、結束碼 2，不起站
  const bad = await run(['-p', 'abc']);
  assert.equal(bad.code, 2, '結束碼 2');
  assert.match(bad.out, /啟動參數不對：-p 的埠號「abc」不對[\s\S]*用法：npm start -- \[-p 埠號\]/, '印出原因與用法：' + bad.out.slice(0, 300));
  const help = await run(['--help']);
  assert.equal(help.code, 0); assert.match(help.out, /用法：npm start --/);
  // 6. 埠號被佔用：中文說明
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => busy.on('listening', r));
  const used = await run(['--port', String(busy.address().port), '--host', '127.0.0.1']);
  busy.close();
  assert.equal(used.code, 1); assert.match(used.out, /埠號 \d+ 已經有程式在用，換一個：npm start -- -p 8080/, '佔用時的說明：' + used.out.slice(-200));
  // 7. README 寫了用法與 HOST
  for (const f of ['README.md', 'README.en.md']) {
    const md = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(md, /npm start -- -p 8080/, f + ' 寫 npm start -- -p 8080');
    assert.match(md, /\| `HOST` \|/, f + ' 環境變數表有 HOST');
  }
  console.log('server-args-test：全部通過');
} catch (e) {
  console.error('server-args-test 失敗：', e.message);
  process.exitCode = 1;
}
