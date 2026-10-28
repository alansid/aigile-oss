// 目前版本（後端用：備份檔記版本、管理頁比對新版本）。要跟 package.json、public/app.js 的 APP_VERSION 一樣（version-test 會檢查）
export const APP_VERSION = '1.0.0';

// 比較版本號 a、b（1.2.3）：a 新回正數、一樣回 0、舊回負數；看不懂的當 0.0.0
export function cmpVersion(a, b) {
  const p = v => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || [0, 0, 0, 0]).slice(1, 4).map(Number);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
