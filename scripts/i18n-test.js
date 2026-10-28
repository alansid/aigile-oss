// 英文介面字典檢查（不開瀏覽器）
// 1. 介面上每段中文（app.js、index.html）和伺服器錯誤訊息都要在 public/i18n/en.js 有英文；新增介面文字忘了翻會在這裡列出來
// 2. {0}{1} 變數英文裡也要有；協定標籤（[接單]、[完成]…）與「選項：」「建議：」不能被翻掉
// 3. 用詞表在字典開頭
// 4. 問候只對人名去掉姓：「管理員」不會變「理員」
// 用法：node scripts/i18n-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { scanUi, scanServer, loadEn, skipKey } from './i18n-scan.js';

try {
  const en = loadEn();
  assert.ok(en && en.dict && en.glossary, 'en.js 有 glossary 與 dict');
  for (const term of ['卡片', '決策卡', '交接', '驗收', '專案', '群組']) assert.ok(en.glossary[term], `用詞表有「${term}」`);
  const src = fs.readFileSync(new URL('../public/i18n/en.js', import.meta.url), 'utf8');
  assert.ok(src.indexOf('glossary') < src.indexOf('dict:'), '用詞表放在字典前面');

  // 1. 全部翻到
  const keys = [...new Set([...scanUi(), ...scanServer()])].filter(k => !skipKey(k));
  const miss = keys.filter(k => !(k in en.dict));
  assert.equal(miss.length, 0, `${miss.length} 段中文還沒翻（加進 public/i18n/en.js）：\n` + miss.slice(0, 40).join('\n'));

  // 2. 變數與協定標籤
  const TAGS = /\[(?:接單|完成|進度|需確認|通知|交接|回覆|決策)\]|選項：|建議：/g;
  for (const [k, v] of Object.entries(en.dict)) {
    assert.equal(typeof v, 'string', `「${k}」的英文要是字串`);
    assert.ok(v.trim(), `「${k}」的英文不能空白`);
    for (const ph of k.match(/\{\d+\}/g) || []) assert.ok(v.includes(ph), `「${k}」的英文少了 ${ph}：${v}`);
    for (const tag of k.match(TAGS) || []) assert.ok(v.includes(tag), `「${k}」的協定標籤 ${tag} 不能翻：${v}`);
  }
  // 太寬的變數句（兩頭都是變數、中間只有一個字）不會拿來比對（在 i18n.js 擋）
  const rt = fs.readFileSync(new URL('../public/i18n/i18n.js', import.meta.url), 'utf8');
  assert.ok(/han < 2/.test(rt), '執行時略過太寬的變數句');
  assert.ok(rt.includes('.msg-text') && rt.includes('textarea'), '訊息內文、textarea 不翻');

  // 4. 問候用全名（「林新人」不會被截成「新人」，「管理員」不會變「理員」）；名字不給畫面翻譯碰
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("${esc(greeting())}，<span data-nt>${esc(shownName(state.me?.name || ''))}</span>"), '問候用全名');
  assert.ok(!/const shortName = /.test(app), '不再去掉姓');
  console.log(`i18n-test：全部通過（${keys.length} 段中文都有英文）`);
} catch (e) {
  console.error('i18n-test 失敗：', e.message);
  process.exitCode = 1;
}
