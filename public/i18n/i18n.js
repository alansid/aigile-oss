// 中英介面切換。語言記在這台瀏覽器（aigile-lang）；沒選過就看瀏覽器語言：zh 開頭＝中文，其他＝英文
// 英文時載入 /i18n/en.js（中文原文當 key），把畫面上的文字、placeholder、title、aria-label 換成英文；沒翻到的照舊顯示中文
// 不翻：訊息內文、文件、卡片標題等使用者寫的內容（SKIP），以及 textarea、code、pre。存進資料庫的內容一律不改
(() => {
  const KEY = 'aigile-lang';
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  const lang = saved === 'en' || saved === 'zh' ? saved : (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  const setLang = l => { try { localStorage.setItem(KEY, l); } catch {} location.reload(); };
  // 切換鈕：任何地方放 <button data-lang="en"> 就能用
  document.addEventListener('click', e => { const b = e.target.closest?.('[data-lang]'); if (b && b.dataset.lang !== lang) setLang(b.dataset.lang); });
  const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)) : String(s));
  let readyDone; const ready = new Promise(r => { readyDone = r; }); // 英文字典載好（中文直接好了）；app.js 畫第一個畫面前等它
  const api = { lang, setLang, t: fill, tr: () => null, err: (code, msg) => msg, autoMsg: s => s, ready };
  window.aigileI18n = api;
  if (lang !== 'en') { readyDone(); return; }

  const HAN = /[㐀-鿿]/;
  const SKIP = '.msg-text,.msg-rest,.dm-text,.dmsg-text,.md-doc,.cr-title,.sw-text,code,pre,textarea,script,style,[data-nt]';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-short']; // data-short：手機版用 CSS attr() 顯示的短字
  let exact = {}, pats = [], auto = { msg: [], part: [] };
  const norm = s => s.replace(/\s+/g, ' ').trim();
  function load(EN) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [k, v] of Object.entries(EN.dict || {})) {
      if (!/\{\d+\}/.test(k)) { exact[k] = v; continue; }
      const parts = k.split(/\{\d+\}/), idx = [...k.matchAll(/\{(\d+)\}/g)].map(m => +m[1]);
      const hanOf = s => (s.match(new RegExp(HAN.source, 'g')) || []).length;
      const probe = parts.reduce((a, b) => (hanOf(b) > hanOf(a) || (hanOf(b) === hanOf(a) && b.length > a.length) ? b : a), ''); // 中文最多的那段拿來快速篩
      const han = hanOf(parts.join(''));
      if (!han) continue; // 只有變數、沒有中文的不比對
      if (han < 2 && /^\{\d+\}/.test(k) && /\{\d+\}$/.test(k)) continue; // 「{0}的{1}」這種兩頭都是變數又只有一個字的太寬，會誤翻
      if (han < 3 && (/^\{\d+\}[㐀-鿿]/.test(k) || /[㐀-鿿]\{\d+\}$/.test(k))) continue; // 「{0}助手」這種變數緊貼短中文的，會把名字（示範助手）翻一半
      pats.push({ re: new RegExp('^' + parts.map(esc).join('(.*?)') + '$', 's'), idx, v, probe, lit: parts.join('').length });
    }
    pats.sort((a, b) => b.lit - a.lit); // 固定文字多的先比，免得短的先吃掉整句
    auto = { msg: EN.auto?.msg || [], part: EN.auto?.part || [] };
    api.err = (code, msg) => (code && EN.errors?.[code]) || tr(msg) || msg;
  }
  // 英文單複數：數字剛好是 1 時，後面（或隔一個形容詞，例：1 new messages）的名詞改單數
  const SING = { members: 'member', messages: 'message', cards: 'card', AIs: 'AI', projects: 'project', replies: 'reply', items: 'item', people: 'person',
    days: 'day', hours: 'hour', minutes: 'minute', seconds: 'second', weeks: 'week', mentions: 'mention', requests: 'request', invites: 'invite', skills: 'skill',
    files: 'file', humans: 'human', tasks: 'task', decisions: 'decision', versions: 'version', results: 'result', notifications: 'notification', devices: 'device',
    changes: 'change', times: 'time', links: 'link', roles: 'role', questions: 'question', suggestions: 'suggestion', assignees: 'assignee', owners: 'owner',
    msgs: 'msg', unread: 'unread', pending: 'pending', documents: 'document', folders: 'folder', tokens: 'token', approvals: 'approval', joins: 'join' };
  const plural = s => String(s).replace(/(^|[^\d.,:/])1 ([A-Za-z]+)(?: ([A-Za-z]+))?/g, (m, pre, a, b) =>
    SING[a] ? `${pre}1 ${SING[a]}${b ? ' ' + b : ''}` : b && SING[b] ? `${pre}1 ${a} ${SING[b]}` : m);
  api.plural = plural;
  // 整段比對；回 null＝沒翻到
  function tr(s) {
    const k = norm(String(s || ''));
    if (!k || !HAN.test(k)) return null;
    if (k in exact) return exact[k];
    // 前面是符號／表情（例：「🔍 找名字」「＋ 新增專案」）：留著符號，翻後面
    const sym = /^([^\p{L}]+?)(\p{Script=Han}[\s\S]*)$/u.exec(k); // 也含「1. 群組名稱」這種編號
    if (sym) { const r = tr(sym[2]); if (r != null) return sym[1] + r; }
    for (const p of pats) {
      if (!k.includes(p.probe)) continue;
      const m = p.re.exec(k);
      if (m) return plural(p.v.replace(/\{(\d+)\}/g, (x, i) => { const pos = p.idx.indexOf(+i); return pos >= 0 ? (tr(m[pos + 1]) ?? m[pos + 1]) : x; }));
    }
    return null;
  }
  api.tr = tr;
  // 平台依固定句型自動發的通知（訊息帶 auto: true，例：「建立卡片，等 X 決定」）：英文介面整句換成英文，規則在 en.js 的 auto
  // 開頭的協定標籤、【專案】、卡號、人名、卡片標題、使用者寫的原因都照原文；存進資料庫的內容不動
  // 樣板：{n}＝原文照留；{n:t}＝查字典（狀態）；{n:s}＝再用 auto.part 逐段翻（以「；」與換行分段）；{n:c}＝同上、以「，」分段；{n:l}＝清單（「、」改「, 」）
  const SEP = { '；': '; ', '，': ', ' };
  const segs = (v, sep) => v.split(sep).map((p, i) => (i % 2 ? SEP[p] ?? p : rule(auto.part, p) ?? p)).join('');
  function rule(list, s) {
    for (const [re, tpl] of list) {
      const m = re.exec(s);
      if (m) return tpl.replace(/\{(\d+)(?::([tscl]))?\}/g, (x, i, f) => {
        const v = m[i] ?? '';
        return f === 't' ? tr(v) ?? v : f === 's' ? segs(v, /(；|\n)/) : f === 'c' ? segs(v, /(，)/) : f === 'l' ? v.split('、').join(', ') : v;
      });
    }
    return null;
  }
  api.autoMsg = text => {
    const s = String(text ?? ''), h = /^(\s*\[[^\]\n]{1,40}\]\s?)(【[^】\n]{1,40}】)?/.exec(s);
    const out = h && rule(auto.msg, s.slice(h[0].length));
    if (out == null) return s; // 對不上固定句型就照原文
    return h[1] + (h[2] === '【全部專案】' ? `【${exact['全部專案'] || 'All projects'}】` : h[2] || '') + plural(out);
  };
  api.t = (s, v) => fill(tr(s) ?? s, v);
  const skipped = el => !!el?.closest?.(SKIP);
  function fixText(n) {
    const v = n.nodeValue;
    if (!v || !HAN.test(v) || skipped(n.parentElement)) return;
    const t = tr(v);
    if (t == null) return;
    n.nodeValue = v.match(/^\s*/)[0] + t + v.match(/\s*$/)[0];
  }
  function fixEl(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && HAN.test(v)) { const t = tr(v); if (t != null) el.setAttribute(a, t); }
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1) return;
    if (root.tagName === 'TEXTAREA') { if (!skipped(root.parentElement)) fixEl(root); return; }
    if (skipped(root)) return;
    fixEl(root);
    // textarea：內容不翻，但 placeholder 等屬性要翻
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (n.tagName === 'TEXTAREA' && !n.parentElement?.closest(SKIP)) { fixEl(n); return NodeFilter.FILTER_REJECT; }
      return n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? fixText(n) : fixEl(n));
  }
  // 等英文字典載好才顯示畫面，避免先閃一下中文
  document.documentElement.classList.add('i18n-wait');
  const s = document.createElement('script');
  s.src = '/i18n/en.js';
  s.onload = () => {
    try { load(window.AIGILE_EN || {}); } catch (e) { console.error('i18n load failed:', e); }
    readyDone();
    const start = () => {
      try {
        walk(document.head.querySelector('title') || document.head);
        walk(document.body);
      } catch (e) { console.error('i18n walk failed:', e); }
      new MutationObserver(recs => {
        for (const r of recs) {
          if (r.type === 'characterData') fixText(r.target);
          else if (r.type === 'attributes') { if (r.target.tagName === 'TEXTAREA' ? !skipped(r.target.parentElement) : !skipped(r.target)) fixEl(r.target); }
          else r.addedNodes.forEach(walk);
        }
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
      document.documentElement.classList.remove('i18n-wait');
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  };
  s.onerror = () => { document.documentElement.classList.remove('i18n-wait'); readyDone(); }; // 字典載不到就照中文顯示
  document.head.append(s);
})();
