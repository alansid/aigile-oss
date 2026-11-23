// 審查者：程式交出去前，先給「不是作者」的人或 AI 看過。規則由各專案 leader 自訂，只有「審查者不能是作者」寫死。
// 設定存 app_settings 的 review＝{ [專案]: 設定 }；紀錄存 card_reviews（一列一個事件：送審、通過、要改、作廢）。
// 平台擋得了：審查者是作者或不符合規則、卡片沒通過就請人同意 commit、版本改了還拿舊的通過。擋不了：AI 在自己電腦直接 git commit。
// differ＝審查者要多不一樣（只管 AI）：any 不限（不是作者就好）／model 不同模型／vendor 不同家（不同家一定也是不同模型）
export const REVIEW_DEFAULTS = { cards: 'off', who: 'any', roles: [], members: [], need: 1, needHuman: false, differ: 'any', notOwner: false, humanPass: 'separate', diffUpload: true }; // 開源版預設可以上傳 diff（架在自己的伺服器，diff 不會離開公司；leader 可以關）
export const DIFF_DECLARATION = '這是本專案自己的程式差異，不含密鑰與客戶個資';
const DIFF_MAX = 2 * 1048576;
const CARDS = ['off', 'code', 'all'], WHO = ['any', 'ai', 'human', 'roles', 'members'], PASS = ['separate', 'combined'], DIFFER = ['any', 'model', 'vendor'];
// 舊設定 diffTool（要／不要不同家）：true → 不同家、false → 不限
export function normReviewCfg(cfg = {}) {
  const { diffTool, log, ...c } = cfg;
  if (!DIFFER.includes(c.differ)) c.differ = diffTool === true ? 'vendor' : 'any';
  return { ...REVIEW_DEFAULTS, ...c };
}
// AI 回報的完整模型代號（例：claude-opus-5-5、gpt-5.1-codex）；比對不分大小寫，代號不一樣就算不同（新舊版本也算）
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()[\]+-]{0,79}$/;
export const sameModel = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
export function readModel(v, invalid) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? v.trim() : '';
  if (!MODEL_RE.test(m)) throw invalid('model 是你目前用的完整模型代號（例：claude-opus-5-5），1～80 個英數字');
  return m;
}
const KNOWN_TOOLS = ['claude', 'codex', 'copilot', 'antigravity'];
export const TOOL_NAME = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', antigravity: 'Antigravity' };
export const REVIEW_LOG = '審查'; // card_log.via
const VERSION_RE = /^(?:[0-9a-f]{40}|[0-9A-Za-z][0-9A-Za-z:._-]{6,79})$/;
const HEX_RE = /\b(?=[0-9]*[a-f])[0-9a-f]{7,80}\b/g; // SHA、短 SHA、diff 指紋（至少一個 a～f，日期、編號不算）
export const COMMIT_ASK_RE = /^\s*\[需確認\][\s\S]*commit/i;
const short = v => (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 7) : v);
// 兩個版本是不是同一個：40 碼 SHA 與 7 碼以上的開頭也算同一個
export const sameVersion = (a, b) => !!a && !!b && (a === b || (/^[0-9a-f]{7,40}$/.test(a) && /^[0-9a-f]{7,40}$/.test(b) && (a.startsWith(b) || b.startsWith(a))));

export function readReviewCfg(body, cur = REVIEW_DEFAULTS, invalid) {
  const out = normReviewCfg(cur);
  const pick = (k, list) => { if (body[k] === undefined) return; if (!list.includes(body[k])) throw invalid(`${k} 只能是 ${list.join('、')}`); out[k] = body[k]; };
  pick('cards', CARDS); pick('who', WHO); pick('humanPass', PASS); pick('differ', DIFFER);
  if (body.differ === undefined && body.diffTool !== undefined) { // 舊的呼叫方式照樣能用
    if (typeof body.diffTool !== 'boolean') throw invalid('diffTool 需為 true／false（新的設定請用 differ：any、model、vendor）');
    out.differ = body.diffTool ? 'vendor' : 'any';
  }
  if (body.need !== undefined) { if (![1, 2].includes(body.need)) throw invalid('need 只能是 1 或 2'); out.need = body.need; }
  for (const k of ['needHuman', 'notOwner', 'diffUpload']) if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') throw invalid(`${k} 需為 true／false`); out[k] = body[k]; }
  for (const k of ['roles', 'members']) if (body[k] !== undefined) {
    if (!Array.isArray(body[k]) || body[k].length > 30 || body[k].some(x => typeof x !== 'string' || !x.trim() || x.length > 40)) throw invalid(`${k} 需為 0～30 個字串的陣列`);
    out[k] = [...new Set(body[k].map(x => x.trim()))];
  }
  if (out.need === 1) out.needHuman = false; // 「至少要有一位是人」只在要 2 位時能設
  if (out.who === 'ai' && out.needHuman) throw invalid('「只有 AI」不能同時要「至少一位是人」');
  return out;
}

export function registerReviews({ route, db, ApiError, invalid, readJson, readBody, randId, nowIso, sha256, peopleMap, projectsOf, roIn, nameOf, isManager, getJson, setJson, createMessage, cardSeqByKey, cardKey, roleNamesIn, loadRoles = async () => {}, isolatedFrom, repoOf = async () => null, docStorage = null, audit = async () => {} }) {
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這張卡片');
  async function cfgOf(pj) { return normReviewCfg(((await getJson('review')) || {})[pj] || {}); }
  async function logOf(pj) { return (((await getJson('review')) || {})[pj]?.log || []); }
  // 有設程式庫（GitHub）就給比較連結：有分支＝compare 預設分支...分支；只有 SHA＝那個 commit
  async function githubOf(pj) {
    const repo = await repoOf(pj);
    const url = String(repo?.url || '').replace(/\.git$|\/$/g, '');
    return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(url) ? { url, branch: repo.branch || 'main' } : null;
  }
  async function compareUrl(pj, version, branch) {
    const gh = await githubOf(pj);
    if (!gh) return null;
    if (branch) return `${gh.url}/compare/${encodeURIComponent(gh.branch)}...${encodeURIComponent(branch)}`;
    return /^[0-9a-f]{7,40}$/.test(version) ? `${gh.url}/commit/${version}` : null;
  }
  // 送審說明後面接「分支：x」存在同一欄；畫面要分開顯示
  const splitNote = (comment = '') => { const m = /\n分支：(\S+)$/.exec(comment || ''); return m ? { note: comment.slice(0, m.index), branch: m[1] } : { note: comment || '', branch: null }; };
  const SET_LABEL = { cards: { off: '不審', code: '只有程式卡', all: '全部的卡' }, who: { any: '人或 AI 都可以', ai: '只有 AI', human: '只有人', roles: '指定角色', members: '指定幾位' }, humanPass: { separate: '分開按', combined: '通過就算同意 commit' }, differ: { any: '不限', model: '不同模型', vendor: '不同家' } };
  function changesText(a, b) {
    const out = [];
    for (const k of ['cards', 'who', 'differ', 'humanPass']) if (a[k] !== b[k]) out.push(`${{ cards: '哪些卡要審', who: '誰可以審', differ: '審查者要多不一樣', humanPass: '人審查通過時' }[k]}：${SET_LABEL[k][a[k]]} → ${SET_LABEL[k][b[k]]}`);
    if (a.need !== b.need) out.push(`要幾位通過：${a.need} → ${b.need}`);
    for (const [k, l] of [['needHuman', '至少要有一位是人'], ['notOwner', '不能是作者的主人']]) if (!!a[k] !== !!b[k]) out.push(`${l}：${b[k] ? '要' : '不要'}`);
    if (!!a.diffUpload !== !!b.diffUpload) out.push(`把「送審可以上傳 diff」改成${b.diffUpload ? '可以' : '不可以'}`);
    if (JSON.stringify(a.roles) !== JSON.stringify(b.roles) && b.who === 'roles') out.push(`指定角色：${b.roles.join('、') || '（沒有）'}`);
    if (JSON.stringify(a.members) !== JSON.stringify(b.members) && b.who === 'members') out.push('指定幾位：改了名單');
    return out;
  }
  // 每隻 AI 現在的工具（接入檢查回報的）與最近一次回報的模型
  async function aiInfo() {
    const [tools, rows] = await Promise.all([db.all('SELECT ai_id, tool FROM skill_syncs').catch(() => []), db.all('SELECT ai_id, model, via, at FROM ai_models').catch(() => [])]);
    return { tools: new Map(tools.map(r => [r.ai_id, KNOWN_TOOLS.includes(r.tool) ? r.tool : null])), models: new Map(rows.map(r => [r.ai_id, r.model])), reported: new Map(rows.map(r => [r.ai_id, r])) };
  }
  // 比對時作者用送審那一刻的工具與模型（之後換模型不影響已送的審查）；其他人用現在的
  function withAuthors(info, evs, me = null, model = null) {
    const tools = new Map(info.tools), models = new Map(info.models);
    for (const e of evs) if (e.ev === 'request') { tools.set(e.actor_id, e.tool || null); models.set(e.actor_id, e.model || null); } // 送審那一刻不明就固定為不明（之後才回報的不算）
    if (me) { if (info.tools.get(me)) tools.set(me, info.tools.get(me)); if (model) models.set(me, model); } // 正在送審的作者：用現在的
    return { tools, models };
  }
  // AI 回報模型：接上（checkin）、送審（request）、回覆審查（review）；被叫醒不回報
  async function reportModel(me, model, via) {
    if (me.kind !== 'ai' || !model) return;
    await db.run('INSERT INTO ai_models (ai_id, model, via, at) VALUES (?,?,?,?) ON CONFLICT(ai_id) DO UPDATE SET model = excluded.model, via = excluded.via, at = excluded.at', me.id, model, via, nowIso());
  }
  async function cardOf(id, me) {
    const m = /^C-(\d+)$/i.exec(String(id || '').trim());
    const seq = m ? Number(m[1]) - 100 : await cardSeqByKey(id);
    const c = Number.isInteger(seq) && seq >= 1 ? await db.get('SELECT * FROM cards WHERE seq = ?', seq) : null;
    if (!c) throw notFound();
    if (me && isolatedFrom(me) && !projectsOf(me).includes(c.project)) throw new ApiError(403, 'CARD_FORBIDDEN', '這張卡屬於其他專案，你沒有權限查看。');
    return c;
  }
  const eventsOf = seq => db.all('SELECT * FROM card_reviews WHERE card_seq = ? ORDER BY at, rowid', seq);
  const ownerOf = p => (p.kind === 'ai' ? p.owner_id : p.id);
  const kindOf = p => (p.kind === 'ai' ? 'ai' : 'human');

  // 為什麼 p 不能審：作者／同一家／同一個模型／不在可審名單；可以審回 ''
  // 人一律算不一樣；工具或模型不明的 AI 也算不一樣（畫面標「模型不明」）
  function whyNot(p, { pj, cfg, authors, tools, models }) {
    if (!p || p.status !== 'active' || !['ai', 'human'].includes(p.kind) || !projectsOf(p).includes(pj) || roIn(p, pj)) return '不在可審名單';
    if (authors.some(a => a.id === p.id)) return '是作者';
    if (cfg.who === 'ai' && p.kind !== 'ai') return '不在可審名單';
    if (cfg.who === 'human' && p.kind !== 'human') return '不在可審名單';
    if (cfg.who === 'roles' && !roleNamesIn(p, pj).some(r => cfg.roles.includes(r))) return '不在可審名單';
    if (cfg.who === 'members' && !cfg.members.includes(p.id)) return '不在可審名單';
    if (cfg.notOwner && authors.some(a => ownerOf(a) && ownerOf(a) === ownerOf(p))) return '是作者的主人或同一位主人的 AI';
    if (cfg.differ !== 'any' && p.kind === 'ai') {
      const ais = authors.filter(a => a.kind === 'ai'), t = tools.get(p.id), m = models.get(p.id);
      if (cfg.differ === 'vendor' && t && ais.some(a => tools.get(a.id) === t)) return '同一家';
      if (m && ais.some(a => sameModel(models.get(a.id), m))) return '同一個模型'; // 不同家一定也是不同模型
    }
    return '';
  }
  // 手上還沒審完的件數（最新一輪是送給他、他還沒回）
  async function loads() {
    const rows = await db.all("SELECT card_seq, ev, version, actor_id, reviewer_id, message_id, at FROM card_reviews WHERE card_seq IN (SELECT card_seq FROM card_reviews WHERE ev = 'request' AND at >= ?) ORDER BY at, rowid", new Date(Date.now() - 30 * 86400_000).toISOString());
    const byCard = new Map();
    for (const r of rows) { if (!byCard.has(r.card_seq)) byCard.set(r.card_seq, []); byCard.get(r.card_seq).push(r); }
    const n = new Map();
    for (const evs of byCard.values()) for (const id of roundOf(evs).waiting) n.set(id, (n.get(id) || 0) + 1);
    return n;
  }
  // 最新一輪：送審的版本、審查者、誰通過／要改。一輪＝一則送審訊息（message_id）：
  // 送審、通過、要改都記著這一輪的 message_id，只算同一輪的；前一輪晚到的回覆不會影響新一輪（同版本重新送審也一樣）
  function roundOf(evs) {
    let i = evs.length - 1;
    while (i >= 0 && evs[i].ev !== 'request') i--;
    if (i < 0) return { req: null, id: null, reviewers: [], waiting: [], passes: [], changes: null, voided: null };
    const req = evs[i], id = req.message_id;
    const inRound = e => id != null && e.message_id === id;
    const reqs = evs.filter(e => e.ev === 'request' && inRound(e)), after = evs.slice(i + 1);
    const reviewers = [...new Set(reqs.map(r => r.reviewer_id).filter(Boolean))];
    const passes = evs.filter(e => e.ev === 'pass' && inRound(e) && sameVersion(e.version, req.version));
    const changes = evs.filter(e => e.ev === 'changes' && inRound(e)).pop() || null;
    const voided = after.filter(e => e.ev === 'void').pop() || null;
    const done = new Set([...passes.map(e => e.actor_id), ...(changes ? [changes.actor_id] : [])]);
    return { req, id, reqs, reviewers, waiting: changes || voided ? [] : reviewers.filter(id => !done.has(id)), passes, changes, voided };
  }
  function stateOf(evs, cfg, people) {
    const r = roundOf(evs);
    if (!r.req) return { state: 'none', round: r };
    if (r.voided) return { state: 'void', round: r };
    if (r.changes) return { state: 'changes', round: r };
    const voters = [...new Set(r.passes.map(e => e.actor_id))].filter(id => r.reviewers.includes(id)); // 不同審查者各算一票
    const ok = voters.length >= cfg.need && (!cfg.needHuman || voters.some(id => people.get(id)?.kind === 'human'));
    return { state: ok ? 'passed' : 'waiting', round: r };
  }
  // 這張卡要不要審：全部的卡都要；只審程式卡時，作者送審標了「不是程式卡」就不用（沒送審過的卡，請同意 commit 就算程式卡）
  const needsReview = (cfg, round) => cfg.cards === 'all' || (cfg.cards === 'code' && !(round.req && round.req.is_code === 0));
  const authorsOf = (evs, people, extra = null) => [...new Set([...evs.filter(e => e.ev === 'request').map(e => e.actor_id), ...(extra ? [extra] : [])])].map(id => people.get(id)).filter(Boolean);
  // AI 帶工具與模型：ev 有給＝那一刻記下的（送審、通過、要改），沒給＝現在的
  const person = (people, id, maps, ev = null) => {
    const p = people.get(id);
    if (!p) return id ? { participantId: id, name: '?', kind: 'ai' } : null;
    return { participantId: p.id, name: p.name, kind: kindOf(p), ...(p.kind === 'ai' ? ev ? { tool: ev.tool || null, model: ev.model || null } : { tool: maps.tools.get(p.id) || null, model: maps.models.get(p.id) || null } : {}) };
  };
  const byLoad = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'ai' ? -1 : 1) || a.load - b.load || a.name.localeCompare(b.name);
  async function eligibleList(pj, cfg, people, authors, maps, load) {
    await loadRoles();
    return [...people.values()].filter(p => !whyNot(p, { pj, cfg, authors, ...maps }))
      .map(p => ({ ...person(people, p.id, maps), load: load.get(p.id) || 0 })).sort(byLoad);
  }

  // 卡片的審查欄（GET /api/cards/:id 與 aigile_card_get 會帶）
  async function reviewOf(c, ctx) {
    const cfg = await cfgOf(c.project);
    const evs = await eventsOf(c.seq);
    if (cfg.cards === 'off' && !evs.length) return null;
    const people = await peopleMap(ctx), maps = await aiInfo();
    const { state, round } = stateOf(evs, cfg, people);
    const passed = [...evs].reverse().find(e => e.ev === 'pass');
    const replyOf = id => round.passes.find(e => e.actor_id === id) || (round.changes?.actor_id === id ? round.changes : null);
    return {
      required: needsReview(cfg, round), rule: { cards: cfg.cards, need: cfg.need, needHuman: cfg.needHuman, differ: cfg.differ, notOwner: cfg.notOwner, humanPass: cfg.humanPass, diffUpload: cfg.diffUpload },
      state, isCode: round.req ? round.req.is_code !== 0 : null, roundId: round.id || null,
      ...(round.req ? { version: round.req.version, requestedBy: person(people, round.req.actor_id, maps, round.req), requestedAt: round.req.at, ...splitNote(round.req.comment), messageId: round.req.message_id, diffDocId: round.req.diff_file || null,
        compareUrl: await compareUrl(c.project, round.req.version, splitNote(round.req.comment).branch),
        reviewers: round.reviewers.map(id => { const r = replyOf(id); return { ...person(people, id, maps, r), result: r ? r.ev : null }; }) } : {}),
      ...(round.changes ? { changes: { by: person(people, round.changes.actor_id, maps, round.changes), at: round.changes.at, comment: round.changes.comment, version: round.changes.version } } : {}),
      ...(round.voided ? { voided: { at: round.voided.at, version: round.voided.version } } : {}),
      ...(passed ? { passed: { by: person(people, passed.actor_id, maps, passed), at: passed.at, comment: passed.comment, version: passed.version } } : {}),
      // 歷次紀錄：送審、通過、要改帶當時的工具與模型（之後換模型不影響）
      history: evs.map(e => ({ at: e.at, ev: e.ev, by: person(people, e.actor_id, maps, e.ev === 'void' ? { tool: null, model: null } : e), version: e.version, ...(e.comment && e.ev !== 'request' ? { comment: e.comment } : {}) })).reverse(),
    };
  }

  // ais：專案裡的 AI 和它們現在的工具、模型；審查設定用來試算「某位 AI 寫的，誰可以審」
  async function settingsView(ctx, pj, cfg, canEdit, log) {
    const people = await peopleMap(ctx), maps = await aiInfo();
    const ais = [...people.values()].filter(p => p.kind === 'ai' && p.status === 'active' && projectsOf(p).includes(pj)).map(p => person(people, p.id, maps)).sort((a, b) => a.name.localeCompare(b.name));
    return { project: pj, settings: cfg, canEdit, eligible: await eligibleList(pj, cfg, people, [], maps, await loads()), ais,
      log, declaration: DIFF_DECLARATION, diffUploadDefault: REVIEW_DEFAULTS.diffUpload, github: await githubOf(pj) };
  }
  route('GET', '/api/projects/:id/review-settings', async ({ ctx, me, params }) => {
    const pj = params.id;
    if (!projectsOf(me).includes(pj)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。');
    return settingsView(ctx, pj, await cfgOf(pj), await isManager(ctx, me, pj), await logOf(pj));
  });
  route('PUT', '/api/projects/:id/review-settings', async ({ ctx, me, req, params }) => {
    const pj = params.id;
    if (!projectsOf(me).includes(pj) || !(await isManager(ctx, me, pj))) throw new ApiError(403, 'FORBIDDEN', '只有 leader、管理員能改審查設定。');
    const body = await readJson(req);
    const all = (await getJson('review')) || {};
    const { log = [], ...cur } = all[pj] || {};
    const prev = normReviewCfg(cur);
    const next = readReviewCfg(body, prev, invalid);
    if (next.who === 'members') { const people = await peopleMap(ctx); next.members = next.members.filter(id => people.has(id)); }
    const changed = changesText(prev, next);
    // 審查紀錄：誰、什麼時候改了哪幾項（「送審可以上傳 diff」開關一定記）
    const nextLog = changed.length ? [{ at: nowIso(), by: me.id, byName: me.name, text: changed.join('；') }, ...log].slice(0, 30) : log;
    all[pj] = { ...next, log: nextLog };
    await setJson('review', all);
    return settingsView(ctx, pj, next, true, nextLog);
  });
  // AI 回報目前的模型（接上時：aigile_use、aigile_me 帶 model、接入檢查 --model）；送審、回覆審查另外帶
  route('PUT', '/api/me/model', async ({ me, req }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '只有 AI 回報模型');
    const model = readModel((await readJson(req)).model, invalid);
    if (!model) throw invalid('要帶 model（你目前用的完整模型代號，例：claude-opus-5-5）');
    await reportModel(me, model, 'checkin');
    return { model, via: 'checkin' };
  });

  // 送審：作者做完呼叫，附版本、說明；審查者可指定（不符合規則直接回錯誤），不指定平台自動挑
  route('POST', '/api/cards/:id/review-request', async ({ ctx, me, req, params }) => {
    const c = await cardOf(params.id, me);
    const body = await readJson(req);
    const version = String(body.version ?? '').trim();
    if (!VERSION_RE.test(version)) throw invalid('version 需為 40 碼 SHA 或 diff 指紋（7～80 個英數字）');
    const note = String(body.note ?? '').trim();
    if (!note || note.length > 500) throw invalid('note（改了什麼、怎麼驗證）為必填，最多 500 字');
    if (body.isCode !== undefined && typeof body.isCode !== 'boolean') throw invalid('isCode 需為 true／false');
    if (body.reviewerId !== undefined && body.reviewerId !== null && typeof body.reviewerId !== 'string') throw invalid('reviewerId 需為 participantId');
    const branch = body.branch === undefined || body.branch === null ? '' : String(body.branch).trim();
    if (branch.length > 100 || /\s/.test(branch)) throw invalid('branch 最多 100 字、不能有空白');
    const diffDocId = body.diffDocId === undefined || body.diffDocId === null || body.diffDocId === '' ? null : String(body.diffDocId);
    const model = readModel(body.model, invalid);
    if (!projectsOf(me).includes(c.project) || roIn(me, c.project)) throw new ApiError(403, 'FORBIDDEN', '你不在這個專案或是唯讀，不能送審。');
    const cfg = await cfgOf(c.project), people = await peopleMap(ctx);
    if (diffDocId) {
      if (!cfg.diffUpload) throw new ApiError(403, 'DIFF_UPLOAD_OFF', '這個專案沒有開「送審可以上傳 diff」；請只附版本與分支，審查者自己到 git 看。');
      const d = await db.get('SELECT id, project, deleted_at FROM docs WHERE id = ?', diffDocId).catch(() => null);
      if (!d || d.deleted_at || d.project !== c.project) throw invalid('diffDocId 不是這個專案的文件');
    }
    const evs = await eventsOf(c.seq);
    const authors = authorsOf(evs, people, me.id);
    const { round } = stateOf(evs, cfg, people);
    // 送審時帶的模型記成作者這一刻的模型（沒帶就用最近一次回報的）
    await reportModel(me, model, 'request');
    const info = await aiInfo(), maps = withAuthors(info, evs, me.id, me.kind === 'ai' ? model || info.models.get(me.id) : null);
    let reviewers = [];
    await loadRoles();
    if (body.reviewerId) {
      const p = people.get(body.reviewerId);
      const why = whyNot(p, { pj: c.project, cfg, authors, ...maps });
      if (why) throw new ApiError(400, 'REVIEWER_NOT_ALLOWED', `${p?.name || body.reviewerId} 不能審這張卡：${why}。`);
      reviewers.push(p.id);
    } else if (round.req && (round.changes || round.voided || round.reviewers.length)) { // 改完重新送審：預設還是同一位
      reviewers = round.reviewers.filter(id => !whyNot(people.get(id), { pj: c.project, cfg, authors, ...maps }));
    }
    const load = await loads();
    const pool = await eligibleList(c.project, cfg, people, authors, maps, load);
    for (const cand of [...(cfg.needHuman && !reviewers.some(id => people.get(id)?.kind === 'human') ? pool.filter(x => x.kind === 'human') : []), ...pool]) {
      if (reviewers.length >= cfg.need) break;
      if (!reviewers.includes(cand.participantId)) reviewers.push(cand.participantId);
    }
    if (!reviewers.length) throw new ApiError(409, 'NO_REVIEWER', '找不到符合這個專案審查規則的審查者（審查者不能是作者）。請 leader 到專案設定 › 審查調整，或指定審查者。');
    reviewers = reviewers.slice(0, cfg.need);
    const at = nowIso(), key = cardKey(c) || `C-${c.seq + 100}`, isCode = body.isCode !== false;
    const passedBefore = [...evs].reverse().find(e => e.ev === 'pass');
    const stmts = [];
    if (passedBefore && !sameVersion(passedBefore.version, version) && !round.voided) // 程式改過：原本的通過作廢
      stmts.push(['INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, at) VALUES (?,?,?,?,?,?,?)', [randId('rv'), c.seq, c.project, 'void', version, me.id, at]]);
    // 群組訊息（作者名義）：AI 審查者用 replyFrom 叫醒；人進「要你處理」的審查清單（不另外佔 replyFrom）
    const names = reviewers.map(id => people.get(id).name);
    const cmp = await compareUrl(c.project, version, branch);
    const text = `[交接] ${names.map(n => '@' + n).join(' ')} ${key} 請你審查：${c.title}\n版本：${version}${branch ? `（分支 ${branch}）` : ''}\n改了什麼、怎麼驗證：${note}${diffDocId ? `\ndiff：專案文件 ${diffDocId}` : cmp ? `\n比較：${cmp}` : ''}\n審完用 aigile_review（cardId ${key}、version 照上面、roundId＝這則訊息的 messageId、result pass／changes、意見）。`;
    const firstAi = reviewers.find(id => people.get(id).kind === 'ai');
    const msg = await createMessage(ctx, me, { project: c.project, text: text.slice(0, 4000), recipientIds: reviewers, ...(firstAi ? { replyFrom: [firstAi] } : {}), requestId: `review:${c.seq}:${version}:${at}` });
    const mid = msg.message.messageId;
    const myTool = me.kind === 'ai' ? maps.tools.get(me.id) || null : null, myModel = me.kind === 'ai' ? maps.models.get(me.id) || null : null; // 作者這一刻的工具與模型
    for (const id of reviewers) {
      const p = people.get(id);
      stmts.push(['INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, reviewer_kind, tool, model, comment, diff_file, is_code, message_id, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [randId('rv'), c.seq, c.project, 'request', version, me.id, id, kindOf(p), myTool, myModel, note + (branch ? `\n分支：${branch}` : ''), diffDocId, isCode ? 1 : 0, mid, at]]);
    }
    stmts.push(['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [c.seq, at, me.id, REVIEW_LOG, `${me.name} ${round.req ? '重新送審' : '送審'} ${short(version)}，審查者 ${names.join('、')}：${note}`.slice(0, 1000)]]);
    stmts.push(['INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, mid]]);
    await db.batch(stmts);
    return { cardId: key, version, reviewers: reviewers.map(id => person(people, id, maps)), messageId: mid, sequence: msg.message.sequence };
  });

  // 送審附 diff（專案開了「送審可以上傳 diff」才行）：存專案文件、不過期。只有這個入口用「本專案自己的程式差異」聲明，其他上傳照舊不收程式碼
  route('POST', '/api/cards/:id/review-diff', async ({ ctx, me, req, url, params }) => {
    const c = await cardOf(params.id, me);
    if (!projectsOf(me).includes(c.project) || roIn(me, c.project)) throw new ApiError(403, 'FORBIDDEN', '你不在這個專案或是唯讀，不能送審。');
    const cfg = await cfgOf(c.project);
    if (!cfg.diffUpload) throw new ApiError(403, 'DIFF_UPLOAD_OFF', '這個專案沒有開「送審可以上傳 diff」；請只附版本與分支，審查者自己到 git 看。');
    if (url.searchParams.get('declared') !== 'review-diff') throw invalid(`上傳 diff 前要聲明「${DIFF_DECLARATION}」（declared=review-diff）`);
    if (!docStorage) throw new ApiError(503, 'DOCS_OFF', '這個站沒有開專案文件區，不能上傳 diff。');
    const bytes = await readBody(req, DIFF_MAX, `diff 超過 ${DIFF_MAX / 1048576} MB 上限`, 'FILE_TOO_LARGE');
    if (!bytes.length) throw invalid('diff 是空的');
    const key = cardKey(c) || `C-${c.seq + 100}`;
    const ver = String(url.searchParams.get('version') || '').replace(/[^0-9A-Za-z._-]/g, '').slice(0, 12) || 'diff';
    const id = randId('doc'), at = nowIso(), name = `${key}-${ver}.diff.txt`;
    await docStorage.put(`docs/${id}`, bytes, { mime: 'text/plain', name });
    await db.run('INSERT INTO docs (id, project, folder_id, name, ext, mime, size, sha256, uploader_id, created_at, updated_at, in_kb, kb_org) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, c.project, null, name, 'txt', 'text/plain', bytes.length, await sha256(bytes), me.id, at, at, 0, null);
    const d = await db.get('SELECT * FROM docs WHERE id = ?', id);
    await audit('upload', me, { ...d, declared: 1 }, { detail: `送審 diff（${key}，聲明：${DIFF_DECLARATION}）` });
    return { __status: 201, docId: id, name, size: bytes.length };
  });

  // 回覆審查：pass／changes；只有這一輪的審查者能回，版本要對得上
  route('POST', '/api/cards/:id/review', async ({ ctx, me, req, params }) => {
    const c = await cardOf(params.id, me);
    const body = await readJson(req);
    if (!['pass', 'changes'].includes(body.result)) throw invalid('result 只能是 pass 或 changes');
    const version = String(body.version ?? '').trim();
    const comment = String(body.comment ?? '').trim();
    if (comment.length > 1000) throw invalid('comment 最多 1000 字');
    if (body.result === 'changes' && !comment) throw invalid('要改要寫一句意見（comment）');
    const model = readModel(body.model, invalid);
    const cfg = await cfgOf(c.project), people = await peopleMap(ctx);
    const evs = await eventsOf(c.seq);
    const { round } = stateOf(evs, cfg, people);
    if (!round.req) throw new ApiError(409, 'NOT_REQUESTED', '這張卡還沒送審。');
    if (!round.reviewers.includes(me.id)) throw new ApiError(403, 'NOT_REVIEWER', '你不是這一輪的審查者。');
    if (authorsOf(evs, people).some(a => a.id === me.id)) throw new ApiError(403, 'REVIEWER_IS_AUTHOR', '審查者不能是作者。');
    await reportModel(me, model, 'review'); // 審查者這一刻的模型（中途換了模型，這裡就會擋「同一個模型」）
    const maps = withAuthors(await aiInfo(), evs);
    await loadRoles();
    const whyNow = whyNot(people.get(me.id), { pj: c.project, cfg, authors: authorsOf(evs, people), ...maps });
    if (whyNow) throw new ApiError(403, 'REVIEWER_NOT_ALLOWED', `${me.name} 現在不能審這張卡：${whyNow}。`);
    if (round.voided || round.changes) throw new ApiError(409, 'REVIEW_CLOSED', '這一輪已經結束（要改或作廢），等作者重新送審。');
    if (!round.waiting.includes(me.id)) throw new ApiError(409, 'ALREADY_REVIEWED', '你已經回覆過這一輪了。');
    const roundId = body.roundId === undefined || body.roundId === null || body.roundId === '' ? null : String(body.roundId);
    if (roundId && roundId !== round.id) throw new ApiError(409, 'ROUND_CHANGED', '作者已經重新送審，你看到的是舊的一輪。請重新讀卡（aigile_card_get）再回覆。');
    if (!roundId && evs.some(e => e.ev === 'request' && e.reviewer_id === me.id && e.message_id !== round.id && sameVersion(e.version, round.req.version)))
      throw new ApiError(409, 'ROUND_REQUIRED', '這個版本送給你審過不只一輪，分不出你回的是哪一輪。請重新讀卡，回覆時帶 roundId（送審訊息的 messageId）。');
    if (!sameVersion(version, round.req.version)) throw new ApiError(409, 'VERSION_MISMATCH', `送審的版本是 ${round.req.version}，你回覆的是 ${version || '（空白）'}；請照送審的版本回覆。`);
    const at = nowIso(), key = cardKey(c) || `C-${c.seq + 100}`, pass = body.result === 'pass';
    const combined = pass && body.approveCommit === true && me.kind === 'human' && cfg.humanPass === 'combined' && people.get(round.req.actor_id)?.owner_id === me.id;
    await db.batch([
      ['INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, reviewer_kind, tool, model, comment, message_id, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [randId('rv'), c.seq, c.project, body.result, round.req.version, me.id, me.id, kindOf(me), me.kind === 'ai' ? maps.tools.get(me.id) || null : null, me.kind === 'ai' ? maps.models.get(me.id) || null : null, comment, round.req.message_id, at]],
      ['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [c.seq, at, me.id, REVIEW_LOG, `${me.name} 審 ${short(round.req.version)}：${pass ? '通過' : '要改'}${comment ? '。意見：' + comment : ''}`.slice(0, 1000)]],
    ]).catch(e => { if (/UNIQUE|duplicate key|constraint/i.test(e.message)) throw new ApiError(409, 'ALREADY_REVIEWED', '你已經回覆過這一輪了。'); throw e; });
    // 群組只發一句短通知（意見寫在卡片紀錄）；叫醒作者（AI）接著做
    const author = people.get(round.req.actor_id);
    const now = stateOf(await eventsOf(c.seq), cfg, people);
    const after = now.round.id === round.id ? now.state : 'waiting'; // 投票期間作者又重新送審：這票屬於舊的一輪，不算新一輪通過
    let text = `[通知] ${key} 審查：${pass ? '通過' : '要改'}（${me.name}）${pass && after !== 'passed' ? '，還要再 1 位通過' : ''}`;
    let replyTo = null;
    if (combined && after === 'passed') { // 整輪通過才算（要 2 位時兩位都過）；人審查通過就算同意 commit（專案設定「人審查通過時：通過就算同意 commit」，且審查者是作者 AI 的主人）
      const reqMsg = round.req.message_id && await db.get('SELECT id, seq FROM messages WHERE id = ?', round.req.message_id).catch(() => null);
      if (reqMsg) { text = `[回覆] 同意 commit（針對第 ${reqMsg.seq} 則），請附完整 40 碼 SHA。審查通過${comment ? '：' + comment : ''}`; replyTo = reqMsg.id; }
    }
    const msg = await createMessage(ctx, me, { project: c.project, text: text.slice(0, 4000), ...(replyTo ? { replyToMessageId: replyTo } : {}), recipientIds: author ? [author.id] : [], ...(author?.kind === 'ai' && !replyTo ? { replyFrom: [author.id] } : {}), requestId: `reviewed:${c.seq}:${me.id}:${at}` });
    await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, msg.message.messageId);
    return { cardId: key, result: body.result, state: after, messageId: msg.message.messageId, ...(combined && replyTo ? { approvedCommit: true } : {}) };
  });

  // 「要你處理」：人類審查者還沒回的審查
  route('GET', '/api/reviews/mine', async ({ ctx, me }) => {
    const rows = await db.all("SELECT DISTINCT card_seq FROM card_reviews WHERE reviewer_id = ? AND ev = 'request'", me.id);
    const people = await peopleMap(ctx), maps = await aiInfo(), items = [];
    for (const { card_seq } of rows.slice(-50)) {
      const c = await db.get('SELECT * FROM cards WHERE seq = ?', card_seq);
      if (!c || (isolatedFrom(me) && !projectsOf(me).includes(c.project))) continue;
      const evs = await eventsOf(card_seq);
      const cfg = await cfgOf(c.project);
      const { round } = stateOf(evs, cfg, people);
      if (!round.waiting.includes(me.id)) continue;
      const msg = round.req.message_id ? await db.get('SELECT seq FROM messages WHERE id = ?', round.req.message_id).catch(() => null) : null;
      items.push({ cardId: cardKey(c) || `C-${c.seq + 100}`, title: c.title, project: c.project, version: round.req.version, ...splitNote(round.req.comment), at: round.req.at, diffDocId: round.req.diff_file || null, compareUrl: await compareUrl(c.project, round.req.version, splitNote(round.req.comment).branch),
        author: person(people, round.req.actor_id, maps, round.req), messageId: round.req.message_id, roundId: round.id, sequence: msg?.seq ?? null, humanPass: cfg.humanPass,
        canApproveCommit: people.get(round.req.actor_id)?.owner_id === me.id });
    }
    return { items };
  });

  // 請人同意 commit 之前：專案開了審查，這張卡要先通過。commit 訊息寫的版本跟通過的對不上＝通過作廢（訊息照發，畫面標紅）
  async function checkCommitAsk(me, text, card) {
    if (me.kind !== 'ai' || !COMMIT_ASK_RE.test(text)) return null;
    let c = card ? await db.get('SELECT * FROM cards WHERE seq = ?', card.seq) : null;
    if (!c) for (const [k] of text.matchAll(/\b[A-Z]{2,5}-\d+\b/g)) { const seq = await cardSeqByKey(k); if (seq) { c = await db.get('SELECT * FROM cards WHERE seq = ?', seq); if (c) break; } }
    if (!c) return null;
    const cfg = await cfgOf(c.project);
    if (cfg.cards === 'off') return null;
    const people = await peopleMap({});
    const evs = await eventsOf(c.seq);
    const { state, round } = stateOf(evs, cfg, people);
    if (!needsReview(cfg, round)) return null; // 只審程式卡、作者標了不是程式卡
    if (state !== 'passed') throw new ApiError(409, 'REVIEW_REQUIRED', '這張卡還沒通過審查，不能請人同意 commit。請先送審（aigile_review_request），通過後再發。');
    const hexes = [...new Set(text.match(HEX_RE) || [])];
    if (hexes.length && !hexes.some(h => sameVersion(h, round.req.version))) {
      await db.batch([
        ['INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, at) VALUES (?,?,?,?,?,?,?)', [randId('rv'), c.seq, c.project, 'void', hexes.find(h => h.length === 40) || hexes[0], me.id, nowIso()]],
        ['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [c.seq, nowIso(), me.id, REVIEW_LOG, `版本變了，通過作廢（審過 ${short(round.req.version)}，要 commit 的是 ${short(hexes[0])}）`]],
      ]);
      return { voided: true };
    }
    return { cardSeq: c.seq };
  }
  return { reviewOf, checkCommitAsk, cfgOf, logOf, aiInfo };
}
