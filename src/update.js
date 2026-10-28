// 管理頁「有新版本」：管理員打開成員與權限時，查 GitHub alansid/aigile-oss 最新 release
// - 一天最多查一次，結果存 app_settings 的 update_check（多台機器共用）；查不到就不顯示，不影響使用
// - 環境變數 UPDATE_CHECK=0 關掉；只有管理員看得到
// - 測試不連 GitHub：createApp 的 config.updateFetch 換成假的 fetch
import { APP_VERSION, cmpVersion } from './version.js';

export const UPDATE_REPO = 'alansid/aigile-oss';
const DAY_MS = 24 * 3600_000;
const TIMEOUT_MS = 5000;

export function registerUpdateCheck({ route, db, requireAdmin, requireHuman, config = {} }) {
  const enabled = !(config.updateCheck === false || String(config.updateCheck ?? '') === '0');
  const doFetch = config.updateFetch || ((...a) => fetch(...a));
  const load = async () => { try { return JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'update_check'"))?.value || 'null'); } catch { return null; } };
  const save = v => db.run("INSERT INTO app_settings (key, value) VALUES ('update_check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(v));

  async function latest() {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await doFetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aigile-switch-update-check' }, signal: ctl.signal });
      if (!r.ok) return { failed: true }; // 查不到（GitHub 回錯誤、還沒有這個 repo 或發行版）：畫面寫「查不到」，不寫「已經是最新版」
      const j = await r.json();
      const version = String(j.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+/.test(version) || j.draft || j.prerelease) return null;
      return { version, name: String(j.name || '').slice(0, 120), url: /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : `https://github.com/${UPDATE_REPO}/releases` };
    } catch { return { failed: true }; } finally { clearTimeout(timer); }
  }

  route('GET', '/api/admin/update-check', async ({ ctx, me }) => {
    requireHuman(me);
    await requireAdmin(ctx, me, '看新版本');
    if (!enabled) return { enabled: false, current: APP_VERSION };
    let c = await load();
    if (!c || !(Date.now() - Number(c.at) < DAY_MS)) {
      const l = await latest();
      c = { at: Date.now(), latest: l?.failed ? null : l, failed: !!l?.failed }; // 查不到也記下時間：一天內不重查
      await save(c);
    }
    const l = c.latest;
    return { enabled: true, current: APP_VERSION, checkedAt: new Date(Number(c.at)).toISOString(), ...(c.failed ? { failed: true } : {}), ...(l && cmpVersion(l.version, APP_VERSION) > 0 ? { newer: l } : {}) };
  });
}
