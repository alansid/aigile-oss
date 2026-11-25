// PLAT-460 靜態檔傳輸：gzip、ETag／304、Cache-Control
// 1. 純函式：Accept-Encoding 判斷（q=0 不算）、If-None-Match（多個值、W/、*）、各類檔案的 Cache-Control
// 2. 快取：檔案內容一改 ETag 就變（改版後瀏覽器不會拿到舊檔）；小檔、圖片不壓
// 3. 真的伺服器：app.js 有送 gzip 才壓、解開後跟原檔一樣；帶 ETag 回 304 不傳內容；HTML 照舊 no-cache 也能壓；圖片快取 1 小時；HEAD 不傳內容
// 用法：node scripts/static-files-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { acceptsGzip, etagMatches, cacheControlFor, createStaticCache, staticResponse } from '../src/static-files.js';
import { startServer } from './browser-kit.js';
import { stopChild } from './test-process.js';

const kids = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-static-'));
const get = (base, p, headers = {}, method = 'GET') => new Promise((ok, bad) => {
  const req = http.request(base + p, { method, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', bad);
  req.end();
});

try {
  // 1. 純函式
  assert.ok(acceptsGzip('gzip, deflate, br'));
  assert.ok(acceptsGzip('br;q=1.0, gzip;q=0.8'));
  assert.ok(acceptsGzip('*'));
  assert.ok(!acceptsGzip('gzip;q=0'), 'q=0 表示不要');
  assert.ok(!acceptsGzip('gzip;q=0, *;q=1'), '明寫 gzip;q=0 優先於 *');
  assert.ok(!acceptsGzip('*;q=1, gzip;q=0'), '順序反過來也一樣');
  assert.ok(acceptsGzip('br, *;q=0.5'));
  assert.ok(!acceptsGzip('br'));
  assert.ok(!acceptsGzip(undefined));
  assert.ok(etagMatches('"abc"', '"abc"'));
  assert.ok(etagMatches('W/"abc"', '"abc"'), '弱比較');
  assert.ok(etagMatches('"x", "abc"', '"abc"'), '多個值');
  assert.ok(etagMatches('*', '"abc"'));
  assert.ok(!etagMatches('"abd"', '"abc"'));
  assert.ok(!etagMatches(undefined, '"abc"'));
  assert.equal(cacheControlFor('.html'), 'no-cache');
  assert.equal(cacheControlFor('.js'), 'no-cache', '網址沒帶版本：每次重新驗證');
  assert.equal(cacheControlFor('.css'), 'no-cache');
  assert.equal(cacheControlFor('.png'), 'public, max-age=3600');
  console.log('✓ 純函式');

  // 2. 快取：內容改了 ETag 就變；小檔不壓、圖片不壓
  const tmp = path.join(dataDir, 'x.js');
  fs.writeFileSync(tmp, 'console.log(1);'.repeat(200));
  const load = createStaticCache();
  const a = load(tmp);
  assert.ok(a.gz && a.gz.length < a.body.length, '文字檔有壓縮');
  assert.equal(load(tmp), a, '沒改就用快取');
  fs.writeFileSync(tmp, 'console.log(2);'.repeat(200));
  const future = new Date(Date.now() + 5000); fs.utimesSync(tmp, future, future); // 有些檔案系統 mtime 解析度粗，確保看得出改過
  const b = load(tmp);
  assert.notEqual(b.etag, a.etag, '內容改了，ETag 跟著變');
  const small = path.join(dataDir, 's.css'); fs.writeFileSync(small, 'a{}');
  assert.equal(load(small).gz, null, '太小不壓');
  const png = path.join(dataDir, 'p.png'); fs.writeFileSync(png, Buffer.alloc(5000, 7));
  assert.equal(load(png).gz, null, '圖片不壓');
  const r304 = staticResponse({ ext: '.js', contentType: 'text/javascript', entry: b, reqHeaders: { 'if-none-match': b.etag } });
  assert.equal(r304.status, 304); assert.equal(r304.body, null);
  const head = staticResponse({ ext: '.js', contentType: 'text/javascript', entry: b, method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, null); assert.equal(head.headers['Content-Length'], String(b.body.length));
  console.log('✓ 快取與 304');

  // 3. 真的伺服器
  const base = await startServer(kids, path.join(dataDir, 'data'));
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url));
  const plain = await get(base, '/app.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined, '沒送 Accept-Encoding 就不壓');
  assert.ok(plain.body.equals(appJs), '內容跟原檔一樣');
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.ok(plain.headers.etag, '有 ETag');
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.ok(plain.headers['content-security-policy'], '安全標頭照舊');

  const gz = await get(base, '/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(gz.body.length < appJs.length / 3, `壓縮後明顯變小（${appJs.length} → ${gz.body.length}）`);
  assert.ok(zlib.gunzipSync(gz.body).equals(appJs), '解開後跟原檔一樣');
  assert.notEqual(gz.headers.etag, plain.headers.etag, '壓縮版的 ETag 不一樣');

  const again = await get(base, '/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag });
  assert.equal(again.status, 304, '沒變回 304');
  assert.equal(again.body.length, 0, '304 不傳內容');
  assert.equal((await get(base, '/app.js', { 'If-None-Match': plain.headers.etag })).status, 304);
  assert.equal((await get(base, '/app.js', { 'If-None-Match': '"old"' })).status, 200, 'ETag 對不上就給新檔');

  const css = await get(base, '/style.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(css.headers['content-encoding'], 'gzip'); assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  const en = await get(base, '/i18n/en.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(en.headers['content-encoding'], 'gzip', '英文字典也壓');

  const page = await get(base, '/', { 'Accept-Encoding': 'gzip' });
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-cache', 'HTML 照舊 no-cache');
  assert.equal(page.headers['content-encoding'], 'gzip');
  assert.match(zlib.gunzipSync(page.body).toString('utf8'), /<script src="\/app\.js"/, 'HTML 內容正常');
  const deep = await get(base, '/p/main/messages');
  assert.equal(deep.status, 200); assert.match(deep.headers['content-type'], /text\/html/, '網頁路徑照舊回 index.html');

  const img = await get(base, '/og-image.png', { 'Accept-Encoding': 'gzip' });
  assert.equal(img.status, 200); assert.equal(img.headers['content-encoding'], undefined, '圖片不再壓');
  assert.equal(img.headers['cache-control'], 'public, max-age=3600');

  const h = await get(base, '/app.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(h.status, 200); assert.equal(h.body.length, 0, 'HEAD 不傳內容');

  assert.equal((await get(base, '/nope.js')).status, 404);
  assert.equal((await get(base, '/../package.json')).status, 404, '不能讀 public 以外的檔');
  const api = await get(base, '/api/health', { 'Accept-Encoding': 'gzip' });
  assert.equal(api.status, 200); assert.equal(api.headers['content-encoding'], undefined, 'API 不動');
  console.log('✓ 伺服器：gzip、304、Cache-Control');
  console.log('static-files-test：全部通過');
} catch (e) {
  console.error('static-files-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const k of kids) await stopChild(k);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
