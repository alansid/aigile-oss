// 示範資料：第一次設定引導與管理頁「成員與權限 › 系統」一鍵載入、看完一鍵清掉
// 內容：一個示範專案、兩位示範成員（一位人類、兩隻 AI）、幾張不同狀態的卡、一段人與 AI 的對話、一張等你決定的決策卡
// 標記：建了什麼記在 app_settings 的 demo_data；訊息與卡片的 request_id 一律以 demo: 開頭
// 清除只刪這些（含它們的通知、收件人、卡片紀錄）；示範專案裡如果有你們自己發的訊息或建的卡，專案保留、只刪示範的部分
// 內容是虛構的通用情境（活動報名網站），不含任何真實人名；示範成員不能登入（沒有密碼、登入碼已過期）
export const DEMO_KEY = 'demo_data';
const TAG = 'demo:';
// 示範內容的文字：網頁是英文介面時（lang=en）用英文。協定標籤（[接單]、[需確認]、選項：、建議：）、卡片狀態與類型是 AI／程式在解析的值，兩種語言都照原文
const TEXT = {
  zh: {
    project: '示範：活動報名網站', loaded: n => `${n} 載入示範資料`, created: t => `建立卡片（類型：${t}）`,
    po: '示範產品負責人', dev: '示範開發助手', ux: '示範設計助手', devDuties: '寫程式、修問題、補測試', uxDuties: '畫面設計與手機版檢查',
    cards: [
      { title: '報名表單', criteria: '必填欄位檢查、送出後顯示成功畫面' },
      { title: '報名成功寄確認信', next: '補上活動地圖連結，再寄一封測試信', criteria: '報名成功一分鐘內收到信' },
      { title: '活動頁手機版排版', next: '等產品負責人驗收', criteria: '375 寬不用左右捲動、按鈕好按' },
      { title: '線上付款', blocker: '還在等金流商開測試帳號', next: '帳號下來後先串測試環境' },
      { title: '匯出報名名單', next: '要匯出成試算表，欄位待確認' },
    ],
    dec: { title: '報名截止後要不要開放候補？', question: '報名截止後，額滿的人要不要可以登記候補？', recommendation: '開放候補：有人取消時依登記順序通知', options: ['開放候補', '不開放'],
      impact: '開放要多做一個候補名單與通知；不開放就直接顯示已額滿', afterNext: '決定後由示範開發助手接著做' },
    ref: c => `「${c.title}」`,
    msgs: (r, c) => [
      '這週先把報名成功的確認信做好，文案我晚點補。',
      `[接單] ${r(c.mail)} 報名成功寄確認信：我來做，先用純文字範本。`,
      `[進度] ${r(c.mail)}：寄信流程接好了，測試信已經寄到我自己的信箱。\n\n下一步：補上活動地圖連結。`,
      `[需確認] ${r(c.mail)}：確認信要不要附活動地圖？\n\n選項：\nA. 附地圖連結\nB. 不附，只寫地址\n建議：A`,
      '[回覆] A，附連結就好。',
      `[完成] ${r(c.mobile)} 活動頁手機版排版：375 寬檢查過，按鈕都放大了，請驗收。`,
      `[通知] ${r(c.dec)} 有一個決定等你：報名截止後要不要開放候補？（在收件匣「等你決定」）`,
    ],
  },
  en: {
    project: 'Demo: event sign-up site', loaded: n => `${n} loaded demo data`, created: t => `Card created (type: ${t})`,
    po: 'Demo-Product-Owner', dev: 'Demo-Dev-Assistant', ux: 'Demo-Design-Assistant', devDuties: 'Write code, fix bugs, add tests', uxDuties: 'Screen design and mobile checks',
    cards: [
      { title: 'Sign-up form', criteria: 'Required fields are checked; a success screen shows after submitting' },
      { title: 'Confirmation email after sign-up', next: 'Add the event map link, then send another test email', criteria: 'Email arrives within a minute of signing up' },
      { title: 'Mobile layout of the event page', next: 'Waiting for the product owner to verify', criteria: 'No sideways scrolling at 375px; buttons are easy to tap' },
      { title: 'Online payment', blocker: 'Still waiting for the payment provider to open a test account', next: 'Connect the test environment once the account is ready' },
      { title: 'Export the sign-up list', next: 'Export as a spreadsheet; columns to be confirmed' },
    ],
    dec: { title: 'Open a waiting list after sign-up closes?', question: 'After sign-up closes, can people register for a waiting list when the event is full?', recommendation: 'Open a waiting list: notify people in order when someone cancels', options: ['Open a waiting list', 'No waiting list'],
      impact: 'A waiting list means one more list and notifications; without it the page just says "Full"', afterNext: 'Once decided, Demo-Dev-Assistant takes it from there' },
    ref: c => `"${c.title}"`,
    msgs: (r, c) => [
      "Let's get the sign-up confirmation email done this week. I'll send the wording later.",
      `[接單] ${r(c.mail)} Confirmation email after sign-up: I'll take it, starting with a plain-text template.`,
      `[進度] ${r(c.mail)}: the email flow is connected, and a test email reached my own inbox.\n\nNext: add the event map link.`,
      `[需確認] ${r(c.mail)}: should the confirmation email include the event map?\n\n選項：\nA. Include a map link\nB. No map, just the address\n建議：A`,
      '[回覆] A, a link is enough.',
      `[完成] ${r(c.mobile)} Mobile layout of the event page: checked at 375px and made the buttons bigger. Please verify.`,
      `[通知] ${r(c.dec)} A decision is waiting for you: open a waiting list after sign-up closes? (Inbox, "Waiting for your decision")`,
    ],
  },
};

export function registerDemo({ route, db, ApiError, randId, nowIso, requireAdmin, requireHuman, newCode, newToken, afterChange }) {
  const adminOnly = async (ctx, me) => { requireHuman(me); await requireAdmin(ctx, me, '載入或清除示範資料'); };
  const loadMark = async () => { try { return JSON.parse((await db.get('SELECT value FROM app_settings WHERE key = ?', DEMO_KEY))?.value || 'null'); } catch { return null; } };
  const freeName = async base => { for (let i = 0; ; i++) { const n = i ? `${base}${i + 1}` : base; if (!(await db.get('SELECT 1 AS x FROM participants WHERE name = ?', n))) return n; } };

  route('GET', '/api/admin/demo', async ({ ctx, me }) => {
    await adminOnly(ctx, me);
    const m = await loadMark();
    return m ? { loaded: true, projectId: m.project, projectName: m.projectName, at: m.at } : { loaded: false };
  });

  route('POST', '/api/admin/demo', async ({ ctx, me, req }) => {
    await adminOnly(ctx, me);
    if (await loadMark()) throw new ApiError(409, 'DEMO_LOADED', '示範資料已經載入了；要重來請先清除');
    const now = Date.now(), iso = ms => new Date(now - ms).toISOString(), H = 3600_000, M = 60_000;
    const pj = randId('prj');
    let body = {}; try { body = await req.json(); } catch {}
    const T = TEXT[body?.lang === 'en' ? 'en' : 'zh']; // 網頁是英文介面就載英文示範
    let pname = T.project;
    if (await db.get('SELECT 1 AS x FROM projects WHERE name = ? AND archived = 0', pname)) pname += `（${new Date(now).toISOString().slice(5, 10)}）`;
    // 示範成員：人類（產品負責人）＋兩隻 AI（開發、設計），都只在示範專案；不能登入
    const person = async (kind, nameBase, role, roleKey, owner, duties) => ({ id: randId('p'), kind, name: await freeName(nameBase), role, role_key: roleKey, owner_id: owner, code: await newCode(), duties });
    const po = await person('human', T.po, 'PO', 'PO', null, '');
    const dev = await person('ai', T.dev, '程式開發', 'PG', po.id, T.devDuties);
    const ux = await person('ai', T.ux, '使用體驗', 'UX', po.id, T.uxDuties);
    const people = [po, dev, ux];
    // 加入時間一定要是現在：管理員＝最早加入的人類，示範成員比你早就會變成管理員
    const joinedAt = new Date(now + 1000).toISOString();
    const stmts = [
      ['INSERT INTO projects (id, name, archived, created_by, created_at) VALUES (?,?,0,?,?)', [pj, pname, me.id, iso(6 * H)]],
      ['INSERT INTO project_events (project_id, at, actor_id, text) VALUES (?,?,?,?)', [pj, iso(6 * H), me.id, T.loaded(me.name)]],
    ];
    const slugUsed = await db.get("SELECT 1 AS x FROM app_settings WHERE key >= 'slug:' AND key < 'slug;' AND value = 'demo'");
    const codeUsed = await db.get("SELECT 1 AS x FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;' AND value = 'DEMO'");
    if (!slugUsed) stmts.push(['INSERT INTO app_settings (key, value) VALUES (?, ?)', ['slug:' + pj, 'demo']]);
    if (!codeUsed) stmts.push(['INSERT INTO app_settings (key, value) VALUES (?, ?)', ['pcode:' + pj, 'DEMO']]);
    for (const p of people) {
      stmts.push([`INSERT INTO participants (id, kind, name, role, role_key, code, owner_id, duties, token, token_expires_at, status, created_at, updated_at, projects)
        VALUES (?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`, [p.id, p.kind, p.name, p.role, p.role_key, p.code, p.owner_id, p.duties, 'demo_' + newToken(), joinedAt, joinedAt, pj]]); // token_expires_at=1：AI 顯示「Token 已過期」；人類沒有密碼、沒有裝置，登入碼是沒人拿得到的亂數
    }
    // 你（管理員）加進示範專案，才看得到
    const mine = String((await db.get('SELECT projects FROM participants WHERE id = ?', me.id))?.projects || '').split(',').filter(Boolean);
    const addedMe = !mine.includes(pj);
    if (addedMe) stmts.push(['UPDATE participants SET projects = ? WHERE id = ?', [[...mine, pj].join(','), me.id]]);

    // 卡片：不同狀態＋一張等你決定的決策卡
    let no = 0;
    const cards = [];
    const card = (o) => { const c = { uid: randId('card'), no: ++no, status: '待處理', owner: null, waitFor: null, next: '', blocker: '', criteria: '', type: '工作', at: iso(5 * H), up: iso(H), ...o }; cards.push(c); return c; };
    card({ ...T.cards[0], owner: dev.id, status: '已完成', next: '', at: iso(5 * H), up: iso(3 * H) });
    card({ ...T.cards[1], owner: dev.id, status: '進行中', up: iso(20 * M) });
    card({ ...T.cards[2], owner: ux.id, status: '待確認', waitFor: po.id, up: iso(40 * M) });
    card({ ...T.cards[3], owner: dev.id, status: '受阻', up: iso(2 * H) });
    card({ ...T.cards[4], status: '待處理' });
    const dec = card({ ...T.dec, type: '決策', status: '待確認', waitFor: me.id, up: iso(10 * M), proposer: dev.id });
    for (const c of cards) {
      stmts.push([`INSERT INTO cards (uid, type, title, owner_id, status, next, blocker, wait_for_id, criteria, created_by, request_id, done_by, done_at, decider_id, proposer_id, question, recommendation, options, impact, after_next, project, proj_no, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [c.uid, c.type, c.title, c.owner, c.status, c.next, c.blocker, c.waitFor, c.criteria, po.id, TAG + c.uid,
        c.status === '已完成' ? c.owner : null, c.status === '已完成' ? c.up : null, c.type === '決策' ? me.id : null, c.proposer || null,
        c.question || '', c.recommendation || '', c.options ? JSON.stringify(c.options) : '', c.impact || '', c.afterNext || '', pj, c.no, c.at, c.up]]);
      stmts.push([`INSERT INTO card_log (card_seq, at, by_id, via, text) SELECT seq, ?, ?, 'API', ? FROM cards WHERE uid = ?`, [c.at, po.id, T.created(c.type), c.uid]]);
    }
    stmts.push(['INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)', [`pnomax:${pj}`, String(no)]]);

    // 一段人與 AI 的對話（掛在「報名成功寄確認信」那張卡上）＋給你的一則通知（決策等你）
    const code = codeUsed ? null : 'DEMO';
    const ref = c => (code ? `${code}-${c.no}` : T.ref(c));
    const mail = cards[1], mobile = cards[2];
    const msgs = [];
    const msg = (author, text, { to = [], ask = null, reply = null, ago, cardOf = null, notify = [] } = {}) => { const m = { id: randId('msg'), author, text, to, ask, reply, at: iso(ago), cardOf, notify }; msgs.push(m); return m; };
    const W = T.msgs(ref, { mail, mobile, dec });
    const m1 = msg(po.id, W[0], { to: [dev.id], ask: [dev.id], ago: 3 * H, cardOf: mail });
    msg(dev.id, W[1], { to: [po.id], ask: [], reply: m1.id, ago: 3 * H - 5 * M, cardOf: mail });
    msg(dev.id, W[2], { to: [po.id], ask: [], ago: 90 * M, cardOf: mail });
    const q = msg(dev.id, W[3], { to: [po.id], ask: [po.id], ago: 60 * M, cardOf: mail });
    msg(po.id, W[4], { to: [dev.id], ask: [], reply: q.id, ago: 50 * M, cardOf: mail });
    msg(ux.id, W[5], { to: [po.id], ask: [po.id], ago: 40 * M, cardOf: mobile });
    msg(dev.id, W[6], { to: [me.id], ask: [], ago: 10 * M, cardOf: dec, notify: [me.id] });
    for (const m of msgs) {
      stmts.push(['INSERT INTO messages (id, author_id, text, reply_to, request_id, reply_from, project, created_at) VALUES (?,?,?,?,?,?,?,?)', [m.id, m.author, m.text, m.reply, TAG + m.id, m.ask ? JSON.stringify(m.ask) : null, pj, m.at]]);
      for (const r of m.to) stmts.push(['INSERT INTO message_recipients (message_id, participant_id) VALUES (?,?)', [m.id, r]]);
      for (const r of m.notify) stmts.push(["INSERT INTO notifications (id, recipient_id, message_id, reasons, created_at) VALUES (?,?,?,'[\"mention\"]',?)", [randId('notif'), r, m.id, m.at]]);
      if (m.cardOf) stmts.push(['INSERT INTO card_msgs (card_seq, message_id) SELECT seq, ? FROM cards WHERE uid = ?', [m.id, m.cardOf.uid]]);
    }
    // 示範專案不開放申請：新註冊的人申請清單裡不會出現它
    let js = {}; try { js = JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'join_settings'"))?.value || '{}') || {}; } catch {}
    stmts.push(["INSERT INTO app_settings (key, value) VALUES ('join_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ ...js, [pj]: { open: false, note: '' } })]]);
    const mark = { project: pj, projectName: pname, people: people.map(p => p.id), addedMe: addedMe ? me.id : null, by: me.id, at: nowIso() };
    stmts.push(['INSERT INTO app_settings (key, value) VALUES (?, ?)', [DEMO_KEY, JSON.stringify(mark)]]);
    await db.batch(stmts);
    await afterChange?.();
    return { loaded: true, projectId: pj, projectName: pname, cards: cards.length, messages: msgs.length, people: people.map(p => p.name) };
  });

  // 清除：只刪有標記的；示範專案裡有別人的訊息或卡就保留專案
  route('DELETE', '/api/admin/demo', async ({ ctx, me }) => {
    await adminOnly(ctx, me);
    const m = await loadMark();
    if (!m) throw new ApiError(404, 'NOT_FOUND', '沒有載入示範資料');
    const ids = JSON.stringify(m.people || []), like = TAG + '%';
    const demoMsgs = `SELECT id FROM messages WHERE request_id LIKE '${TAG}%' AND project = ?`;
    const demoCards = `SELECT seq FROM cards WHERE request_id LIKE '${TAG}%' AND project = ?`;
    const stmts = [
      [`DELETE FROM notifications WHERE message_id IN (${demoMsgs})`, [m.project]],
      [`DELETE FROM message_recipients WHERE message_id IN (${demoMsgs})`, [m.project]],
      [`DELETE FROM decision_resolutions WHERE message_id IN (${demoMsgs})`, [m.project]],
      [`DELETE FROM card_msgs WHERE message_id IN (${demoMsgs}) OR card_seq IN (${demoCards})`, [m.project, m.project]],
      [`DELETE FROM card_log WHERE card_seq IN (${demoCards})`, [m.project]],
      [`DELETE FROM suggestions WHERE card_seq IN (${demoCards})`, [m.project]],
      ['DELETE FROM messages WHERE request_id LIKE ? AND project = ?', [like, m.project]],
      ['DELETE FROM cards WHERE request_id LIKE ? AND project = ?', [like, m.project]],
      // 示範成員：通知、收件人、狀態一起刪（他們只在示範專案、不能登入，不會有真資料）
      ['DELETE FROM notifications WHERE recipient_id IN (SELECT value FROM json_each(?))', [ids]],
      ['DELETE FROM message_recipients WHERE participant_id IN (SELECT value FROM json_each(?))', [ids]],
      ['DELETE FROM ai_state WHERE participant_id IN (SELECT value FROM json_each(?))', [ids]],
      ['DELETE FROM dms WHERE human_id IN (SELECT value FROM json_each(?)) OR ai_id IN (SELECT value FROM json_each(?))', [ids, ids]],
      ['DELETE FROM participants WHERE id IN (SELECT value FROM json_each(?))', [ids]],
      ['DELETE FROM app_settings WHERE key = ?', [DEMO_KEY]],
    ];
    await db.batch(stmts);
    // 專案：還有別人的訊息或卡就保留
    const others = await db.get('SELECT (SELECT COUNT(*) FROM messages WHERE project = ?) + (SELECT COUNT(*) FROM cards WHERE project = ?) AS n', m.project, m.project);
    let keptProject = false;
    if (others?.n) keptProject = true;
    else {
      const rm = [['DELETE FROM projects WHERE id = ?', [m.project]], ['DELETE FROM project_events WHERE project_id = ?', [m.project]],
        ['DELETE FROM app_settings WHERE key IN (?, ?, ?)', ['slug:' + m.project, 'pcode:' + m.project, 'pnomax:' + m.project]]];
      // 誰被加進示範專案（含你）都移出
      const fallback = (await db.get('SELECT id FROM projects WHERE id != ? AND archived = 0 ORDER BY created_at, id LIMIT 1', m.project))?.id || '';
      for (const p of await db.all("SELECT id, projects FROM participants WHERE ',' || projects || ',' LIKE ?", `%,${m.project},%`)) {
        const left = p.projects.split(',').filter(x => x && x !== m.project);
        rm.push(['UPDATE participants SET projects = ? WHERE id = ?', [(left.length ? left : [fallback]).filter(Boolean).join(','), p.id]]); // 至少留一個專案
      }
      let js = {}; try { js = JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'join_settings'"))?.value || '{}') || {}; } catch {}
      if (js[m.project]) { delete js[m.project]; rm.push(["UPDATE app_settings SET value = ? WHERE key = 'join_settings'", [JSON.stringify(js)]]); }
      await db.batch(rm);
    }
    await afterChange?.();
    return { cleared: true, keptProject, projectName: m.projectName };
  });
}
