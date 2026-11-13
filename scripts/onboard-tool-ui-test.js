// 短版接入依工具出文字（「複製接入文字」變主要做法；真的瀏覽器，中文、英文介面都驗）
// 1. API：GET …/onboarding、POST …/onboarding-link 收 tool（claude／codex／other），不認得的值當沒帶；接入設定內容不分工具（opencode 那段照舊）
// 2. 我的 AI 那一列主按鈕「複製接入文字」；接入分頁有工具三格（Claude Code｜Codex｜其他）、主要「複製接入文字」、次要「複製完整版」，
//    「只複製 Token」只留在 ⋯；沒選過工具按複製＝不複製，展開接入分頁、黃底提示、焦點到工具
// 3. 短版文字：Codex 才帶開網路那段；Claude Code、其他不帶；選的工具記在這個瀏覽器，重新整理還在
// 4. 重發 Token 後的視窗：沒選過工具時在視窗裡選、選之前複製鈕停用；新 Token 到期不寫秒；按鈕寫工具名
// 5. 英文介面：按鈕、提示、toast 都是英文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/onboard-tool-ui-test.js（找不到瀏覽器就略過 2～5）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

const kit = await startKit('tool');
try {
  const { call } = kit;
  const P = '預設專案';
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const newAi = async name => (await call(boss.token, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const A = await newAi('志明的程式開發'), B = await newAi('志明的測試');

  // ---------- 1. API ----------
  const linkText = async tool => {
    const l = await call(boss.token, `/api/my-ais/${A.participantId}/onboarding-link`, 'POST', { autoStandby: true, ...(tool !== undefined ? { tool } : {}) });
    assert.equal(l.status, 200, 'onboarding-link 收 tool：' + tool);
    const r = await fetch(kit.BASE + new URL(l.body.url).pathname);
    assert.equal(r.status, 200);
    return (await r.text()).replace(/[A-Za-z0-9_-]{40,}/g, 'TOKEN').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TIME'); // 每次讀連結都發新 Token
  };
  const base = await linkText(undefined);
  for (const t of ['claude', 'codex', 'other', 'bogus']) assert.equal(await linkText(t), base, `一次性連結：tool=${t} 內容跟沒帶一樣（接入設定不分工具）`);
  assert.match(base, /aigile-opencode\.mjs/, '接入設定照舊有 opencode 的接法');
  for (const t of ['codex', 'bogus']) assert.equal((await call(boss.token, `/api/my-ais/${A.participantId}/onboarding?tool=${t}`)).status, 200, `完整版 GET 收 tool=${t}`);
  assert.equal((await call(boss.token, `/api/my-ais/${A.participantId}/onboarding`, 'POST', { tool: 'claude' })).status, 200, '完整版 POST 收 tool');
  console.log('onboard-tool-ui-test：API 通過');

  if (!findBrowser()) { console.log('onboard-tool-ui-test：略過畫面（找不到 Chrome／Edge）'); await kit.stop(); process.exit(0); }
  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const setLang = async l => { await cdp('Page.navigate', { url: kit.BASE + '/' }); await until(() => js('document.readyState === "complete"'), 15000, '首頁'); await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  const row = id => `document.querySelector('#ai-list [data-ma="${id}"]')`;
  // 攔下複製的內容（無頭瀏覽器沒有剪貼簿權限）
  const hookClip = () => js("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip = t; } } }); window.__clip = null; true");
  const toMyAi = async () => {
    await login(boss.token, '/my-ai');
    await until(() => js(`!!${row(A.participantId)} && !!${row(B.participantId)}`), 15000, '我的 AI 列表');
    await hookClip();
  };
  const toast = () => js("document.querySelector('#toast').textContent");
  const copied = async (label, wantToast) => {
    await until(async () => (await js('window.__clip')) && (await toast()) === wantToast, 8000, label + '：' + await toast());
    const t = await js('window.__clip'); await js('window.__clip = null; true'); return t;
  };
  const CODEX = /sandbox_mode = "workspace-write"|Codex/;

  for (const lang of ['zh', 'en']) {
    const zh = lang === 'zh', L = (z, e) => (zh ? z : e);
    await setLang(lang);
    await toMyAi();
    // 2. 列上主按鈕；沒選過工具：不複製，展開接入分頁、提示、焦點到工具
    assert.equal(await js(`${row(A.participantId)}.querySelector('.ma-row .ma-copy').textContent`), L('複製接入文字', 'Copy onboarding text'), lang + '：列上主按鈕');
    await js(`${row(A.participantId)}.querySelector('.ma-row .ma-copy').click(); true`);
    await until(() => js(`!!${row(A.participantId)}?.querySelector('.ma-tool-ask')`), 5000, lang + '：沒選工具提示');
    let tab = await J(`(() => { const it = ${row(A.participantId)};
      return { open: it.classList.contains('open'), tab: it.querySelector('.ma-tabs [aria-selected="true"]')?.dataset.tab, ask: it.querySelector('.ma-tool-ask').textContent,
        tools: [...it.querySelectorAll('.ma-tool button')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')), focus: document.activeElement?.dataset.tool || '',
        btns: [...it.querySelectorAll('.ma-btns .btn')].map(b => (b.classList.contains('primary') ? '*' : '') + b.textContent), token: !!it.querySelector('.ma-btns [data-act="token"]'),
        hint: it.querySelector('.ma-tool').closest('.ma-f').nextElementSibling.textContent }; })()`);
    assert.deepEqual(tab, { open: true, tab: 'conn', ask: L('第一次複製前先選工具：你的 AI 用哪一個？', 'Pick a tool before the first copy: which one does your AI use?'),
      tools: ['Claude Code:false', 'Codex:false', L('其他', 'Other') + ':false'], focus: 'claude',
      btns: [L('*複製接入文字', '*Copy onboarding text'), L('複製完整版', 'Copy full version')], token: false,
      hint: L('選了會記住，下次不用再選。opencode 等其他工具選「其他」；Codex 版會多幾行「怎麼開網路」。', 'Your choice is remembered, so you only pick once. For opencode and other tools, pick "Other". The Codex version adds a few lines on turning on network access.') }, lang + '：接入分頁');
    assert.equal(await js('window.__clip'), null, lang + '：沒選工具不複製');
    assert.equal(await js(`!!${row(A.participantId)}.querySelector('.ma-menu')`), false);
    await js(`${row(A.participantId)}.querySelector('[data-act="menu"]').click(); true`);
    assert.equal(await js(`!!${row(A.participantId)}.querySelector('.ma-menu [data-act="token"]')`), true, lang + '：只複製 Token 留在 ⋯');
    await js(`${row(A.participantId)}.querySelector('[data-act="menu"]').click(); true`);

    // 3. 依工具出文字
    const pick = async (v, name) => {
      await js(`${row(A.participantId)}.querySelector('[data-tool="${v}"]').click(); true`);
      await until(() => js(`${row(A.participantId)}.querySelector('[data-tool="${v}"]').getAttribute('aria-pressed') === 'true'`), 3000, lang + '：選 ' + v);
      assert.equal(await js(`!!${row(A.participantId)}.querySelector('.ma-tool-ask')`), false, '選了提示就收起來');
      await js(`${row(A.participantId)}.querySelector('.ma-btns .btn.primary').click(); true`);
      return copied(lang + ' ' + v, name ? L(`已複製 ${name} 版接入文字（連結 15 分鐘內有效、只能讀一次）`, `Copied the ${name} onboarding text (link valid for 15 minutes, can be read once)`)
        : L('已複製接入文字（連結 15 分鐘內有效、只能讀一次）', 'Copied the onboarding text (link valid for 15 minutes, can be read once)'));
    };
    let t = await pick('codex', 'Codex');
    assert.match(t, /sandbox_mode = "workspace-write"/, lang + '：Codex 版有開網路');
    assert.match(t, /network_access = true/);
    assert.ok(t.indexOf('network_access') < t.indexOf('curl -s'), '開網路寫在下載之前');
    assert.match(t, /curl -s --create-dirs -o \.aigile\/PG_\w+\/setup\.md "http:\/\/127\.0\.0\.1:\d+\/api\/setup\/p_\w+\.\S+"/, '一次性連結');
    assert.match(t, /你是「志明的程式開發」/);
    const len = { codex: t.length };
    t = await pick('claude', 'Claude Code');
    assert.doesNotMatch(t, CODEX, lang + '：Claude Code 版不帶 Codex 那段');
    assert.match(t, /curl -s --create-dirs/); assert.match(t, /重按「複製接入文字」/, '已失效時請人重按「複製接入文字」');
    len.claude = t.length;
    t = await pick('other');
    assert.doesNotMatch(t, CODEX, lang + '：其他（opencode 等）不帶 Codex 那段');
    assert.ok(len.claude < len.codex, `Claude Code 版比 Codex 版短（${len.claude}／${len.codex}）`);
    assert.deepEqual(JSON.parse(await js("localStorage.getItem('aigile-ai-tools')")), { [A.participantId]: 'other' }, '工具記在這個瀏覽器');

    // 重新整理還記得；列上主按鈕直接複製
    await toMyAi();
    await js(`${row(A.participantId)}.querySelector('.ma-row').click(); true`);
    await until(() => js(`${row(A.participantId)}?.querySelector('[data-tool="other"]')?.getAttribute('aria-pressed') === 'true'`), 5000, lang + '：重新整理還記得');
    await js(`${row(A.participantId)}.querySelector('.ma-row .ma-copy').click(); true`);
    assert.doesNotMatch(await copied(lang + '：列上直接複製', L('已複製接入文字（連結 15 分鐘內有效、只能讀一次）', 'Copied the onboarding text (link valid for 15 minutes, can be read once)')), CODEX);

    // 4. 重發 Token 後的視窗：B 沒選過工具 → 在視窗裡選，選之前複製鈕停用
    const reissue = async id => {
      await js(`${row(id)}.querySelector('[data-act="menu"]').click(); true`);
      await js(`${row(id)}.querySelector('.ma-menu [data-act="reissue"]').click(); true`);
      await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '重發確認');
      await js("document.querySelector('.confirm-root [data-ok]').click(); true");
      await until(() => js("!!document.querySelector('#modal-root #tok-short')"), 8000, lang + '：重發後視窗');
      await sleep(300);
    };
    await reissue(B.participantId);
    let m = await J(`(() => { const m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('.modal-head h2, .modal-title, h2')?.textContent.trim(), short: m.querySelector('#tok-short').textContent, dis: m.querySelector('#tok-short').disabled, primary: m.querySelector('#tok-short').classList.contains('primary'),
        tok: m.querySelector('#tok-copy').textContent, tools: [...m.querySelectorAll('[data-tok-tool]')].map(b => b.textContent), ask: m.querySelector('.ma-tool-ask')?.textContent || '', exp: m.querySelector('.modal-body p b').textContent,
        bg: getComputedStyle(m.querySelector('#tok-short')).backgroundColor }; })()`);
    assert.equal(m.short, L('複製接入文字', 'Copy onboarding text'), lang + '：沒選工具的按鈕');
    assert.ok(m.dis && m.primary, '沒選工具時複製鈕停用');
    assert.notEqual(m.bg, 'rgb(37, 99, 235)', '停用時是灰的，不是藍的：' + m.bg);
    assert.equal(m.tok, L('只複製 Token', 'Copy token only'));
    assert.deepEqual(m.tools, ['Claude Code', 'Codex', L('其他', 'Other')]);
    assert.equal(m.ask, L('第一次複製前先選工具：你的 AI 用哪一個？', 'Pick a tool before the first copy: which one does your AI use?'));
    assert.doesNotMatch(m.exp, /\d\d:\d\d:\d\d/, '新 Token 到期不寫秒：' + m.exp);
    await js("document.querySelector('#modal-root [data-tok-tool=\"codex\"]').click(); true");
    m = await J("(() => { const b = document.querySelector('#modal-root #tok-short'); return { t: b.textContent, dis: b.disabled, ask: !!document.querySelector('#modal-root .ma-tool-ask') }; })()");
    assert.deepEqual(m, { t: L('複製接入文字（Codex）', 'Copy onboarding text (Codex)'), dis: false, ask: false }, lang + '：視窗裡選了工具');
    await js("document.querySelector('#modal-root #tok-short').click(); true");
    assert.match(await copied(lang + '：視窗裡複製', L('已複製 Codex 版接入文字（連結 15 分鐘內有效、只能讀一次）', 'Copied the Codex onboarding text (link valid for 15 minutes, can be read once)')), /sandbox_mode/);
    await js("document.querySelector('#modal-root [data-close]')?.click(); true");
    await sleep(300);
    // A 選過工具：視窗不再問，按鈕直接寫工具名
    await reissue(A.participantId);
    m = await J("(() => { const m = document.querySelector('#modal-root .modal'); return { t: m.querySelector('#tok-short').textContent, dis: m.querySelector('#tok-short').disabled, picker: !!m.querySelector('.tok-tool') }; })()");
    assert.deepEqual(m, { t: L('複製接入文字（其他）', 'Copy onboarding text (Other)'), dis: false, picker: false }, lang + '：選過工具的重發視窗');
    await js("document.querySelector('#modal-root [data-close]')?.click(); true");
    await js("localStorage.removeItem('aigile-ai-tools'); true"); // 換語言從頭再驗一次
    console.log(`onboard-tool-ui-test：${zh ? '中文' : '英文'}通過`);
  }
  console.log('onboard-tool-ui-test：全部通過');
} catch (e) {
  console.error('onboard-tool-ui-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('onboard-tool-ui-test.js')) || ''); process.exitCode = 1;
} finally { await kit.stop(); }
