// 角色技能庫：專案成員上傳技能包（資料夾含 SKILL.md），AI 由主人手動同步、依工具裝到對的資料夾。
// 規則：
//   - 只有說明文件的直接上架；含腳本的：leader／管理員上傳的直接上架，其他成員上傳的要 leader／管理員核准（看全文與差異）
//   - 每個 AI 的主人允許「這一版」才安裝含腳本的包；同步全手動（主人按「同步」或重跑 aigile-setup），AI 不自己查、不加輪詢
//   - 執行照工具權限，不另外問；技能只發給該專案、指定的 AI（所有 AI／指定角色／指定 AI，MAIN-249）；新版或下架由平台私訊主人（每位主人一則）
import { ROLES } from './roles.js';
export const SKILL_MAX_BYTES = 1024 * 1024;
export const SKILL_MAX_FILES = 100;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // Claude Code、Codex 共通的技能名稱規則（也是資料夾名）
const SEG_RE = /^[A-Za-z0-9._-]+$/;
// 會被執行的檔：放在 scripts/ 底下，或副檔名是常見腳本
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|go|exe|dll|so)$/i;
// 常見金鑰樣式（平台成員 Token 另由 assertNoSecret 擋）
const KEYISH = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bxox[abp]-[A-Za-z0-9-]{10,}/;
export const SKILL_ROLES = ['PO', 'PG', 'UX', 'QA', 'BA', 'SM', 'PM', 'BU']; // 舊版固定 8 種（BU 留著讓舊資料能存回）

// 發給誰：skills.roles 欄兩種寫法——陣列＝指定角色（空＝所有 AI，舊資料都是這種）；{"ais":[…]}＝指定 AI
// 所有讀這欄的地方都走 targetOf，不要直接當陣列用
export function targetOf(r) {
  let v; try { v = JSON.parse(r?.roles || '[]'); } catch { v = []; }
  const list = x => (Array.isArray(x) ? x.map(String) : []);
  return Array.isArray(v) ? { roles: list(v), ais: [] } : { roles: list(v?.roles), ais: list(v?.ais) };
}
export const encTarget = t => JSON.stringify(t.ais.length ? { ais: [...t.ais].sort() } : [...t.roles].sort());
export const isTargeted = t => t.roles.length > 0 || t.ais.length > 0; // 有指定＝裝到 AI 自己的代號資料夾

// 整包雜湊：依路徑排序後的 [路徑, 內容] 陣列做 SHA-256（aigile-setup.mjs 用同樣算法核對）
export const canonical = files => JSON.stringify(files.map(f => [f.path, f.text]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
// 技能包的腳本在 skills/<名稱>/scripts/ 底下，所以看任何一層叫 scripts
export const isScript = path => path.split('/').slice(0, -1).includes('scripts') || SCRIPT_EXT.test(path);
// 腳本分兩類（上架前給 leader 看）：會執行的＝腳本副檔名、不在測試資料夾；其他（測試資料、資料檔）
const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?|corpus|testdata|snapshots?)\/|\.(test|spec)\.[a-z]+$/i;
export const runsScript = path => SCRIPT_EXT.test(path) && !TEST_PATH.test(path);
export const PLUGIN_JSON = '.claude-plugin/plugin.json';
export const PACK_MAX_BYTES = 5 * 1024 * 1024;
export const PACK_MAX_FILES = 800;
// 技能包的檔案本體放分塊儲存（D1 單列 2 MB 上限）；skills.files 欄只存這個小清單
export const packMeta = r => { const s = r?.files ?? r?.pack_meta; if (typeof s !== 'string' || s[0] !== '{') return null; try { return JSON.parse(s).pack || null; } catch { return null; } };

export function registerSkills({ route, db, ApiError, invalid, readJson, randId, nowIso, sha256, peopleMap, projectsOf, PROJECTS, nameOf,
  loadLeaders, adminOf, assertNoSecret, writeDm, myAi, requireHuman, loadReadOnly = async () => ({}), roIn = () => false, readOnlyError = null, setupSha = '', roleDefsMap = async () => ({}), storage = null }) {
  const bytes = s => new TextEncoder().encode(s).length;
  // 這個技能發不發給這隻 AI——安裝、私訊主人、同名檢查、待允許數、安裝統計都用這一個判斷
  // 一定要：啟用中的 AI、在技能的專案裡；指定 AI 看名單，指定角色看 role_key（平台角色與專案自訂角色都是 role_key）
  const targets = (r, ai) => {
    if (ai?.kind !== 'ai' || ai.status !== 'active' || !projectsOf(ai).includes(r.project)) return false;
    const t = targetOf(r);
    return t.ais.length ? t.ais.includes(ai.id) : !t.roles.length || t.roles.includes(ai.role_key);
  };
  const targetAis = (r, people) => [...people.values()].filter(a => targets(r, a));
  // 可選的角色：平台角色＋這個專案啟用中的自訂角色（label 是畫面上的字）
  async function roleOptions(pj) {
    const defs = ((await roleDefsMap())[pj] || []).filter(d => d.status !== 'disabled' && d.key);
    return [...ROLES.map(r => ({ key: r.key, label: r.key === 'custom' ? r.role : r.key, name: r.role })), ...defs.map(d => ({ key: d.key, label: d.role || d.key, name: d.role || d.key, custom: true }))];
  }
  // 上傳與改發給誰的輸入：roles（角色代碼）或 aiIds（這個專案裡啟用中的 AI），擇一；都空＝所有 AI
  async function readTarget(ctx, pj, body, keep = []) {
    const uniq = x => (Array.isArray(x) ? [...new Set(x.map(String))] : []);
    const roles = uniq(body.roles), ais = uniq(body.aiIds);
    if (roles.length && ais.length) throw invalid('roles 和 aiIds 只能擇一（指定角色或指定 AI）');
    if (roles.length > 30 || ais.length > 50) throw invalid('角色最多 30 個、AI 最多 50 隻');
    const ok = new Set([...(await roleOptions(pj)).map(o => o.key), ...SKILL_ROLES, ...keep]);
    const bad = roles.filter(x => !ok.has(x));
    if (bad.length) throw invalid(`沒有這個角色：${bad.join('、')}（只能選平台角色或這個專案的角色）`);
    const people = await peopleMap(ctx);
    const out = ais.filter(id => { const p = people.get(id); return !(p?.kind === 'ai' && p.status === 'active' && projectsOf(p).includes(pj)); });
    if (out.length) throw invalid('aiIds 只能選這個專案裡啟用中的 AI');
    return { roles, ais };
  }

  async function canManage(ctx, me, pj) {
    if (me.kind !== 'human') return false;
    const people = await peopleMap(ctx);
    if (adminOf(people)?.id === me.id) return true;
    return ((await loadLeaders())[pj] || []).includes(me.id);
  }
  const requireProject = pj => { if (!PROJECTS.includes(pj)) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案'); };
  const inProject = (me, pj) => projectsOf(me).includes(pj);
  // 唯讀成員（及他的 AI）不能上傳、核准、下架技能
  const assertWritable = async (me, pj) => { const map = await loadReadOnly(); if (roIn(me, pj, map)) throw readOnlyError ? readOnlyError(me, pj) : new ApiError(403, 'READ_ONLY', '你在這個專案是唯讀'); };
  // 能看＝在專案、或有 AI 在專案（主人要決定允不允許）、或能管理（管理員不在專案也算）
  const canSee = async (ctx, me, pj) => inProject(me, pj) || await ownsAiIn(ctx, me, pj) || await canManage(ctx, me, pj);
  // 主人看得到自己 AI 所在專案的技能（要決定允不允許）
  const ownsAiIn = async (ctx, me, pj) => me.kind === 'human' && [...(await peopleMap(ctx)).values()].some(p => p.kind === 'ai' && p.owner_id === me.id && p.status === 'active' && projectsOf(p).includes(pj));

  // 驗證上傳的檔案：要 SKILL.md（frontmatter 有 name、description）、1 MB 內、100 個檔內、只收文字、擋金鑰
  // 最上層有 .claude-plugin/plugin.json 就是技能包（Claude Code 外掛）：名稱看 plugin.json、文字 5 MB、800 檔內、skills/ 底下至少一個 SKILL.md
  async function validate(files) {
    if (!Array.isArray(files) || !files.length) throw invalid('files 需為 [{ path, text }]，至少一個檔');
    const pack = files.some(f => String(f?.path || '').replace(/\\/g, '/').replace(/^\.\/+/, '') === PLUGIN_JSON);
    const maxFiles = pack ? PACK_MAX_FILES : SKILL_MAX_FILES, maxBytes = pack ? PACK_MAX_BYTES : SKILL_MAX_BYTES;
    if (files.length > maxFiles) throw invalid(pack ? `技能包最多 ${PACK_MAX_FILES} 個檔（圖片等非文字檔不算，上傳前拿掉）` : `一個技能最多 ${SKILL_MAX_FILES} 個檔`);
    const seen = new Set();
    let total = 0;
    const out = files.map(f => {
      const path = String(f?.path || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
      if (!path || path.length > 200 || path.startsWith('/') || path.split('/').some(s => !SEG_RE.test(s) || s === '.' || s === '..')) throw invalid(`檔名不合法：${path || '（空白）'}（只能用英數、. _ -，不能有 ..）`);
      if (seen.has(path)) throw invalid(`檔名重複：${path}`);
      seen.add(path);
      if (typeof f.text !== 'string') throw invalid(`${path} 不是文字檔（技能只收文字，二進位檔請拿掉）`);
      if (f.text.includes('\u0000') || f.text.includes('�')) throw invalid(`${path} 看起來是二進位檔（技能只收文字）`);
      total += bytes(f.text);
      if (KEYISH.test(f.text)) throw new ApiError(400, 'SECRET_IN_TEXT', `${path} 裡有像金鑰的內容（私鑰、雲端金鑰、Token），請拿掉再上傳`);
      return { path, text: f.text };
    });
    if (total > maxBytes) throw invalid(pack ? `技能包的文字要在 5 MB 內（目前 ${(total / 1048576).toFixed(2)} MB）` : `技能整包要在 1 MB 內（目前 ${(total / 1048576).toFixed(2)} MB）`);
    if (pack) {
      let pj = null; try { pj = JSON.parse(out.find(f => f.path === PLUGIN_JSON).text); } catch {}
      if (!pj || typeof pj.name !== 'string') throw invalid(`${PLUGIN_JSON} 要是 JSON，寫 name`);
      if (!NAME_RE.test(pj.name) || pj.name.length > 64) throw invalid(`plugin.json 的 name「${pj.name}」只能用小寫英數與單一連字號（1～64 字），也是資料夾名`);
      const skills = out.filter(f => /^skills\/[^/]+\/SKILL\.md$/.test(f.path)).map(f => f.path.split('/')[1]);
      if (!skills.length) throw invalid('技能包的 skills/ 底下至少要有一個技能（skills/<名稱>/SKILL.md）');
      for (const f of out) await assertNoSecret(f.text);
      const scripts = out.filter(f => isScript(f.path));
      return { files: out, name: pj.name, description: String(pj.description || `技能包，${skills.length} 個技能`).slice(0, 300), size: total, scripts: scripts.length,
        pack: { skills: skills.length, agents: out.filter(f => /^agents\/[^/]+\.md$/.test(f.path)).length, files: out.length, runs: scripts.filter(f => runsScript(f.path)).length } };
    }
    const skill = out.find(f => f.path === 'SKILL.md');
    if (!skill) throw invalid('最上層要有 SKILL.md');
    const fm = parseFrontmatter(skill.text);
    if (!fm?.name || !fm?.description) throw invalid('SKILL.md 開頭要有 frontmatter，寫 name 與 description');
    if (!NAME_RE.test(fm.name) || fm.name.length > 64) throw invalid(`name「${fm.name}」只能用小寫英數與單一連字號（1～64 字），也是資料夾名`);
    for (const f of out) await assertNoSecret(f.text); // 平台成員的 Token、接入連結
    return { files: out, name: fm.name, description: fm.description.slice(0, 300), size: total, scripts: out.filter(f => isScript(f.path)).length };
  }

  // AI 的技能資料夾以 name 命名，同一個 AI 收到兩個專案的同名技能只能放一份 → 上傳時就擋
  // 撞名＝別的專案有上架或待核准的同名技能，而且有 AI 同時在兩個專案、兩邊的角色都會發給它
  async function assertNoClash(ctx, me, pj, name, target) {
    const others = await db.all("SELECT project, roles FROM skills WHERE name = ? AND project != ? AND status IN ('published', 'pending')", name, pj);
    if (!others.length) return;
    const people = await peopleMap(ctx);
    const ais = targetAis({ project: pj, roles: encTarget(target) }, people);
    for (const o of others) {
      const hit = ais.find(a => targets(o, a));
      if (!hit) continue;
      const where = inProject(me, o.project) || await canManage(ctx, me, o.project) ? `「${nameOf(o.project)}」` : '另一個專案';
      throw new ApiError(409, 'NAME_CLASH', `${where}已經有同名技能「${name}」，會一起發給 ${hit.name}；AI 的技能資料夾以名稱命名，只能放一份。請把 SKILL.md 的 name 改掉（例如加專案前綴），或調整發給誰。`);
    }
  }

  // 發給誰（畫面用）：roles＝指定角色、ais＝指定 AI（名稱照現在的；已不在專案或停用的標 gone）；都空＝所有 AI
  const targetView = (r, people) => {
    const t = targetOf(r);
    return { roles: t.roles, aiIds: t.ais, ais: t.ais.map(id => { const p = people?.get(id); return { participantId: id, name: p?.name || '（已移除）', gone: !(p && targets(r, p)) }; }) };
  };
  // 技能包的檔案本體在分塊儲存（key 記在 files 欄的小清單）；單一技能照舊在 files 欄
  const PACK_KEY = id => `skillpack_${id}`;
  async function filesOf(r) {
    const m = packMeta(r);
    if (!m) return JSON.parse(r.files);
    const b = storage ? await storage.get(m.key) : null;
    if (!b) throw new ApiError(500, 'PACK_MISSING', `技能包「${r.name}」的檔案不見了，請重新上傳`);
    return JSON.parse(new TextDecoder().decode(b));
  }
  const view = (r, people, { withFiles = false } = {}) => ({
    skillId: r.id, project: r.project, name: r.name, version: r.version, description: r.description, sha256: r.sha256, size: r.size,
    kind: packMeta(r) ? 'pack' : 'skill', ...(packMeta(r) ? { pack: (({ skills, agents, files, runs }) => ({ skills, agents, files, runs }))(packMeta(r)) } : {}),
    hasScripts: !!r.has_scripts, scripts: r.has_scripts || 0, ...targetView(r, people), status: r.status,
    uploadedBy: { participantId: r.uploaded_by, name: people?.get(r.uploaded_by)?.name || '?' }, uploadedAt: r.uploaded_at,
    ...(r.reviewed_by ? { reviewedBy: { participantId: r.reviewed_by, name: people?.get(r.reviewed_by)?.name || '?' }, reviewedAt: r.reviewed_at, reviewNote: r.review_note || '' } : {}),
    ...(withFiles ? { files: r.__files } : {}), // 先用 filesOf 讀好放 __files（技能包在分塊儲存）
  });

  // 平台私訊主人（發送者記 system，網頁顯示「平台通知」；放在主人與他在這個專案第一個 AI 的私訊串；每位主人一則）
  // 一則寫「你有 N 隻 AI 會用到」，附同步清單的連結（text 是 n => 文字）
  // r：技能列（看 project 與 roles 決定發給誰）；ais：直接給名單（改發給誰時只通知新加的或被拿掉的）
  async function tellOwners(ctx, r, text, key, ais = null) {
    const people = await peopleMap(ctx), pj = r.project;
    const byOwner = new Map();
    for (const ai of ais || targetAis(r, people)) {
      const human = people.get(ai.owner_id);
      if (!human || human.status !== 'active') continue;
      if (!byOwner.has(human.id)) byOwner.set(human.id, { human, ais: [] });
      byOwner.get(human.id).ais.push(ai);
    }
    for (const { human, ais } of byOwner.values()) await writeDm({ human, ai: ais[0], from: 'system', text: text(ais.length), project: pj, requestId: `skill_${key}_${human.id}` }).catch(() => {});
  }
  const syncLink = base => (base ? `${base}/my-ai?sync=1` : '「我的 AI」');
  async function publish(ctx, r, by, base) {
    const at = nowIso();
    await db.batch([
      ["UPDATE skills SET status = 'superseded' WHERE project = ? AND name = ? AND status = 'published' AND id != ?", [r.project, r.name, r.id]],
      ["UPDATE skills SET status = 'published', reviewed_by = COALESCE(?, reviewed_by), reviewed_at = COALESCE(?, reviewed_at) WHERE id = ?", [by, by ? at : null, r.id]],
    ]);
    await tellOwners(ctx, r, n => `🧩 技能有新版：${nameOf(r.project)} 的「${r.name}」第 ${r.version} 版${r.has_scripts ? `（含腳本 ${r.has_scripts} 個，要你允許才會安裝）` : ''}，你有 ${n} 隻 AI 會用到。前往同步（按「全部同步」一次處理）：${syncLink(base)}`, r.id);
  }

  // 每個技能的安裝狀況：目標 AI（專案＋角色）裡，裝了這一版幾台、含腳本的有幾台等主人允許
  async function installStats(_pj, rows) {
    if (!rows.length) return new Map();
    const people = await peopleMap({});
    const allAis = [...people.values()].filter(p => p.kind === 'ai' && p.status === 'active');
    const ids = JSON.stringify(rows.map(r => r.id));
    const inst = await db.all('SELECT ai_id, skill_id FROM skill_installs WHERE skill_id IN (SELECT value FROM json_each(?))', ids);
    const allow = await db.all('SELECT ai_id, skill_id FROM skill_allows WHERE skill_id IN (SELECT value FROM json_each(?))', ids);
    const has = (list, a, s) => list.some(x => x.ai_id === a && x.skill_id === s);
    return new Map(rows.map(r => {
      const target = allAis.filter(a => targets(r, a));
      return [r.id, { target: target.length, installed: target.filter(a => has(inst, a.id, r.id)).length, waitingOwner: r.has_scripts ? target.filter(a => !has(allow, a.id, r.id)).length : 0 }];
    }));
  }

  // ---------- 技能分頁：一次拿全部 ----------
  route('GET', '/api/skills', async ({ ctx, me }) => {
    const people = await peopleMap(ctx);
    const admin = me.kind === 'human' && adminOf(people)?.id === me.id;
    const leaders = await loadLeaders();
    const pjs = PROJECTS.filter(pj => admin || inProject(me, pj));
    if (!pjs.length) return { items: [], projects: [], roles: ROLES.map(r => r.key) };
    const ro = await loadReadOnly();
    const manageOf = pj => me.kind === 'human' && !roIn(me, pj, ro) && (admin || (leaders[pj] || []).includes(me.id));
    const rows = (await db.all("SELECT id, project, name, version, description, sha256, size, has_scripts, roles, CASE WHEN substr(files, 1, 1) = '{' THEN files END AS pack_meta, status, uploaded_by, uploaded_at, reviewed_by, reviewed_at, review_note FROM skills WHERE status != 'superseded' AND project IN (SELECT value FROM json_each(?)) ORDER BY uploaded_at DESC", JSON.stringify(pjs)))
      .filter(r => manageOf(r.project) || r.status === 'published' || r.uploaded_by === me.id);
    const stats = await installStats(null, rows.filter(r => r.status === 'published'));
    const ais = [...people.values()].filter(p => p.kind === 'ai' && p.status === 'active');
    const opts = new Map(await Promise.all(pjs.map(async pj => [pj, await roleOptions(pj)])));
    return {
      items: rows.map(r => ({ ...view(r, people), ...(stats.get(r.id) ? { install: stats.get(r.id) } : {}), canReview: r.status === 'pending' && manageOf(r.project) && r.uploaded_by !== me.id })),
      projects: pjs.map(pj => ({ id: pj, name: nameOf(pj), count: rows.filter(r => r.project === pj && r.status !== 'removed' && r.status !== 'rejected').length,
        canUpload: me.kind === 'human' && inProject(me, pj) && !roIn(me, pj, ro), canManage: manageOf(pj),
        roles: opts.get(pj), // 可選的角色（平台角色＋專案自訂角色）
        ais: ais.filter(a => projectsOf(a).includes(pj)).map(a => ({ participantId: a.id, name: a.name, roleKey: a.role_key || '', owner: people.get(a.owner_id)?.name || '' })) })),
      roles: ROLES.map(r => r.key),
    };
  });

  // ---------- 技能庫（專案）----------
  route('GET', '/api/projects/:id/skills', async ({ ctx, me, params }) => {
    const pj = params.id; requireProject(pj);
    if (!(await canSee(ctx, me, pj))) throw new ApiError(403, 'FORBIDDEN', '你不屬於這個專案');
    const manage = await canManage(ctx, me, pj);
    const rows = await db.all("SELECT id, project, name, version, description, sha256, size, has_scripts, roles, CASE WHEN substr(files, 1, 1) = '{' THEN files END AS pack_meta, status, uploaded_by, uploaded_at, reviewed_by, reviewed_at, review_note FROM skills WHERE project = ? ORDER BY name, version DESC", pj);
    const people = await peopleMap(ctx);
    // 一般成員：已上架的＋自己上傳的；leader／管理員：除了舊版都看得到
    const shown = rows.filter(r => r.status !== 'superseded' && (manage || r.status === 'published' || r.uploaded_by === me.id));
    const stats = await installStats(pj, shown.filter(r => r.status === 'published'));
    return { items: shown.map(r => ({ ...view(r, people), ...(stats.get(r.id) ? { install: stats.get(r.id) } : {}) })), canManage: manage, canUpload: me.kind === 'human' && inProject(me, pj) && !roIn(me, pj, await loadReadOnly()), roles: await roleOptions(pj) };
  });
  route('POST', '/api/projects/:id/skills', async ({ ctx, me, params, req, base }) => {
    const pj = params.id; requireProject(pj);
    if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', 'AI 不能上傳技能，請所屬人類上傳');
    if (!inProject(me, pj)) throw new ApiError(403, 'FORBIDDEN', '只有這個專案的成員能上傳技能');
    await assertWritable(me, pj);
    const body = await readJson(req, 7 * 1024 * 1024); // 一般 API 上限 256 KB；技能放寬（技能包文字 5 MB，加上 JSON 跳脫）
    const v = await validate(body.files);
    const target = await readTarget(ctx, pj, body);
    const sha = await sha256(canonical(v.files));
    const last = await db.get('SELECT version, sha256, roles FROM skills WHERE project = ? AND name = ? ORDER BY version DESC LIMIT 1', pj, v.name);
    if (last?.sha256 === sha && encTarget(targetOf(last)) === encTarget(target)) throw new ApiError(409, 'SAME_CONTENT', `「${v.name}」內容跟第 ${last.version} 版一樣，不用重傳`);
    await assertNoClash(ctx, me, pj, v.name, target);
    const manage = await canManage(ctx, me, pj);
    const id = randId('sk'), at = nowIso();
    // 技能包的檔案本體先放分塊儲存，files 欄只存小清單（D1 單列 2 MB 上限）
    if (v.pack && !storage) throw new ApiError(503, 'NO_STORAGE', '這個環境沒有檔案儲存，不能上傳技能包');
    if (v.pack) await storage.put(PACK_KEY(id), new TextEncoder().encode(JSON.stringify(v.files)), { mime: 'application/json', name: v.name });
    const files = v.pack ? JSON.stringify({ pack: { key: PACK_KEY(id), ...v.pack } }) : JSON.stringify(v.files);
    const r = { id, project: pj, name: v.name, description: v.description, files, sha256: sha, size: v.size, has_scripts: v.scripts, roles: encTarget(target), uploaded_by: me.id, uploaded_at: at };
    // 版本號在同一句 SQL 算（MAX+1），加上唯一索引；兩人同時上傳時後到的那個會撞索引 → 請他再按一次
    try {
      await db.run('INSERT INTO skills (id, project, name, version, description, files, sha256, size, has_scripts, roles, status, uploaded_by, uploaded_at) SELECT ?,?,?, COALESCE(MAX(version), 0) + 1, ?,?,?,?,?,?,?,?,? FROM skills WHERE project = ? AND name = ?',
        r.id, r.project, r.name, r.description, r.files, r.sha256, r.size, r.has_scripts, r.roles, 'pending', r.uploaded_by, r.uploaded_at, pj, v.name);
    } catch (e) {
      if (v.pack) await storage.delete(PACK_KEY(id)).catch(() => {});
      if (/UNIQUE/i.test(String(e?.message))) throw new ApiError(409, 'BUSY', `剛好有人同時上傳「${v.name}」，請再按一次送出`);
      throw e;
    }
    r.version = (await db.get('SELECT version FROM skills WHERE id = ?', r.id)).version;
    await db.run("UPDATE skills SET status = 'superseded' WHERE project = ? AND name = ? AND status = 'pending' AND id != ?", pj, v.name, r.id); // 新版上傳：舊的待核准版作廢，不用審兩次
    const direct = !v.scripts || manage; // 純文字，或 leader／管理員上傳 → 直接上架
    if (direct) await publish(ctx, r, null, base);
    return { __status: 201, ...view({ ...r, status: direct ? 'published' : 'pending' }, await peopleMap(ctx)) };
  });
  // 單一版本：全文；附上目前上架版（或上一版）的檔案，網頁算差異
  route('GET', '/api/skills/:id', async ({ ctx, me, params }) => {
    const r = await db.get('SELECT * FROM skills WHERE id = ?', params.id);
    if (!r || !(await canSee(ctx, me, r.project))) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const manage = await canManage(ctx, me, r.project) && !roIn(me, r.project, await loadReadOnly());
    if (r.status !== 'published' && !manage && r.uploaded_by !== me.id) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const prev = await db.get("SELECT * FROM skills WHERE project = ? AND name = ? AND status IN ('published', 'superseded') AND version < ? ORDER BY version DESC LIMIT 1", r.project, r.name, r.version);
    const people = await peopleMap(ctx);
    let installs = [];
    if (r.status === 'published') {
      const target = targetAis(r, people);
      const ids = JSON.stringify(target.map(a => a.id));
      const inst = new Set((await db.all('SELECT ai_id FROM skill_installs WHERE skill_id = ? AND ai_id IN (SELECT value FROM json_each(?))', r.id, ids)).map(x => x.ai_id));
      const allow = new Set((await db.all('SELECT ai_id FROM skill_allows WHERE skill_id = ? AND ai_id IN (SELECT value FROM json_each(?))', r.id, ids)).map(x => x.ai_id));
      installs = target.map(a => ({ aiId: a.id, name: a.name, owner: people.get(a.owner_id)?.name || '?', mine: a.owner_id === me.id,
        state: inst.has(a.id) ? 'installed' : r.has_scripts && !allow.has(a.id) ? 'waiting' : 'not_synced' }));
    }
    r.__files = await filesOf(r); if (prev) prev.__files = await filesOf(prev).catch(() => []);
    return { ...view(r, people, { withFiles: true }), previous: prev ? view(prev, people, { withFiles: true }) : null, canReview: r.status === 'pending' && manage && r.uploaded_by !== me.id, canManage: manage, installs };
  });
  // 核准／退回：成員上傳的含腳本技能，由 leader 或管理員看過全文與差異才按（上傳者不能核准自己的）
  route('POST', '/api/skills/:id/review', async ({ ctx, me, params, req, base }) => {
    const r = await db.get('SELECT * FROM skills WHERE id = ?', params.id);
    if (!r || !(await canSee(ctx, me, r.project))) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    if (!(await canManage(ctx, me, r.project))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能核准');
    await assertWritable(me, r.project);
    if (r.uploaded_by === me.id) throw new ApiError(403, 'SELF_REVIEW', '不能核准自己上傳的技能');
    if (r.status !== 'pending') throw new ApiError(409, 'NOT_PENDING', '這個版本已經處理過了');
    const body = await readJson(req);
    if (!['approve', 'reject'].includes(body.action)) throw invalid('action 需為 approve 或 reject');
    const note = String(body.note || '').trim().slice(0, 300);
    if (body.action === 'reject') {
      if (!note) throw invalid('退回要寫原因');
      await db.run("UPDATE skills SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'", me.id, nowIso(), note, r.id);
    } else {
      await db.run('UPDATE skills SET review_note = ? WHERE id = ?', note, r.id);
      await publish(ctx, r, me.id, base);
    }
    return view(await db.get('SELECT * FROM skills WHERE id = ?', r.id), await peopleMap(ctx));
  });
  // 下架：目前上架的版本（含待核准的）全部收起，私訊主人
  route('POST', '/api/projects/:id/skills/:name/remove', async ({ ctx, me, params, base }) => {
    const pj = params.id; requireProject(pj);
    if (!(await canManage(ctx, me, pj))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能下架技能');
    await assertWritable(me, pj);
    const cur = await db.get("SELECT project, roles FROM skills WHERE project = ? AND name = ? AND status = 'published'", pj, params.name);
    const r = await db.run("UPDATE skills SET status = 'removed' WHERE project = ? AND name = ? AND status IN ('published', 'pending')", pj, params.name);
    if (!r.changes) throw new ApiError(404, 'NOT_FOUND', '沒有上架中的這個技能');
    if (cur) await tellOwners(ctx, cur, n => `🧩 技能庫下架：${nameOf(pj)} 的「${params.name}」，你有 ${n} 隻 AI 裝過。同步後會從 AI 的技能資料夾移除（按「全部同步」一次處理）：${syncLink(base)}`, 'rm_' + pj + '_' + params.name + '_' + Date.now());
    return { removed: r.changes };
  });
  // 改發給誰：不用重傳、不升版本；上架版與待核准版一起改。跟下架同一批人（leader、管理員）能改
  // 新加入的 AI 主人收到「有新技能」，被拿掉的收到「不再發給，同步後移除」
  route('PUT', '/api/projects/:id/skills/:name/target', async ({ ctx, me, params, req, base }) => {
    const pj = params.id; requireProject(pj);
    if (!(await canManage(ctx, me, pj))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能改發給誰');
    await assertWritable(me, pj);
    const rows = await db.all("SELECT * FROM skills WHERE project = ? AND name = ? AND status IN ('published', 'pending') ORDER BY version DESC", pj, params.name);
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '沒有上架中的這個技能');
    const target = await readTarget(ctx, pj, await readJson(req), rows.flatMap(r => targetOf(r).roles));
    await assertNoClash(ctx, me, pj, params.name, target);
    const enc = encTarget(target), people = await peopleMap(ctx);
    const pub = rows.find(r => r.status === 'published');
    const before = pub ? targetAis(pub, people) : [];
    await db.run("UPDATE skills SET roles = ? WHERE project = ? AND name = ? AND status IN ('published', 'pending')", enc, pj, params.name);
    if (pub) {
      const after = targetAis({ ...pub, roles: enc }, people), had = new Set(before.map(a => a.id)), has = new Set(after.map(a => a.id));
      const added = after.filter(a => !had.has(a.id)), dropped = before.filter(a => !has.has(a.id)), stamp = Date.now();
      if (added.length) await tellOwners(ctx, pub, n => `🧩 技能改發給誰：${nameOf(pj)} 的「${pub.name}」第 ${pub.version} 版現在也發給你的 ${n} 隻 AI${pub.has_scripts ? `（含腳本 ${pub.has_scripts} 個，要你允許才會安裝）` : ''}。前往同步（按「全部同步」一次處理）：${syncLink(base)}`, `to_${pub.id}_${stamp}`, added);
      if (dropped.length) await tellOwners(ctx, pub, n => `🧩 技能改發給誰：${nameOf(pj)} 的「${pub.name}」不再發給你的 ${n} 隻 AI，同步後會從 AI 的技能資料夾移除（按「全部同步」一次處理）：${syncLink(base)}`, `tox_${pub.id}_${stamp}`, dropped);
    }
    const out = await db.get('SELECT * FROM skills WHERE id = ?', (pub || rows[0]).id);
    const stats = pub ? await installStats(pj, [out]) : new Map();
    return { ...view(out, people), ...(stats.get(out.id) ? { install: stats.get(out.id) } : {}) };
  });

  // ---------- AI 與主人 ----------
  // 某個 AI 可用的技能：它所屬專案、它的角色、已上架的；含腳本的要主人允許「這一版」
  async function skillsFor(ai) {
    const pjs = projectsOf(ai).filter(x => PROJECTS.includes(x));
    if (!pjs.length) return [];
    const rows = (await db.all("SELECT id, project, name, version, description, sha256, size, has_scripts, roles, CASE WHEN substr(files, 1, 1) = '{' THEN files END AS pack_meta FROM skills WHERE status = 'published' AND project IN (SELECT value FROM json_each(?)) ORDER BY name", JSON.stringify(pjs))).filter(r => targets(r, ai));
    const allowed = new Set((await db.all('SELECT skill_id FROM skill_allows WHERE ai_id = ?', ai.id)).map(x => x.skill_id));
    const inst = new Set((await db.all('SELECT skill_id FROM skill_installs WHERE ai_id = ?', ai.id)).map(x => x.skill_id));
    // 249：有指定（角色或 AI）的裝到 AI 自己的代號資料夾（own）；所有 AI 的照 --tool 裝共用區
    // to：發給誰（all／roles／ais），我的 AI 顯示用；指定 AI 時不列別隻的 id
    return rows.map(r => { const t = targetOf(r); return { skillId: r.id, project: r.project, name: r.name, version: r.version, description: r.description, kind: packMeta(r) ? 'pack' : 'skill', roles: t.roles, own: isTargeted(t) || !!packMeta(r), to: t.ais.length ? 'ais' : t.roles.length ? 'roles' : 'all', sha256: r.sha256, size: r.size,
      hasScripts: !!r.has_scripts, scripts: r.has_scripts || 0, allowed: !r.has_scripts || allowed.has(r.id), install: !r.has_scripts || allowed.has(r.id), installed: inst.has(r.id) }; });
  }
  route('GET', '/api/me/skills', async ({ me }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    return { items: await skillsFor(me) };
  });
  route('GET', '/api/me/skills/:id/files', async ({ me, params }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    const it = (await skillsFor(me)).find(x => x.skillId === params.id);
    if (!it) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能（可能已下架、不給你的角色或你不在這個專案）');
    if (!it.install) throw new ApiError(403, 'NOT_ALLOWED', '含腳本的技能要主人在「我的 AI › 技能」允許才能安裝');
    const r = await db.get('SELECT files, sha256, name FROM skills WHERE id = ?', it.skillId);
    return { name: r.name, sha256: r.sha256, kind: it.kind, files: await filesOf(r) };
  });
  // ---------- 同步進度與狀態 ----------
  const TOOLS = ['claude', 'codex', 'other'];
  const toolOf = b => (TOOLS.includes(b?.tool) ? b.tool : null);
  const shaOf = b => (/^[0-9a-f]{64}$/.test(b?.setupSha || '') ? b.setupSha : null);
  const NO_REPLY_MS = 10 * 60_000, STANDBY_MS = 20 * 60_000; // 待命心跳 20 分鐘內＝在線（同「待命中」）
  const ms = x => (x ? Date.parse(x) || 0 : 0);
  // 等叫醒／同步中／已裝／失敗／離線／10 分鐘沒回應
  function syncState(s, standby, now) {
    if (!s) return 'idle';
    const rq = ms(s.requested_at), st = ms(s.started_at), fin = ms(s.finished_at);
    if (fin && fin >= rq && fin >= st) return s.ok ? 'done' : 'failed';
    if (st && st >= rq) return now - st > NO_REPLY_MS ? 'noreply' : 'running';
    if (rq) return !standby ? 'offline' : now - rq > NO_REPLY_MS ? 'noreply' : 'waiting';
    return 'idle';
  }
  // 每隻 AI × 每個技能：latest ✓ 最新／new ● 有新版（已裝舊版或沒裝）／fix ⚠ 要處理（角色技能在共用區、同步工具太舊）
  async function syncView(ais) {
    if (!ais.length) return [];
    const ids = JSON.stringify(ais.map(a => a.id)), now = Date.now();
    const inst = await db.all('SELECT i.ai_id, i.skill_id, i.place, s.project, s.name, s.version FROM skill_installs i JOIN skills s ON s.id = i.skill_id WHERE i.ai_id IN (SELECT value FROM json_each(?))', ids);
    const syncs = new Map((await db.all('SELECT * FROM skill_syncs WHERE ai_id IN (SELECT value FROM json_each(?))', ids)).map(r => [r.ai_id, r]));
    const out = [];
    for (const ai of ais) {
      const s = syncs.get(ai.id) || null, mine = inst.filter(i => i.ai_id === ai.id);
      const old = !!setupSha && (mine.length > 0 || !!s?.finished_at) && s?.setup_sha !== setupSha; // 同步過、但工具不是平台這一版（舊腳本不回報＝太舊）
      const items = (await skillsFor(ai)).map(it => {
        const cur = mine.find(i => i.skill_id === it.skillId), prev = mine.find(i => i.project === it.project && i.name === it.name && i.skill_id !== it.skillId);
        if (!cur) return { ...it, state: 'new', why: !it.install ? '含腳本，等你允許' : prev ? `已裝第 ${prev.version} 版，有第 ${it.version} 版` : '還沒裝' };
        if (it.own && cur.place === 'shared') return { ...it, state: 'fix', why: '指定發給的技能裝在共用區（同資料夾別的 AI 也會載入），按同步會修好' };
        if (old) return { ...it, state: 'fix', why: '同步工具太舊，按同步會先更新' };
        return { ...it, state: 'latest', why: '' };
      });
      const removed = [...new Set(mine.filter(i => !items.some(it => it.project === i.project && it.name === i.name)).map(i => i.name))];
      const standby = !!ai.standby_at && now - ai.standby_at <= STANDBY_MS;
      const tokenExpired = !!ai.token_expires_at && ai.token_expires_at <= now; // Token 過期的叫不醒，網頁另外標「重發後才會同步」
      out.push({ aiId: ai.id, name: ai.name, roleKey: ai.role_key || '', standby, tokenExpired, tool: s?.tool || null, toolOld: old,
        needs: items.some(it => it.state !== 'latest') || removed.length > 0, waitingAllow: items.filter(it => !it.install).length, skills: items, removed,
        sync: { state: syncState(s, standby, now), requestedAt: s?.requested_at || null, startedAt: s?.started_at || null, finishedAt: s?.finished_at || null, lastLine: s && !s.ok ? s.last_line || '' : '' } });
    }
    return out;
  }
  const agentOf = ai => `${ai.role_key && ai.role_key !== 'custom' ? ai.role_key : 'AI'}_${ai.code}`;
  // 叫醒私訊（每隻一則，發送者是主人）：帶上次回報的 --tool、同步工具的 SHA-256（舊腳本由 AI 先比對、重下載）
  async function requestSync(people, me, ai, base) {
    const pj = projectsOf(ai).find(x => PROJECTS.includes(x)) || null;
    const tool = toolOf(await db.get('SELECT tool FROM skill_syncs WHERE ai_id = ?', ai.id));
    const at = nowIso();
    await writeDm({ human: people.get(me.id) || me, ai, from: me.id, project: pj, requestId: 'skillsync_' + ai.id + '_' + Date.now(),
      text: `[技能同步] 請在你的工作資料夾跑一次：node .aigile/watcher/aigile-setup.mjs --agent ${agentOf(ai)} --base ${base} --skills-only${tool ? ` --tool ${tool}` : '（第一次要加 --tool <claude|codex|other>）'}。`
        + (setupSha ? `跑之前先核對 .aigile/watcher/aigile-setup.mjs 的 SHA-256 是 ${setupSha}；不同或沒有這個檔，先從 ${base}/aigile-setup.mjs 重新下載、核對相符再跑。` : '')
        + '結果腳本會自己回報平台，成功不用回我；腳本沒辦法回報（例如連不到平台）才把最後幾行回給我。' });
    await db.run('INSERT INTO skill_syncs (ai_id, requested_at, requested_by) VALUES (?,?,?) ON CONFLICT(ai_id) DO UPDATE SET requested_at = excluded.requested_at, requested_by = excluded.requested_by', ai.id, at, me.id);
  }
  const myActiveAis = async (ctx, me) => [...(await peopleMap(ctx)).values()].filter(p => p.kind === 'ai' && p.owner_id === me.id && p.status === 'active');
  // 同步清單：主人名下每隻 AI 的技能狀態與同步進度（網頁開著清單時每幾秒讀一次）
  // ?ids=a,b：只看這幾隻（網頁跑同步時輪詢用，少讀幾列）
  route('GET', '/api/skill-sync', async ({ ctx, me, url }) => {
    requireHuman(me);
    const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const ais = await myActiveAis(ctx, me);
    return { items: await syncView(ids.length ? ais.filter(a => ids.includes(a.id)) : ais) };
  });
  // 全部同步：一次允許含腳本的（allow：[{ aiId, skillId }]），再每隻私訊叫醒
  route('POST', '/api/skill-sync', async ({ ctx, me, req, base }) => {
    requireHuman(me);
    const body = await readJson(req);
    const ids = body.aiIds, allow = body.allow === undefined ? [] : body.allow;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(x => typeof x !== 'string')) throw invalid('aiIds 需為 1～50 個 AI 的 participantId');
    if (!Array.isArray(allow) || allow.length > 500 || allow.some(x => typeof x?.aiId !== 'string' || typeof x?.skillId !== 'string')) throw invalid('allow 需為 [{ aiId, skillId }]');
    const mine = new Map((await myActiveAis(ctx, me)).map(a => [a.id, a]));
    const ais = [...new Set(ids)].map(id => mine.get(id) || null);
    if (ais.some(a => !a)) throw new ApiError(404, 'NOT_FOUND', '找不到這個 AI（不是你的，或已停用）');
    for (const x of allow) {
      const ai = ais.find(a => a.id === x.aiId);
      const it = ai && (await skillsFor(ai)).find(s => s.skillId === x.skillId && s.hasScripts);
      if (!it) throw invalid(`允許的技能不在這次同步的 AI 裡：${x.skillId}`);
      await db.run('INSERT OR IGNORE INTO skill_allows (ai_id, skill_id, by_id, at) VALUES (?,?,?,?)', ai.id, it.skillId, me.id, nowIso());
    }
    const people = await peopleMap(ctx);
    for (const ai of ais) await requestSync(people, me, ai, base);
    return { items: await syncView(ais) };
  });
  // 同步工具回報：開始（running）、失敗（failed＋最後一行；平台私訊主人一則）
  route('POST', '/api/me/skills/sync-status', async ({ ctx, me, req, base }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    const b = await readJson(req);
    if (!['running', 'failed'].includes(b.state)) throw invalid('state 需為 running 或 failed');
    const at = nowIso(), tool = toolOf(b), sha = shaOf(b);
    if (b.state === 'running') {
      await db.run('INSERT INTO skill_syncs (ai_id, started_at, tool, setup_sha) VALUES (?,?,?,?) ON CONFLICT(ai_id) DO UPDATE SET started_at = excluded.started_at, tool = COALESCE(excluded.tool, skill_syncs.tool), setup_sha = COALESCE(excluded.setup_sha, skill_syncs.setup_sha)', me.id, at, tool, sha);
      return { ok: true };
    }
    let line = String(b.lastLine || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '（沒有訊息）';
    try { await assertNoSecret(line); } catch { line = '（最後一行含 Token 或接入連結，平台沒有存）'; }
    await db.run('INSERT INTO skill_syncs (ai_id, finished_at, ok, last_line, tool, setup_sha) VALUES (?,?,0,?,?,?) ON CONFLICT(ai_id) DO UPDATE SET finished_at = excluded.finished_at, ok = 0, last_line = excluded.last_line, tool = COALESCE(excluded.tool, skill_syncs.tool), setup_sha = COALESCE(excluded.setup_sha, skill_syncs.setup_sha)', me.id, at, line, tool, sha);
    const people = await peopleMap(ctx), human = people.get(me.owner_id);
    if (human?.status === 'active') await writeDm({ human, ai: me, from: 'system', project: projectsOf(me).find(x => PROJECTS.includes(x)) || null, requestId: 'skillfail_' + me.id + '_' + at,
      text: `⚠ ${me.name} 同步技能失敗：${line}。同步清單：${syncLink(base)}` }).catch(() => {});
    return { ok: true };
  });
  // 同步完回報裝了哪些（技能庫的「已裝」）；MAIN-240 另帶位置類別（places）、工具、同步工具的 SHA-256
  route('POST', '/api/me/skills/installed', async ({ me, req }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    const b = await readJson(req), ids = b.skillIds;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => typeof x !== 'string')) throw invalid('skillIds 需為字串陣列');
    const places = b.places && typeof b.places === 'object' ? b.places : {};
    const ok = new Set((await skillsFor(me)).map(x => x.skillId));
    const at = nowIso();
    await db.batch([['DELETE FROM skill_installs WHERE ai_id = ?', [me.id]],
      ...ids.filter(x => ok.has(x)).map(x => ['INSERT OR IGNORE INTO skill_installs (ai_id, skill_id, at, place) VALUES (?,?,?,?)', [me.id, x, at, ['own', 'shared'].includes(places[x]) ? places[x] : null]]),
      // 舊腳本不帶 setupSha → 記成 NULL（狀態顯示「同步工具太舊」）
      ['INSERT INTO skill_syncs (ai_id, finished_at, ok, last_line, tool, setup_sha) VALUES (?,?,1,NULL,?,?) ON CONFLICT(ai_id) DO UPDATE SET finished_at = excluded.finished_at, ok = 1, last_line = NULL, tool = COALESCE(excluded.tool, skill_syncs.tool), setup_sha = excluded.setup_sha', [me.id, at, toolOf(b), shaOf(b)]]]);
    return { ok: true };
  });
  route('GET', '/api/my-ais/:id/skills', async ({ me, params }) => {
    requireHuman(me);
    const ai = await myAi(me, params.id);
    if (ai.status !== 'active') return { items: await skillsFor(ai) };
    const [v] = await syncView([ai]);
    return { items: v.skills, removed: v.removed, toolOld: v.toolOld, sync: v.sync };
  });
  // 主人允許／收回某一版含腳本的技能（新版要重新允許）
  route('PUT', '/api/my-ais/:id/skills/:skillId', async ({ me, params, req }) => {
    requireHuman(me);
    const ai = await myAi(me, params.id);
    const it = (await skillsFor(ai)).find(x => x.skillId === params.skillId);
    if (!it) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const allow = (await readJson(req)).allow === true;
    if (allow) await db.run('INSERT OR IGNORE INTO skill_allows (ai_id, skill_id, by_id, at) VALUES (?,?,?,?)', ai.id, it.skillId, me.id, nowIso());
    else await db.run('DELETE FROM skill_allows WHERE ai_id = ? AND skill_id = ?', ai.id, it.skillId);
    return (await skillsFor(ai)).find(x => x.skillId === params.skillId);
  });
  // 同步：私訊 AI 請它跑一次 aigile-setup（只有主人按才會叫醒；AI 不自己查）
  route('POST', '/api/my-ais/:id/skills/sync', async ({ ctx, me, params, base }) => {
    requireHuman(me);
    const ai = await myAi(me, params.id);
    await requestSync(await peopleMap(ctx), me, ai, base);
    return { ok: true };
  });

  // 我的 AI 清單：每個 AI 有幾個含腳本的技能等主人允許（排序與「技能」分頁的數字；兩句查詢，不逐台查）
  async function waitingAllow(ais) {
    const out = new Map(ais.map(a => [a.id, 0]));
    if (!ais.length) return out;
    const rows = await db.all("SELECT id, project, roles FROM skills WHERE status = 'published' AND has_scripts > 0");
    if (!rows.length) return out;
    const allow = new Set((await db.all('SELECT ai_id, skill_id FROM skill_allows WHERE ai_id IN (SELECT value FROM json_each(?))', JSON.stringify(ais.map(a => a.id)))).map(x => x.ai_id + '|' + x.skill_id));
    for (const a of ais) out.set(a.id, rows.filter(r => targets(r, a) && !allow.has(a.id + '|' + r.id)).length);
    return out;
  }
  return { waitingAllow };
}
