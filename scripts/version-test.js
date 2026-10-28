// 版本號一致：網頁（public/app.js）與後端（src/version.js）顯示的版本要跟 package.json 一樣
// 用法：node scripts/version-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
try {
  const pkg = JSON.parse(read('package.json')).version;
  assert.match(pkg, /^\d+\.\d+\.\d+$/, 'package.json 的版本要是 x.y.z');
  assert.ok(read('public/app.js').includes(`const APP_VERSION = '${pkg}'`), `public/app.js 的 APP_VERSION 要等於 ${pkg}`);
  assert.ok(read('src/version.js').includes(`export const APP_VERSION = '${pkg}'`), `src/version.js 的 APP_VERSION 要等於 ${pkg}`);
  console.log('version-test：全部通過');
} catch (e) {
  console.error('version-test 失敗：', e.message);
  process.exitCode = 1;
}
