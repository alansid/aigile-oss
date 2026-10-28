// 掃出介面上的中文片段（給英文字典檢查用）：public/app.js、public/index.html 的字串與模板字串，去掉 HTML 標籤，${} 換成 {0}{1}…
// 也掃伺服器回給網頁的錯誤訊息（src/*.js 的 ApiError、invalid、fieldErr、reject）
// 用法：import { scanUi, scanServer } from './i18n-scan.js'；或 node scripts/i18n-scan.js 列出還沒翻的
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[㐀-鿿＀-￯　-〿]/;
const HAN = /[㐀-鿿]/;

function literals(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } if (src[j] === '\n') break; s += src[j++]; }
      out.push(s); i = j + 1; continue;
    }
    if (c === '`') { const r = tpl(src, i + 1); out.push(...r.parts); i = r.end; continue; }
    i++;
  }
  return out;
}
function tpl(src, i) {
  const parts = []; let text = '', holes = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { text += src[i + 1]; i += 2; continue; }
    if (c === '`') { parts.unshift(text); return { parts, end: i + 1 }; }
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) {
        const ch = src[j];
        if (ch === '`') { const r = tpl(src, j + 1); parts.push(...r.parts); j = r.end; continue; }
        if (ch === "'" || ch === '"') { let k = j + 1; while (k < src.length && src[k] !== ch) { if (src[k] === '\\') k++; k++; } parts.push(src.slice(j + 1, k)); j = k + 1; continue; }
        if (ch === '{') depth++; else if (ch === '}') depth--;
        j++;
      }
      text += `{${holes++}}`; i = j; continue;
    }
    text += c; i++;
  }
  return { parts, end: i };
}
const fragments = text => [...text.replace(/<[^>]*>/g, '\u0000').split('\u0000'), ...[...text.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)].map(m => m[1])];
const norm = f => { let k = f.replace(/\s+/g, ' ').trim(), i = 0; return k.replace(/\{\d+\}/g, () => `{${i++}}`); };

export function scanUi(root = ROOT) {
  const keys = new Set();
  const add = f => { const k = norm(f); if (k && HAN.test(k)) keys.add(k); };
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  for (const l of literals(app)) if (CJK.test(l)) fragments(l).forEach(add);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  fragments(html).forEach(add);
  return [...keys];
}
export function scanServer(root = ROOT) {
  const keys = new Set();
  const re = /(?:ApiError\(\s*\d+\s*,\s*'[A-Z_]+'\s*,\s*|invalid\(\s*|fieldErr\(\s*'[a-zA-Z]+'\s*,\s*|reject\(\s*\d+\s*,\s*'[A-Z_]+'\s*,\s*)(['`])/g;
  for (const f of fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    for (const m of s.matchAll(re)) {
      const q = m[1]; let i = m.index + m[0].length, t = '', holes = 0;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') { t += s[i + 1]; i += 2; continue; }
        if (q === '`' && s[i] === '$' && s[i + 1] === '{') { let d = 1; i += 2; while (i < s.length && d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; } t += `{${holes++}}`; continue; }
        t += s[i++];
      }
      if (HAN.test(t)) keys.add(t.replace(/\s+/g, ' ').trim());
    }
    // 內建角色：名稱、下拉選項、六題設定的題目（畫面上會顯示）
    if (f === 'roles.js') for (const v of s.matchAll(/(?:role|option|label): '([^'\n]*)'/g)) if (HAN.test(v[1])) keys.add(v[1]);
    // 錯誤訊息表（例：const FAIL_MSG = { password: '帳號或密碼不對。' }）
    for (const b of s.matchAll(/_MSG = \{([\s\S]*?)\};/g)) for (const v of b[1].matchAll(/'([^'\n]*)'/g)) if (HAN.test(v[1])) keys.add(v[1]);
  }
  return [...keys];
}
// 讀 public/i18n/en.js（它是給瀏覽器的 window.AIGILE_EN）
export function loadEn(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'public/i18n/en.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window.AIGILE_EN;
}
// 不用翻的：只有一個中文字（可能是頭像的字）、兩頭都是變數又只有一個字（執行時也不比對）、只有協定標籤、CSS 選擇器
export const TAG_RE = /\[(?:接單|完成|進度|需確認|通知|交接|回覆|決策)\]|選項：|建議：/g;
export const skipKey = k => {
  const rest = k.replace(TAG_RE, '').replace(/\{\d+\}|\s/g, '');
  const han = (rest.match(/[㐀-鿿]/g) || []).length;
  return !han || (!/\{\d+\}/.test(k) && rest.length <= 1) || (han < 2 && /^\{\d+\}/.test(k) && /\{\d+\}$/.test(k)) || /^\[data-[a-z-]+="/.test(k);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const en = loadEn();
  const miss = [...scanUi(), ...scanServer()].filter(k => !skipKey(k) && !(k in en.dict));
  console.log(`還沒翻：${miss.length}`);
  for (const k of miss) console.log('  ' + k);
}
