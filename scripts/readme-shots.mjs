// README 截圖重拍：開本機暫存站（全新資料夾）＋無頭 Chrome／Edge，載入示範資料後拍 docs/images/readme/ 的 18 張圖
// 用法：node scripts/readme-shots.mjs            中英文都拍
//       node scripts/readme-shots.mjs zh         只拍中文（或 en）
//       node scripts/readme-shots.mjs en wizard  只拍英文的 wizard（名字可以多個：hero board inbox team skills my-ai mobile wizard）
// 資料：照新站啟動（有預設管理員）→ 管理員改名成假名（林志明／Alex Chen）→ 拍第一次設定引導 → 全部略過
//       → 載入示範資料（英文介面載英文內容）→ 建一隻自己的 AI、上傳兩個示範技能 → 讓示範 AI 顯示在線／待命 → 各頁拍照
// 只拍圖、不檢查任何東西（不是測試；檔名不是 -test.js，run-all 不會跑）。找不到瀏覽器就結束
// PNG 會重新壓縮（去掉透明通道、試幾種濾波取最小、最高壓縮），不用裝套件；尺寸照舊（桌機 1280×800、手機並排 822×860）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const OUT = path.join(ROOT, 'docs', 'images', 'readme');
const ALL = ['wizard', 'hero', 'inbox', 'board', 'team', 'skills', 'my-ai', 'mobile'];
const args = process.argv.slice(2);
const LANGS = args.filter(a => a === 'zh' || a === 'en');
const ONLY = args.filter(a => ALL.includes(a));
const want = n => !ONLY.length || ONLY.includes(n);

// 每種語言的示範文字（人名一律假名；示範專案的成員與內容由 src/demo.js 產生）
// question：「選項：」是 AI 協定的標籤（網頁靠它把選項變成按鈕），英文也照原文；英文版不寫「建議：」，少一行中文
const T = {
  zh: {
    admin: '林志明', username: 'chiming.lin', myAi: '開發助手', myAiRole: '程式開發',
    myAiSettings: { duties: '寫程式、修問題、補測試', style: '先說結論，再列細節', autonomy: '卡片範圍內的修改直接做', mustConfirm: '部署、刪資料、改權限', handoff: '做完發 [完成] 並附測試結果' },
    question: '[需確認] DEMO-5 匯出報名名單：名單要匯出哪些欄位？\n\n選項：\nA. 姓名、Email、報名時間\nB. 全部欄位（含備註）\n建議：A',
    skills: [
      { name: 'release-check', description: '上線前檢查：跑測試、看手機版、核對設定，列出還沒做的項目', body: '# 上線前檢查\n\n1. 跑全部測試\n2. 用手機寬度看一次主要頁面\n3. 核對環境變數\n4. 列出還沒做的項目\n' },
      { name: 'event-email', description: '活動通知信：寫報名確認、提醒、候補通知信，套用固定格式與語氣', body: '# 活動通知信\n\n- 開頭稱呼、活動名稱、時間地點\n- 一封信只講一件事\n- 結尾附聯絡方式\n' },
    ],
  },
  en: {
    admin: 'Alex Chen', username: 'alex.chen', myAi: 'Dev-Assistant', myAiRole: 'Developer',
    myAiSettings: { duties: 'Write code, fix bugs, add tests', style: 'Conclusion first, then details', autonomy: 'Changes within the card: just do them', mustConfirm: 'Deploys, deleting data, permission changes', handoff: 'Post [完成] with test results when done' },
    question: '[需確認] DEMO-5 Export the sign-up list: which columns should the export include?\n\n選項：\nA. Name, email and sign-up time\nB. All columns (including notes)',
    skills: [
      { name: 'release-check', description: 'Pre-release check: run tests, check the mobile layout, verify settings and list what is left', body: '# Pre-release check\n\n1. Run all tests\n2. Check the main pages at phone width\n3. Verify environment variables\n4. List what is still missing\n' },
      { name: 'event-email', description: 'Event emails: sign-up confirmations, reminders and waiting-list notices in a fixed format and tone', body: '# Event emails\n\n- Greeting, event name, time and place\n- One topic per email\n- Contact details at the end\n' },
    ],
  },
};

// ---------- PNG 重新壓縮（只處理 Chrome 輸出的 8 位元、不交錯 PNG） ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, type = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12]) throw new Error('不支援的 PNG'); }
    else if (name === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type]; if (!bpp) throw new Error('不支援的 PNG 色彩類型 ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[i] = (src[i] + [0, a, b, (a + b) >> 1, p][f]) & 255;
    }
  }
  // 一律轉成 RGB（截圖沒有透明）
  if (bpp === 3) return { w, h, px };
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
  return { w, h, px: rgb };
}
// 濾波：mode＝0～4 每列固定用同一種，'h'＝每列挑差值總和最小的；截圖大片同色，通常整張不濾波（0）最小，幾種都試、取最小
function filterRows({ w, h, px }, mode) {
  const stride = w * 3, out = Buffer.alloc(h * (stride + 1)), cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      if (mode !== 'h' && f !== mode) continue;
      const o = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = up ? up[i] : 0, c = up && i >= 3 ? up[i - 3] : 0;
        let p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const v = (row[i] - [0, a, b, (a + b) >> 1, p][f]) & 255; o[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best; cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}
function encodePng(img) {
  const idat = [0, 'h', 2].map(m => zlib.deflateSync(filterRows(img, m), { level: 9, memLevel: 9 })).sort((a, b) => a.length - b.length)[0];
  const chunk = (name, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const nd = Buffer.concat([Buffer.from(name, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(nd)); return Buffer.concat([len, nd, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const save = (name, b64) => { const f = path.join(OUT, name); fs.writeFileSync(f, encodePng(decodePng(Buffer.from(b64, 'base64')))); console.log(`  ${name}  ${fs.statSync(f).size.toLocaleString()} bytes`); };

// ---------- 拍一種語言 ----------
async function shoot(lang) {
  const L = T[lang], sfx = `.${lang}`;
  console.log(`[${lang}]`);
  const kit = await startKit('readme-' + lang, { env: { AIGILE_TEST_PROJECTS: '', UPDATE_CHECK: '0', ADMIN_PASSWORD: '' } }); // 照新站啟動：有預設管理員與第一次設定引導
  try {
    const call = async (tok, p, m = 'GET', b, headers = {}) => {
      const r = await fetch(kit.BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined });
      const body = await r.json().catch(() => ({}));
      if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${JSON.stringify(body)}`);
      return body;
    };
    const bump = () => kit.sql("INSERT INTO app_settings (key, value) VALUES ('people_ver', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", 'shots' + Date.now()); // 直接改資料庫後讓伺服器重讀成員
    // 管理員：改帳密（新站一定要先改）、顯示名稱換成假名
    const tok = (await call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).token;
    await call(tok, '/api/me/password', 'PUT', { username: L.username, currentPassword: 'admin', newPassword: 'readme-shots-9', newPasswordAgain: 'readme-shots-9' });
    const me = await call(tok, '/api/me');
    kit.sql('UPDATE participants SET name = ? WHERE id = ?', L.admin, me.participantId); bump();

    const { cdp, js } = await kit.browser(1280, 800);
    const size = (width, height, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const shot = async () => (await cdp('Page.captureScreenshot', { format: 'png' })).result.data;
    const settle = async (ms = 600) => { await js('document.fonts.ready.then(() => true)'); await sleep(ms); };
    const go = async (page, ready) => {
      await cdp('Page.navigate', { url: kit.BASE + page });
      await until(() => js("document.readyState === 'complete' && !!document.querySelector('.av-btn')"), 20000, '開頁 ' + page);
      if (ready) await until(() => js(ready), 15000, '畫面 ' + page);
      await settle();
    };
    // 語言、主題記在瀏覽器；登入用 Token
    await size(1280, 800);
    await cdp('Page.navigate', { url: kit.BASE + '/' });
    await until(() => js('document.readyState === "complete"'), 15000, '首頁');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); localStorage.setItem('aigile-switch-theme', 'light'); localStorage.setItem('aigile-switch-token', ${JSON.stringify(tok)}); true`);

    // 1. 第一次設定引導（第 2 步：第一個專案）
    await go('/', "!!document.querySelector('#sw .sw-steps')");
    if (want('wizard')) {
      await js("document.querySelector('[data-sw=\"group\"]').click(); true");
      await until(() => js("!!document.querySelector('#sw-pj-name')"), 8000, '引導第 2 步');
      await js('document.activeElement?.blur(); true');
      await settle();
      save(`wizard${sfx}.png`, await shot());
    }
    await js("document.querySelector('[data-sw=\"skipall\"]').click(); true");
    await sleep(1500);

    // 2. 資料：示範資料、自己的 AI、兩個技能、示範 AI 在線、一題等你回答的 [需確認]
    const demo = await call(tok, '/api/admin/demo', 'POST', { lang });
    const pj = demo.projectId;
    // 自己的 AI 放在預設專案：示範專案的訊息頁、團隊狀態只出現示範成員
    await call(tok, '/api/my-ais', 'POST', { projects: [me.projects[0]], roleKey: 'PG', role: L.myAiRole, name: L.myAi, ...L.myAiSettings });
    for (const s of L.skills) await call(tok, `/api/projects/${encodeURIComponent(pj)}/skills`, 'POST', { files: [{ path: 'SKILL.md', text: `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}` }] });
    // 示範 AI：開發助手在線（負責進行中的卡＝在做）、設計助手待命（watcher 心跳）；示範成員的 Token 本來是過期的，先延長
    const people = (await call(tok, '/api/participants')).items;
    const demoAi = people.filter(p => p.memberType === 'ai' && p.ownerParticipantId !== me.participantId);
    kit.sql(`UPDATE participants SET token_expires_at = ? WHERE id IN (${demoAi.map(() => '?').join(',')})`, Date.now() + 7 * 86400_000, ...demoAi.map(p => p.participantId)); bump();
    await sleep(1200);
    for (const p of demoAi) await call(kit.aiToken(p.participantId), '/api/me', 'GET', null, p.roleKey === 'UX' ? { 'x-aigile-source': 'watcher' } : {});
    // 示範資料裡的 [需確認] 是問產品負責人（也已經回了）；主圖要「按選項回答」，所以讓開發助手再問你一題（掛在「匯出報名名單」那張卡）
    const dev = demoAi.find(p => p.roleKey === 'PG');
    await call(kit.aiToken(dev.participantId), '/api/messages', 'POST', { text: L.question, project: pj, cardId: 'DEMO-5', recipientIds: [me.participantId], replyFrom: [me.participantId], requestId: 'readme-shots-q' });
    // 用 API 登入會留一則「新裝置登入」的帳號提醒，先標已讀，免得出現在畫面上
    const notices = (await call(tok, '/api/me/notices')).items || [];
    if (notices.length) await call(tok, '/api/me/notices/read', 'POST', { ids: notices.map(n => n.id) });
    const P = '/p/demo';

    // 3. 各頁（1280×800）
    // 訊息頁：最後一組（等你回答的那題）的卡片標題放在 AI 現況列下面，不被蓋住
    const showLastGroup = async () => {
      await js(`(() => { const g = [...document.querySelectorAll('#messages .cgrp')].pop(), sc = document.querySelector('#messages'), bar = document.querySelector('#ai-now');
        const lim = Math.max(sc.getBoundingClientRect().top, bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0) + 12;
        sc.scrollTop += g.getBoundingClientRect().top - lim; return true; })()`);
      await settle();
    };
    if (want('hero')) {
      for (const theme of ['light', 'dark']) {
        await js(`localStorage.setItem('aigile-switch-theme', '${theme}'); true`);
        await go(`${P}/messages`, "!!document.querySelector('#messages .need-me')");
        await showLastGroup();
        save(`hero-messages${sfx}${theme === 'dark' ? '.dark' : ''}.png`, await shot());
      }
      await js("localStorage.setItem('aigile-switch-theme', 'light'); true");
    }
    if (want('inbox')) { await go(`${P}/inbox`); save(`inbox${sfx}.png`, await shot()); }
    if (want('board')) { await go(`${P}/work`, "!!document.querySelector('[data-view=\"B\"]')"); await js("document.querySelector('[data-view=\"B\"]').click(); true"); await settle(); save(`board${sfx}.png`, await shot()); }
    if (want('team')) { await go(`${P}/team`); save(`team${sfx}.png`, await shot()); }
    if (want('skills')) { await go('/members', "!!document.querySelector('[data-pm-tab=\"skills\"]')"); await js("document.querySelector('[data-pm-tab=\"skills\"]').click(); true"); await settle(1000); save(`skills${sfx}.png`, await shot()); }
    if (want('my-ai')) {
      await go('/my-ai', "!!document.querySelector('.ma-row')");
      await js("document.querySelector('.ma-row').click(); true");
      await until(() => js("!!document.querySelector('.ma-tool button')"), 8000, '接入分頁');
      await js("document.querySelector('.ma-tool [data-tool=\"claude\"]')?.click(); document.activeElement?.blur(); true");
      await settle(1000);
      save(`my-ai${sfx}.png`, await shot());
    }

    // 4. 手機（375 寬）：左邊訊息頁（等你回答的那題）、右邊「要你處理」，並排成一張
    if (want('mobile')) {
      const W = 375, H = 812, M = 24;
      await size(W, H, true);
      await go(`${P}/messages`, "!!document.querySelector('#messages .need-me')");
      await showLastGroup();
      const left = await shot();
      await go(`${P}/inbox`);
      const right = await shot();
      await size(W * 2 + M * 3, H + M * 2);
      await cdp('Page.navigate', { url: 'about:blank' });
      await until(() => js("document.readyState === 'complete'"), 5000, '空白頁');
      await js(`(() => { document.body.style.cssText = 'margin:0;padding:${M}px;display:flex;gap:${M}px;background:#e4e7ec';
        for (const b64 of ${JSON.stringify([left, right])}) { const i = new Image(); i.src = 'data:image/png;base64,' + b64; i.style.cssText = 'width:${W}px;height:${H}px;border-radius:18px;box-shadow:0 2px 10px rgba(0,0,0,.12)'; document.body.append(i); }
        return Promise.all([...document.images].map(i => i.decode())).then(() => true); })()`);
      save(`mobile${sfx}.png`, await shot());
      await size(1280, 800);
    }
  } finally {
    await kit.stop();
  }
}

if (!findBrowser()) { console.log('readme-shots：找不到 Chrome／Edge，沒有拍'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
for (const lang of LANGS.length ? LANGS : ['zh', 'en']) await shoot(lang);
