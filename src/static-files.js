// PLAT-460 靜態檔傳輸：gzip（瀏覽器有送 Accept-Encoding: gzip 才壓）、ETag／If-None-Match 回 304、Cache-Control。
// 網址沒帶版本號（/app.js、/style.css），所以 js、css 一律 no-cache：每次都問一下伺服器，沒變就回 304（不傳內容），
// 改版後內容雜湊變了，ETag 跟著變，瀏覽器一定拿到新檔。圖片很少變，快取 1 小時。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// 文字類才壓（圖片本身已壓縮，再壓只花 CPU）
export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.md', '.txt']);
const IMAGE = new Set(['.png', '.webp', '.ico', '.jpg', '.jpeg', '.gif', '.svg']);
const MIN_GZIP_BYTES = 1024; // 太小的檔壓了也省不到幾個位元組

export function cacheControlFor(ext) {
  if (ext === '.html') return 'no-cache';
  if (IMAGE.has(ext)) return 'public, max-age=3600';
  return 'no-cache'; // js、mjs、css、json…：每次重新驗證（有 ETag，沒變只回 304）
}

// Accept-Encoding 有 gzip 而且不是 q=0
export function acceptsGzip(header) {
  // 明寫的 gzip 優先於 *（「gzip;q=0, *;q=1」表示不要 gzip）
  let star = false;
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map(s => s.trim());
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.find(p => p.startsWith('q='));
    const ok = !q || Number(q.slice(2)) > 0;
    if (name === 'gzip') return ok;
    star = ok;
  }
  return star;
}

// If-None-Match 可能是 *、多個值、或帶 W/（弱比較）
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const bare = t => t.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some(t => t.trim() === '*' || bare(t) === bare(etag));
}

export const hashEtag = buf => '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 22) + '"';
const gzEtag = etag => etag.slice(0, -1) + '-gz"'; // 壓縮版是不同的表示法，ETag 要不一樣

// 讀檔＋雜湊＋壓縮結果依 mtime／size 快取在記憶體；檔案換了（改版、重新部署）就重算
export function createStaticCache() {
  const cache = new Map();
  return function load(file) {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const etag = hashEtag(body);
    const gz = COMPRESSIBLE.has(ext) && body.length >= MIN_GZIP_BYTES ? zlib.gzipSync(body, { level: 9 }) : null;
    const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag, gz: gz && gz.length < body.length ? gz : null, gzEtag: gzEtag(etag) };
    cache.set(file, entry);
    return entry;
  };
}

// 回傳要送的 status、headers、body（HEAD 不送 body）。同一個函式給一般檔與已經換好內容的 HTML 用。
export function staticResponse({ ext, contentType, entry, reqHeaders = {}, method = 'GET', extraHeaders = {} }) {
  const gzip = !!entry.gz && acceptsGzip(reqHeaders['accept-encoding']);
  const etag = gzip ? entry.gzEtag : entry.etag;
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControlFor(ext), ETag: etag, ...extraHeaders };
  if (entry.gz) headers.Vary = 'Accept-Encoding';
  if (etagMatches(reqHeaders['if-none-match'], etag)) return { status: 304, headers, body: null };
  const body = gzip ? entry.gz : entry.body;
  if (gzip) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = String(body.length);
  return { status: 200, headers, body: method === 'HEAD' ? null : body };
}

// 動態內容（index.html 換上群組名之後）也走同一套：依內容算 ETag、壓縮
export function bufferEntry(buf) {
  const etag = hashEtag(buf);
  const gz = buf.length >= MIN_GZIP_BYTES ? zlib.gzipSync(buf) : null;
  return { body: buf, etag, gz: gz && gz.length < buf.length ? gz : null, gzEtag: gzEtag(etag) };
}
