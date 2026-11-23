// GitHub Release 說明：推 v* 標籤時 release.yml 讀 docs/release-notes/v<版本>.md 建 Release，檔案不在就失敗。
// 這支在本機先擋：目前版本和 docs/releases-notes.json 列的每一版都要有說明檔，格式跟之前的 Release 一樣
// （第一行＝中英標題、## 繁體中文、## English、兩段都寫升級方式）。1.0.4 以前的檔是 GitHub 上原本的 Release 原文，只要求存在。
// 用法：node scripts/release-notes-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const pkg = JSON.parse(read('package.json')).version;
const notes = JSON.parse(read('docs/releases-notes.json')).releases;
const wf = read('.github/workflows/release.yml');

const versions = [...new Set([pkg, ...notes.map(n => n.version)])];
const num = v => v.split(/[.-]/).slice(0, 3).map(Number);
const atLeast = (v, min) => { const a = num(v), b = num(min); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
for (const v of versions) {
  const file = `docs/release-notes/v${v}.md`;
  assert.ok(fs.existsSync(new URL(file, root)), `${file} 要有（release.yml 推標籤時讀它建 Release）`);
  const text = read(file);
  if (!atLeast(v, '1.0.4')) continue;
  assert.ok(!text.includes('\r'), `${file} 用 LF 換行`);
  const [first] = text.split('\n');
  const title = notes.find(n => n.version === v)?.title;
  if (title) assert.equal(first, title, `${file} 第一行要跟 releases-notes.json 的標題一樣`);
  else assert.ok(/ · /.test(first), `${file} 第一行是「中文 · English」標題`);
  const zh = text.indexOf('\n## 繁體中文\n'), en = text.indexOf('\n## English\n');
  assert.ok(zh > 0 && en > zh, `${file} 要有「## 繁體中文」再「## English」`);
  assert.ok(/\n升級：/.test(text.slice(zh, en)), `${file} 中文段要寫升級方式（「升級：」開頭）`);
  assert.ok(/\nUpgrade: /.test(text.slice(en)), `${file} 英文段要寫升級方式（「Upgrade: 」開頭）`);
}

// release.yml：建置前先檢查說明檔、最後用它建 Release
assert.ok(/contents: write/.test(wf), 'release.yml 要有 contents: write 才建得了 Release');
const check = wf.indexOf('name: Check release notes exist'), build = wf.indexOf('name: Build for smoke test'), create = wf.indexOf('name: Create GitHub Release');
assert.ok(check > 0 && check < build, '說明檔的檢查在建置映像之前（沒寫就不發布任何東西）');
assert.ok(create > build && /--notes-file "\$notes"/.test(wf), '建 Release 用 docs/release-notes/<tag>.md');

console.log(`release-notes-test：全部通過（${versions.length} 版）`);
