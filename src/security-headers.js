// 網頁與 API 的安全標頭（server.js、worker.js、core.js 共用；Workers 的靜態檔另見 public/_headers）
// CSP：只執行本站與兩個固定來源的腳本（cdnjs 的 QR Code、Cloudflare Turnstile）；不能被別的網站用 iframe 嵌入、不能改 <base>
// style-src 要 'unsafe-inline'：版面有用 style 屬性（顏色、頭像圖）；腳本沒有 inline，所以 script-src 不開
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// 網頁（HTML 與靜態檔）
export const PAGE_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', // 邀請、救援連結在網址裡，不讓它跟著 Referer 送到別的網站
};
// API 回應
export const API_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
