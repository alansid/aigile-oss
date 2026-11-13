// 說明頁內容（不開瀏覽器）：public/help.json 中英兩份、畫面圖、網址
// 1. 五章：1 讓你的 AI 加入、2 跟著走一遍、3 AI 會來問你、4 帳號與裝置、5 常見狀況；中英兩份的章、步驟、題號、畫面格、試試看一樣
// 2. 英文那份沒有中文字；{桌機|手機} 括號成對；章號互相引用一致
// 3. 開源版通用說法：不提特定公司、內部系統、真實人名或特定網址
// 4. imgs 列的圖都在 public/help-img/<語言>/，imgSize 等於圖檔寬高（載入前先留位置）；圖不能太大
// 5. 本機伺服器：/help、/help/3 回網頁；/help.json 是 JSON；圖是 image/webp
// 用法：node scripts/help-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { startKit } from './browser-kit.js';

const root = new URL('../', import.meta.url);
const help = JSON.parse(fs.readFileSync(new URL('public/help.json', root), 'utf8'));
// WebP 的寬高（VP8／VP8L／VP8X 三種開頭）
function webpSize(b) {
  assert.equal(b.toString('ascii', 0, 4) + b.toString('ascii', 8, 12), 'RIFFWEBP', '要是 WebP');
  const t = b.toString('ascii', 12, 16);
  if (t === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (t === 'VP8L') { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
  if (t === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  throw new Error('看不懂的 WebP：' + t);
}

let kit;
try {
  const zh = help.zh, en = help.en;
  assert.ok(zh?.chapters && en?.chapters, 'help.json 有 zh、en 兩份');
  // 1. 章序與結構
  assert.deepEqual(zh.chapters.map(c => c.n), [1, 2, 3, 4, 5], '五章');
  assert.deepEqual(zh.chapters.map(c => c.title), ['讓你的 AI 加入', '跟著走一遍：從交辦到驗收', 'AI 會來問你什麼、怎麼回', '帳號與裝置', '常見狀況'], '中文章名');
  assert.deepEqual(en.chapters.map(c => c.title), ['Bring your AI on board', 'Walk through it: from request to verification', 'What AIs ask you, and how to answer', 'Account and devices', 'Common situations'], '英文章名');
  const shape = d => d.chapters.map(c => ({ n: c.n, forAi: !!c.forAi, faq: !!c.faq, steps: c.steps.map(s => [s.id || '', s.fig || '', (s.list || []).length, !!s.d]), note: c.note ? c.note.fig || '-' : '', after: !!c.after, intro: !!c.intro, card: !!c.card, try: c.try?.go || '' }));
  assert.deepEqual(shape(en), shape(zh), '中英兩份的章、步驟、題號、畫面格、清單項數、試試看一樣');
  const ch = n => zh.chapters[n - 1];
  assert.ok(ch(1).forAi && zh.chapters.filter(c => c.forAi).length === 1, '只有第 1 章是要帶 AI 的人看的');
  assert.deepEqual(ch(2).steps.map(s => s.fig), ['2-1', '2-2', '2-3', '2-4'], '跟著走一遍四步各一格畫面');
  assert.equal(ch(2).steps[1].t, 'AI 接單，事情掛到一張卡上', '第 2 章第 2 步標題跟導覽一致');
  assert.deepEqual(zh.chapters.map(c => c.try?.go || ''), ['myai', 'messages', 'inbox', 'settings', ''], '每章試試看（第 5 章沒有）');
  assert.deepEqual(ch(5).steps.map(s => s.id), ['1', '2', '3', '4', '5', '6'], '第 5 章每題有題號');
  // 2. 寫法
  const all = JSON.stringify(zh.chapters), allEn = JSON.stringify(en.chapters);
  for (const re of [/就是第 2 章第 4 步/, /見第 1 章第 5 步/, /AI 要用自己的身分，見第 1 章/, /把新的給它（第 1 章）/, /配對（第 4 章第 1 步）/]) assert.match(all, re, '章號互相引用');
  for (const re of [/step 4 of chapter 2/, /step 5 of chapter 1/, /their own identity \(see chapter 1\)/, /new one \(chapter 1\)/, /step 1 of chapter 4/]) assert.match(allEn, re, '英文章號互相引用');
  assert.ok(!/收件匣|卡住了|複製接入文字/.test(all), '用詞跟開源版畫面一樣（要你處理、複製接入設定）');
  assert.ok(!/[㐀-鿿]/.test(allEn), '英文那份沒有中文：' + (allEn.match(/.{0,20}[㐀-鿿].{0,20}/) || [''])[0]);
  for (const [lang, d] of [['zh', zh], ['en', en]]) for (const c of d.chapters) for (const s of [...c.steps, c.note || {}]) for (const k of ['t', 'd', 'figText']) {
    assert.ok(!/[{}]/.test((s[k] || '').replace(/\{[^|{}]*\|[^{}]*\}/g, '')), `${lang} 第 ${c.n} 章「${s.t}」的 ${k}：{桌機|手機} 括號成對`);
  }
  // 3. 開源版通用說法
  const raw = fs.readFileSync(new URL('public/help.json', root), 'utf8');
  for (const re of [/行內|投信|銀行|血汗|勞工/, /alansid/i, /workers\.dev/i, /劉昱志|昱志/, /PLAT-\d/, /BM3C|RVVW/]) assert.doesNotMatch(raw, re, '沒有平台專屬的說法：' + re);
  // 4. 圖
  let total = 0;
  for (const [lang, d] of [['zh', zh], ['en', en]]) {
    const figs = d.chapters.flatMap(c => [...c.steps, c.note || {}].map(s => s.fig).filter(Boolean));
    assert.deepEqual([...new Set(figs)].filter(f => !d.imgs.includes(f)), [], `${lang}：每一格都有圖（3-2 共用 2-4）`);
    assert.deepEqual(Object.keys(d.imgSize).sort(), [...d.imgs].sort(), `${lang}：每張圖都有寬高`);
    for (const f of d.imgs) {
      const file = new URL(`public/help-img/${lang}/${f}.webp`, root);
      assert.ok(fs.existsSync(file), `${lang}/${f}.webp 要在 public/help-img`);
      const b = fs.readFileSync(file);
      total += b.length;
      assert.deepEqual(d.imgSize[f], webpSize(b), `${lang}/${f}：imgSize 等於圖檔寬高`);
      assert.ok(b.length < 150 * 1024, `${lang}/${f}.webp 不超過 150 KB（${Math.round(b.length / 1024)} KB）`);
    }
  }
  const extra = ['zh', 'en'].flatMap(l => fs.readdirSync(new URL(`public/help-img/${l}/`, root)).filter(f => !help[l].imgs.includes(f.replace(/\.webp$/, ''))).map(f => `${l}/${f}`));
  assert.deepEqual(extra, [], '資料夾裡沒有用不到的圖');
  assert.ok(total < 2.5 * 1024 * 1024, `兩套圖加起來不超過 2.5 MB（${Math.round(total / 1024)} KB）`);
  console.log(`help-test：內容通過（兩套圖共 ${Math.round(total / 1024)} KB）`);

  // 5. 本機伺服器
  kit = await startKit('help');
  for (const p of ['/help', '/help/3']) { const r = await fetch(kit.BASE + p); assert.equal(r.status, 200, p); assert.match(await r.text(), /<script src="\/tour\.js"><\/script>\s*<script src="\/app\.js">/, p + ' 回網頁（先載 tour.js 再載 app.js）'); }
  const j = await fetch(kit.BASE + '/help.json');
  assert.equal(j.status, 200); assert.match(j.headers.get('content-type'), /application\/json/, 'help.json 是 JSON');
  for (const l of ['zh', 'en']) { const r = await fetch(`${kit.BASE}/help-img/${l}/2-1.webp`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/webp', l + ' 圖是 image/webp'); }
  // Cloudflare：.webp 跟 .png 一樣直接給靜態檔，不經過 Worker
  assert.match(fs.readFileSync(new URL('wrangler.toml', root), 'utf8'), /"!\/\*\.webp"/, 'wrangler.toml 的 run_worker_first 排除 .webp');
  // 導覽框架：不從外部載入任何東西
  const tour = fs.readFileSync(new URL('public/tour.js', root), 'utf8');
  assert.ok(!/https?:\/\//.test(tour.replace(/\/\/.*$/gm, '')), 'tour.js 不從外部載入任何東西');
  console.log('help-test：全部通過');
} catch (e) {
  console.error('help-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit?.stop(); }
