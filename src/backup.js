// 備份匯出與匯入：管理員在「成員與權限 › 系統」下載整個群組的資料，或在空站匯入
// 規則：
//   - 一個 JSON 檔：成員、專案、訊息、卡片、決策、技能、設定…；選填附件（訊息附件、專案文件）
//   - 不含任何登入用的東西：成員 Token、密碼雜湊、裝置登入、登入碼、邀請與救援連結、AI 接入連結
//   - 匯出、匯入都分批（每次一小段），不超過 Workers 的時間與 D1 的單次限制；網頁負責組成一個檔、再分批送回
//   - 匯入只在空站可用（只有你一位人類、沒有 AI、訊息、卡片、技能、文件）；先預覽數量再確認
//   - 匯入後你的登入（密碼、這台裝置）改掛到備份裡的管理員身上；其他人要你在「邀請」發重設登入連結，AI 要主人重發 Token
import { APP_VERSION, cmpVersion } from './version.js';

export const BACKUP_FORMAT = 'aigile-backup';
export const BACKUP_FORMAT_VERSION = 1;
// 匯出的資料表（順序＝匯入順序）。新增資料表時一定要放進 EXPORT_TABLES 或 SKIP_TABLES（backup-test 會檢查）
export const EXPORT_TABLES = ['projects', 'project_events', 'app_settings', 'participants', 'ai_state', 'messages', 'message_recipients', 'notifications', 'dms',
  'decision_resolutions', 'cards', 'card_log', 'card_msgs', 'suggestions', 'avatars', 'avatar_proposals',
  'skills', 'skill_allows', 'skill_installs', 'skill_syncs', 'join_requests', 'doc_folders', 'docs', 'files', 'file_audit', 'file_chunks'];
// 不匯出：登入用的（Token、密碼雜湊、裝置、登入碼、邀請、救援連結、登入通知、失敗次數）
// schema_migrations：每個站自己套過哪些資料庫升級，不跟著備份搬
export const SKIP_TABLES = ['devices', 'invites', 'pair_codes', 'credentials', 'login_fails', 'rescue_links', 'account_notices', 'schema_migrations'];
const FILE_TABLES = ['docs', 'files']; // 不含附件時整張不帶
const BLOB_COLS = { avatars: ['data'], avatar_proposals: ['data'], file_chunks: ['data'] };
const DROP_COLS = { participants: ['token', 'token_expires_at'] }; // 匯入時換新：Token 隨機、已過期
// app_settings 不帶的：AI 接入連結（一次性密鑰的雜湊）、預設管理員要改帳密的標記、快取用的版本、匯入中的標記、更新檢查的快取
const skipSetting = k => k.startsWith('olink:') || k.startsWith('must_change_cred:') || k.startsWith('relogin:') || ['people_ver', 'restore_state', 'update_check'].includes(k);
// 每頁幾列：一般 500；大欄位的表少一點（技能一列最多 1 MB、file_chunks 一列 512 KB、頭像是圖片）
const PAGES = { file_chunks: 1, skills: 4, avatar_proposals: 5, avatars: 20 };
const pageOf = t => PAGES[t] || 500;

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const toU8 = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v) : null);

export function registerBackup({ route, db, ApiError, invalid, readJson, readBody, randId, nowIso, requireAdmin, requireHuman, peopleMap, adminOf, storage, docStorage, afterRestore }) {
  const adminOnly = async (ctx, me) => { requireHuman(me); await requireAdmin(ctx, me, '備份與匯入'); };
  const columnsOf = async t => (await db.all(`PRAGMA table_info(${t})`)).map(c => c.name);
  // 匯入中只認開始匯入的那位（備份的成員寫進來後，最早的人類會變成管理員，不能再用 requireAdmin 判斷）
  const restorer = async me => { requireHuman(me); const st = await restoring(); if (!st || st.by !== me.id) throw new ApiError(409, 'NOT_RESTORING', '沒有你開始的匯入（先按匯入，restore/begin）'); return st; };
  const restoring = async () => { try { return JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'restore_state'"))?.value || 'null'); } catch { return null; } };
  // 空站：只有你一位人類、沒有 AI、訊息、私訊、卡片、技能、文件（新站自動建的預設專案與設定不算）
  // 只看「有沒有」（每張表讀 1 列），不數全部（D1 照讀到的列數計費）
  async function isEmpty(me) {
    const any = async (t, extra = '', ...a) => !!(await db.get(`SELECT 1 AS x FROM ${t}${extra} LIMIT 1`, ...a));
    const hits = await Promise.all([any('participants', ' WHERE id != ?', me.id), any('messages'), any('dms'), any('cards'), any('skills'), any('docs')]);
    return !hits.some(Boolean);
  }
  const fileFilter = (t, withFiles) => (t === 'file_chunks' && !withFiles ? " WHERE file_id LIKE 'skillpack\\_%' ESCAPE '\\'" : ''); // 不含附件時，技能包還是要帶
  const settingOk = r => !skipSetting(r.key);

  // 管理頁打開「系統」時看的：能不能匯入（空站）、是不是匯入到一半
  route('GET', '/api/admin/backup/status', async ({ ctx, me }) => {
    const st = await restoring();
    if (st?.by === me.id) return { empty: true, restoring: true };
    await adminOnly(ctx, me);
    return { empty: await isEmpty(me), restoring: !!st };
  });
  // ---------- 匯出 ----------
  // 先拿清單（每張表幾列、要不要帶附件），網頁再一張一張分頁拿
  route('GET', '/api/admin/backup', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    const withFiles = url.searchParams.get('files') === '1';
    const tables = [];
    for (const t of EXPORT_TABLES) {
      if (!withFiles && FILE_TABLES.includes(t)) continue;
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${t}${fileFilter(t, withFiles)}`))?.n || 0;
      tables.push({ name: t, count: n });
    }
    const docs = withFiles && docStorage ? (await db.all('SELECT id FROM docs WHERE deleted_at IS NULL')).map(r => r.id) : [];
    return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion: APP_VERSION, exportedAt: nowIso(), includeFiles: withFiles, tables, docs,
      empty: await isEmpty(me), restoring: !!(await restoring()) };
  });
  // 一張表的一頁：照 rowid 順序；BLOB 欄位轉 { $b64 }；登入用欄位不帶
  route('GET', '/api/admin/backup/rows', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    const q = url.searchParams, t = q.get('table'), withFiles = q.get('files') === '1';
    if (!EXPORT_TABLES.includes(t) || (!withFiles && FILE_TABLES.includes(t))) throw invalid('table 不在可匯出的清單');
    const after = Math.max(0, Number.parseInt(q.get('after') || '0', 10) || 0), limit = pageOf(t);
    const f = fileFilter(t, withFiles);
    const rows = await db.all(`SELECT rowid AS __rowid, * FROM ${t}${f ? f + ' AND' : ' WHERE'} rowid > ? ORDER BY rowid LIMIT ?`, after, limit + 1);
    const more = rows.length > limit, page = rows.slice(0, limit);
    const drop = DROP_COLS[t] || [], blobs = BLOB_COLS[t] || [];
    const out = page.filter(r => t !== 'app_settings' || settingOk(r)).map(r => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === '__rowid' || drop.includes(k)) continue;
        o[k] = blobs.includes(k) && v != null ? { $b64: b64(toU8(v) || new Uint8Array(0)) } : v;
      }
      return o;
    });
    return { table: t, rows: out, next: more ? page[page.length - 1].__rowid : null };
  });
  // 專案文件本體（檔案在 R2 或本機資料夾，不在資料庫）：一次一個，回原始位元組
  route('GET', '/api/admin/backup/doc', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境沒有專案文件區');
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw invalid('id 不對');
    const bytes = await docStorage.get(`docs/${id}`);
    if (!bytes) throw new ApiError(404, 'NOT_FOUND', '這份文件的檔案不見了');
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  });

  // ---------- 匯入 ----------
  // 開始：確認空站與版本 → 清掉新站自動建的資料 → 把你暫時改名（避免跟備份裡的同名成員撞）
  // 中途失敗可以再按一次（有 restore_state 時允許重來，會再清一次）
  route('POST', '/api/admin/restore/begin', async ({ ctx, me, req }) => {
    const state = await restoring();
    if (state?.by === me.id) requireHuman(me); else await adminOnly(ctx, me); // 中途失敗重來：開始匯入的那位可以再按
    const body = await readJson(req);
    if (body.format !== BACKUP_FORMAT || Number(body.formatVersion) !== BACKUP_FORMAT_VERSION) throw invalid('不是這個平台的備份檔（format／formatVersion 不對）');
    if (cmpVersion(body.appVersion, APP_VERSION) > 0) throw new ApiError(400, 'BACKUP_TOO_NEW', `備份是 ${body.appVersion} 版，比這個站（${APP_VERSION}）新；請先把這個站升級到 ${body.appVersion} 以上再匯入`);
    if (String(body.appVersion).split('.')[0] !== APP_VERSION.split('.')[0]) throw new ApiError(400, 'BACKUP_MAJOR', `備份是 ${body.appVersion} 版，跟這個站（${APP_VERSION}）的主版本不同，不能直接匯入`);
    if (!state && !(await isEmpty(me))) throw new ApiError(409, 'NOT_EMPTY', '只有空站能匯入：這個站已經有其他成員、訊息、卡片、技能或文件。請在新架的站匯入。');
    if (state && state.by !== me.id) throw new ApiError(409, 'RESTORE_BY_OTHER', '別的管理員正在匯入');
    const stmts = EXPORT_TABLES.filter(t => t !== 'participants').map(t => [`DELETE FROM ${t}`, []]);
    stmts.push(['DELETE FROM participants WHERE id != ?', [me.id]]);
    stmts.push(['UPDATE participants SET name = ?, code = ? WHERE id = ?', [`${me.name}#匯入中${me.id.slice(-6)}`, `R${me.id.slice(-7)}`, me.id]]);
    stmts.push(["INSERT INTO app_settings (key, value) VALUES ('restore_state', ?)", [JSON.stringify({ by: me.id, at: nowIso(), name: me.name, code: me.code, appVersion: body.appVersion })]]);
    await db.batch(stmts);
    if (docStorage) for (const d of await db.all('SELECT id FROM docs')) await docStorage.delete(`docs/${d.id}`).catch(() => {}); // 上面已清表；這裡保險
    await afterRestore?.();
    return { ok: true };
  });
  // 一批資料列：只收可匯入的表、只寫這個站有的欄位（舊版備份少的欄位用預設值）
  route('POST', '/api/admin/restore/rows', async ({ ctx, me, req }) => {
    await restorer(me);
    const body = await readJson(req, 6 * 1024 * 1024); // file_chunks 一列 512 KB，base64 後約 700 KB
    const t = body.table;
    if (!EXPORT_TABLES.includes(t)) throw invalid('table 不在可匯入的清單');
    if (!Array.isArray(body.rows) || body.rows.length > 1000) throw invalid('rows 要是陣列，一次最多 1000 列');
    const have = new Set(await columnsOf(t)), drop = DROP_COLS[t] || [], blobs = BLOB_COLS[t] || [];
    const stmts = [];
    for (const r of body.rows) {
      if (!r || typeof r !== 'object') throw invalid('rows 每一列要是物件');
      if (t === 'participants' && r.id === me.id) continue; // 你自己（同一個站匯回自己）：保留現在的
      if (t === 'app_settings' && (typeof r.key !== 'string' || skipSetting(r.key))) continue;
      const row = {};
      for (const [k, v] of Object.entries(r)) {
        if (!have.has(k) || drop.includes(k)) continue;
        row[k] = blobs.includes(k) && v && typeof v === 'object' ? unb64(String(v.$b64 || '')) : v;
      }
      if (t === 'participants') Object.assign(row, { token: 'h:rs_' + randId('t') + randId('t'), token_expires_at: 1 }); // 登入一律重發：AI 顯示「Token 已過期」請主人重發；人類的登入碼是沒人拿得到的亂數
      const cols = Object.keys(row);
      if (!cols.length) continue;
      stmts.push([`INSERT${t === 'app_settings' ? ' OR REPLACE' : ''} INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])]);
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    return { table: t, inserted: stmts.length };
  });
  // 專案文件本體：資料表的 docs 列先匯入，才收它的檔案
  route('POST', '/api/admin/restore/doc', async ({ ctx, me, req, url }) => {
    await restorer(me);
    if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境沒有專案文件區，文件檔案沒辦法匯入');
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !(await db.get('SELECT 1 AS x FROM docs WHERE id = ?', id))) throw invalid('沒有這份文件的資料列');
    const bytes = await readBody(req, 25 * 1024 * 1024, '單一文件超過 25 MB', 'FILE_TOO_LARGE');
    await docStorage.put(`docs/${id}`, bytes);
    return { ok: true };
  });
  // 結束：你的登入（密碼、裝置、登入碼、登入通知）改掛到備份裡的管理員身上，刪掉暫時的你；清快取
  route('POST', '/api/admin/restore/finish', async ({ ctx, me }) => {
    const state = await restorer(me);
    const rows = await db.all("SELECT * FROM participants WHERE id != ? AND kind = 'human' AND status = 'active'", me.id);
    const target = adminOf(new Map(rows.map(p => [p.id, p])));
    const stmts = [["DELETE FROM app_settings WHERE key = 'restore_state'", []]];
    if (target) {
      for (const t of ['credentials', 'devices', 'account_notices']) stmts.push([`UPDATE ${t} SET participant_id = ? WHERE participant_id = ?`, [target.id, me.id]]);
      stmts.push(['DELETE FROM participants WHERE id = ?', [me.id]]);
      stmts.push(['UPDATE participants SET token = ?, token_expires_at = ? WHERE id = ?', [me.token, me.token_expires_at || 0, target.id]]); // 你現在的登入碼也跟著過去（不是備份裡的）
      stmts.push(['UPDATE participants SET is_admin = CASE WHEN id = ? THEN 1 ELSE 0 END', [target.id]]); // 管理員＝備份裡的管理員（也就是你）
      // 其他人類的登入不在備份裡：標「要重設登入」，成員頁與總覽寫出來（他用重設連結登入、或你發了重設連結就清掉）
      stmts.push(['UPDATE participants SET last_seen_at = 0, standby_at = 0 WHERE id != ?', [target.id]]); // 在線、待命是舊站的狀態：這個站還沒人見過他們（不然進不來的人會顯示在線、AI 顯示待命）
      for (const p of rows) if (p.id !== target.id) stmts.push(["INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['relogin:' + p.id, nowIso()]]);
    } else { // 備份裡沒有人類：你照舊當管理員，名字改回來
      stmts.push(['UPDATE participants SET name = ?, code = ? WHERE id = ?', [state.name, state.code, me.id]]);
    }
    await db.batch(stmts);
    await afterRestore?.();
    const people = await peopleMap(ctx);
    const humans = [...people.values()].filter(p => p.kind === 'human').length, ais = [...people.values()].filter(p => p.kind === 'ai').length;
    return { ok: true, admin: target ? { participantId: target.id, name: target.name } : { participantId: me.id, name: state.name }, humans, ais };
  });
}
