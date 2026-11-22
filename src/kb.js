// 知識庫底層：上傳的文件抽成純文字、分段存進 kb_chunks，可搜尋、可分段讀。
// Office 檔（docx／pptx／xlsx）是 zip：只用內建的 DecompressionStream('deflate-raw') 解壓，不裝套件；Node 與 Workers 共用。
// PDF、圖片不抽字（標「只有原檔」），整理時由 AI 讀原檔。

export const KB_TEXT_EXTS = ['md', 'txt', 'docx', 'pptx', 'xlsx'];
export const KB_MAX_CHARS_PER_DOC = 200_000;      // 單檔最多抽 20 萬字，超過截斷
export const KB_MAX_TOTAL_CHARS = 50_000_000;     // 全站最多 5,000 萬字，超過新文件只存原檔
export const KB_MAX_PROJECT_CHUNKS = 20_000;      // 單一專案超過就不搜（LIKE 掃描的成本；KB_MAX_PROJECT_CHUNKS 可調）
export const KB_CHUNK_MIN = 1_000, KB_CHUNK_MAX = 2_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;         // zip 裡單一檔案解壓上限（擋 zip 炸彈）

export class KbError extends Error {}

// ---------- zip ----------
function zipIndex(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 22 - 65535); i >= min; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new KbError('不是有效的 Office 檔（zip 結構錯誤）');
  const out = new Map(), dec = new TextDecoder();
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new KbError('不是有效的 Office 檔（zip 目錄錯誤）');
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    out.set(dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)), { method: v.getUint16(p + 10, true), csize: v.getUint32(p + 20, true), offset: v.getUint32(p + 42, true) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(data).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > MAX_ENTRY_BYTES) { await r.cancel().catch(() => {}); throw new KbError('檔案解壓後太大'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
async function zipReader(bytes) {
  const idx = zipIndex(bytes), dec = new TextDecoder();
  const read = async name => {
    const e = idx.get(name);
    if (!e) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (e.offset + 30 > bytes.length || v.getUint32(e.offset, true) !== 0x04034b50) throw new KbError('不是有效的 Office 檔（zip 內容錯誤）');
    const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return dec.decode(raw);
    if (e.method === 8) return dec.decode(await inflateRaw(raw));
    throw new KbError(`不支援的壓縮方式（${e.method}）`);
  };
  return { names: [...idx.keys()], read };
}

// ---------- XML ----------
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const cp = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
export const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? cp(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? null;
const clean = s => s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();

// Word 樣式：styleId → 標題層級（樣式名稱 heading N／Title，或樣式裡的 outlineLvl）
function docxHeadingStyles(xml) {
  const map = new Map();
  for (const [, head, body] of (xml || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(head, 'w:styleId');
    if (!id) continue;
    const name = /<w:name\b[^>]*w:val="([^"]*)"/.exec(body)?.[1] || '';
    const lvl = /<w:outlineLvl\b[^>]*w:val="(\d)"/.exec(body)?.[1];
    const m = /^(?:heading|標題)\s*(\d)$/i.exec(name.trim());
    const level = m ? Number(m[1]) : /^title$/i.test(name.trim()) ? 1 : lvl !== undefined ? Number(lvl) + 1 : 0;
    if (level >= 1 && level <= 6) map.set(id, level);
  }
  return map;
}
// document.xml → 段落（標題帶 level）；表格每列一行、欄用 Tab
function docxBlocks(xml, styles) {
  const blocks = [];
  let para = null, inText = false, pPr = 0, tbl = 0, row = null, cell = null;
  const re = /<(\/?)(w:p|w:pPr|w:tbl|w:tr|w:tc|w:t|w:tab|w:br|w:cr|w:pStyle|w:outlineLvl)\b([^>]*?)(\/?)>|([^<]+)/g;
  for (const [, close, tag, attrs, self, text] of xml.matchAll(re)) {
    if (text !== undefined) { if (inText && para) para.text += unxml(text); continue; }
    if (tag === 'w:p') {
      if (!close && !self) { para = { level: 0, text: '' }; continue; }
      if (close && para) {
        const t = clean(para.text);
        if (row && cell !== null) cell += (cell ? ' ' : '') + t;
        else if (t) blocks.push({ level: para.level, text: t });
        para = null;
      }
    } else if (tag === 'w:pPr') pPr = close ? Math.max(0, pPr - 1) : self ? pPr : pPr + 1;
    else if (tag === 'w:t') inText = !close && !self;
    else if (tag === 'w:tab') { if (!pPr && para && !close) para.text += '\t'; }
    else if (tag === 'w:br' || tag === 'w:cr') { if (para && !close) para.text += ' '; }
    else if (tag === 'w:pStyle') { if (para) para.level = styles.get(attr(attrs, 'w:val')) || para.level; }
    else if (tag === 'w:outlineLvl') { const n = Number(attr(attrs, 'w:val')); if (para && n >= 0 && n < 6) para.level = n + 1; }
    else if (tag === 'w:tbl') tbl = close ? Math.max(0, tbl - 1) : tbl + 1;
    else if (tag === 'w:tr') {
      if (!close) row = [];
      else if (row) { while (row.length && !row[row.length - 1]) row.pop(); if (row.length) blocks.push({ level: 0, text: row.join('\t') }); row = null; }
    } else if (tag === 'w:tc') {
      if (!close) cell = '';
      else if (row && cell !== null) { row.push(cell.replace(/\s+/g, ' ').trim()); cell = null; }
    }
  }
  return blocks;
}
// DrawingML（投影片、備註）：每個 <a:p> 一行；<a:fld>（頁碼等欄位）不算
function drawingText(xml) {
  const lines = [];
  let line = null, inText = false, fld = 0;
  for (const [, close, tag, self, text] of (xml || '').matchAll(/<(\/?)(a:p|a:t|a:br|a:fld)\b[^>]*?(\/?)>|([^<]+)/g)) {
    if (text !== undefined) { if (inText && !fld && line !== null) line += unxml(text); continue; }
    if (tag === 'a:p') { if (!close && !self) line = ''; else if (close && line !== null) { const t = clean(line); if (t) lines.push(t); line = null; } }
    else if (tag === 'a:t') inText = !close && !self;
    else if (tag === 'a:br') { if (line !== null && !close) line += ' '; }
    else if (tag === 'a:fld') fld = close ? Math.max(0, fld - 1) : self ? fld : fld + 1;
  }
  return lines;
}
const relTargets = xml => new Map([...(xml || '').matchAll(/<Relationship\b([^>]*?)\/?>/g)].map(([, a]) => [attr(a, 'Id'), attr(a, 'Target') || '']));
const resolve = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const s of target.split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }
  return parts.join('/');
};
const colIndex = ref => { let n = 0; for (const ch of (/^[A-Z]+/.exec(ref || '')?.[0] || '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const tTexts = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unxml(m[1])).join('');

// ---------- 分段 ----------
// 太長的一段在句號、換行處切開，每塊 ≤ max
export function splitLong(text, max = KB_CHUNK_MAX) {
  const out = [];
  let t = text;
  while (t.length > max) {
    const win = t.slice(0, max);
    let cut = Math.max(...['。', '！', '？', '\n', '. ', '! ', '? '].map(s => win.lastIndexOf(s)));
    cut = cut >= max / 2 ? cut + 1 : max;
    out.push(t.slice(0, cut).trim());
    t = t.slice(cut);
  }
  if (t.trim()) out.push(t.trim());
  return out;
}
// 段落（標題帶 level）→ 段：大標題（1、2 層）一定換段；小標題在已滿 KB_CHUNK_MIN 時換段
// section＝這段內文涵蓋的各小節標題路徑的共同上層（只含 3.2 就寫到 3.2；含 3.1～3.4 就寫到第三章）
function chunkBlocks(blocks) {
  const out = [], stack = [];
  let cur = null;
  const common = paths => { const p = [...(paths[0] || [])]; for (const q of paths) { let i = 0; while (i < p.length && p[i] === q[i]) i++; p.length = i; } return p.filter(Boolean).join(' > '); };
  const flush = () => { if (cur?.text.trim()) out.push({ section: common(cur.paths.length ? cur.paths : [cur.head]), content: cur.text.trim() }); cur = null; };
  const add = (text, heading) => {
    for (const piece of splitLong(text)) {
      if (cur && cur.text.length + piece.length + 1 > KB_CHUNK_MAX) flush();
      if (!cur) cur = { text: '', body: false, paths: [], head: [...stack] };
      cur.text += (cur.text ? '\n' : '') + piece;
      if (!heading) { cur.body = true; cur.paths.push([...stack]); }
    }
  };
  for (const b of blocks) {
    if (b.level) {
      if (cur?.body && (b.level <= 2 || cur.text.length >= KB_CHUNK_MIN)) flush(); // 只有標題、還沒內文的不單獨成段
      stack.length = Math.min(stack.length, b.level - 1);
      while (stack.length < b.level - 1) stack.push('');
      stack.push(b.text.slice(0, 80));
      if (cur && !cur.body) cur.head = [...stack];
    }
    add(b.text, !!b.level);
  }
  flush();
  return out;
}
// 一組行（同一個 section）→ 每段 ≤ KB_CHUNK_MAX
function chunkLines(section, lines) {
  const out = [];
  let cur = '';
  for (const line of lines.flatMap(l => splitLong(l))) {
    if (cur && cur.length + line.length + 1 > KB_CHUNK_MAX) { out.push({ section, content: cur }); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) out.push({ section, content: cur.trim() });
  return out;
}

// md／txt：md 依 # 標題，兩者都依空行分段落
function textBlocks(text, md) {
  const blocks = [];
  let para = [];
  const end = () => { const t = para.join('\n').trim(); if (t) blocks.push({ level: 0, text: t }); para = []; };
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const h = md && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { end(); blocks.push({ level: h[1].length, text: h[2].trim() }); }
    else if (!line.trim()) end();
    else para.push(line.trimEnd());
  }
  end();
  return blocks;
}

async function docxChunks(bytes) {
  const z = await zipReader(bytes);
  const xml = await z.read('word/document.xml');
  if (xml === null) throw new KbError('找不到 word/document.xml');
  return chunkBlocks(docxBlocks(xml, docxHeadingStyles(await z.read('word/styles.xml'))));
}
async function pptxChunks(bytes) {
  const z = await zipReader(bytes);
  const slides = z.names.map(n => [n, /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1]]).filter(x => x[1]).sort((a, b) => a[1] - b[1]);
  const out = [];
  for (const [i, [name]] of slides.entries()) {
    const lines = drawingText(await z.read(name));
    const rel = [...relTargets(await z.read(name.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))).values()].find(t => /notesSlide\d+\.xml$/.test(t));
    const notes = rel ? drawingText(await z.read(resolve(name, rel))) : [];
    if (notes.length) lines.push('（講者備註）' + notes.join('\n'));
    if (lines.length) out.push(...chunkLines(`投影片第 ${i + 1} 頁`, lines));
  }
  return out;
}
async function xlsxChunks(bytes) {
  const z = await zipReader(bytes);
  const shared = [...((await z.read('xl/sharedStrings.xml')) || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => tTexts(m[1]));
  const rels = relTargets(await z.read('xl/_rels/workbook.xml.rels'));
  const out = [];
  for (const [, a] of ((await z.read('xl/workbook.xml')) || '').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const target = rels.get(attr(a, 'r:id'));
    const xml = target ? await z.read(resolve('xl/workbook.xml', target)) : null;
    if (!xml) continue;
    const lines = [];
    for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const [, ca, body = ''] of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = attr(ca, 't'), v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? tTexts(body) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v !== undefined ? unxml(v) : '';
        const at = colIndex(attr(ca, 'r'));
        cells[at >= 0 ? at : cells.length] = val.replace(/\s+/g, ' ').trim();
      }
      const line = Array.from(cells, x => x ?? '').join('\t').replace(/\t+$/, '');
      if (line.trim()) lines.push(line);
    }
    if (lines.length) out.push(...chunkLines(`工作表：${unxml(attr(a, 'name') || '')}`, lines));
  }
  return out;
}

// 抽字＋分段：回傳 { chunks: [{ section, content }], chars, truncated }；不支援的格式回 null（只有原檔）
export async function extractChunks(ext, bytes, maxChars = KB_MAX_CHARS_PER_DOC) {
  let chunks;
  if (ext === 'md' || ext === 'txt') chunks = chunkBlocks(textBlocks(new TextDecoder().decode(bytes), ext === 'md'));
  else if (ext === 'docx') chunks = await docxChunks(bytes);
  else if (ext === 'pptx') chunks = await pptxChunks(bytes);
  else if (ext === 'xlsx') chunks = await xlsxChunks(bytes);
  else return null;
  const out = [];
  let chars = 0, truncated = false;
  for (const c of chunks) {
    if (chars + c.content.length > maxChars) {
      const rest = maxChars - chars;
      if (rest > 0) { out.push({ ...c, content: c.content.slice(0, rest) }); chars += rest; }
      truncated = true;
      break;
    }
    out.push(c);
    chars += c.content.length;
  }
  return { chunks: out, chars, truncated };
}

// ---------- 搜尋 ----------
// 查詢字串用空白切成最多 5 個詞（不分大小寫去重）
export function kbTerms(q) {
  const seen = new Set(), out = [];
  for (const t of String(q || '').trim().split(/\s+/)) {
    const k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push(t); }
    if (out.length === 5) break;
  }
  return out;
}
export const likeArg = t => '%' + t.replace(/[%_\\]/g, m => '\\' + m) + '%';
const count = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };
// 命中位置前後約 radius 字
export function snippet(content, terms, radius = 150) {
  const low = content.toLowerCase();
  const at = Math.min(...terms.map(t => low.indexOf(t.toLowerCase())).filter(i => i >= 0), content.length);
  const from = Math.max(0, (at === content.length ? 0 : at) - radius), to = Math.min(content.length, from + radius * 2 + 20);
  return (from > 0 ? '…' : '') + content.slice(from, to).replace(/\s+/g, ' ').trim() + (to < content.length ? '…' : '');
}
// 排序：出現次數多的優先；詞出現在 section 或文件名的加權
export function rankChunks(rows, terms, docNames = new Map()) {
  const ts = terms.map(t => t.toLowerCase());
  return rows.map(r => {
    const c = r.content.toLowerCase(), s = (r.section || '').toLowerCase(), n = (docNames.get(r.doc_id) || '').toLowerCase();
    const score = ts.reduce((a, t) => a + count(c, t) + 5 * count(s, t) + (n.includes(t) ? 3 : 0), 0);
    return { ...r, score };
  }).sort((a, b) => b.score - a.score || String(a.doc_id).localeCompare(String(b.doc_id)) || a.idx - b.idx);
}
