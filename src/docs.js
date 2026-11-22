// 專案文件區：每個專案一個長期保存的文件區（不自動過期），有資料夾（最多兩層）。
// 本體存 R2（docStorage；本機用資料夾、測試用記憶體），目錄與中繼資料存 D1 的 docs／doc_folders。
// 權限：只有該專案成員看得到（別專案的人一律 404，API 也一樣）；唯讀成員只能看、下載。
// 上傳沿用訊息附件的規則：類型白名單、檔頭比對、Office 巨集檢查、必須聲明不含程式碼與客戶個資；單檔上限 20 MB。
// 每次上傳、下載、刪除、改名、搬移都記在 file_audit；放檔、改名、搬移、刪除、建資料夾也寫進專案異動紀錄。
import { inspectFile, cleanFileName, FileRejected, formatBytes } from './files.js';
import { KB_TEXT_EXTS, KB_MAX_CHARS_PER_DOC, KB_MAX_TOTAL_CHARS, KB_MAX_PROJECT_CHUNKS, extractChunks, kbTerms, likeArg, rankChunks, snippet } from './kb.js'; // 知識庫底層

export const DOC_MAX_FILE_BYTES = 20 * 1024 * 1024;          // 單檔 20 MB
export const DOC_MAX_TOTAL_BYTES = 9 * 1024 * 1024 * 1024;   // 全部專案合計 9 GB（R2 免費 10 GB，留一點空間）
export const FOLDER_DEPTH = 2;                               // 資料夾最多兩層

export function registerDocs({ route, db, ApiError, invalid, readJson, readBody, randId, nowIso, sha256, peopleMap, identity, projectsOf, PROJECTS, assertWritable, loadReadOnly, roIn, audit, docStorage, maxFileBytes = DOC_MAX_FILE_BYTES, maxTotalBytes = DOC_MAX_TOTAL_BYTES,
  findSecret = async () => null, background = p => p, kbManager = async () => false, kbHooks = {}, kbMaxTotalChars = KB_MAX_TOTAL_CHARS, kbMaxProjectChunks = KB_MAX_PROJECT_CHUNKS }) {
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這個專案的文件區');
  // 不是這個專案的成員：當作不存在（不透露有這個專案或檔案）
  function memberOf(me, pj) {
    if (!PROJECTS.includes(pj) || !projectsOf(me).includes(pj)) throw notFound();
  }
  async function writable(me, pj) {
    memberOf(me, pj);
    await assertWritable(me, pj);
  }
  const requireStore = () => { if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境還沒開通專案文件區的儲存空間（R2）'); };
  const event = (pj, me, text) => db.run('INSERT INTO project_events (project_id, at, actor_id, text) VALUES (?,?,?,?)', pj, nowIso(), me.id, text);

  async function folderOf(pj, id) {
    const f = await db.get('SELECT * FROM doc_folders WHERE id = ? AND project = ? AND deleted_at IS NULL', id, pj);
    if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', '找不到這個資料夾（可能已刪除，或不在這個專案）');
    return f;
  }
  async function docOf(pj, id) {
    const d = await db.get('SELECT * FROM docs WHERE id = ? AND project = ? AND deleted_at IS NULL', id, pj);
    if (!d) throw new ApiError(404, 'NOT_FOUND', '找不到這個文件（可能已刪除，或不在這個專案）');
    return d;
  }
  // folderId：空字串／null＝最上層
  const readFolderId = v => (v === undefined ? undefined : v === null || v === '' ? null : String(v));
  // 資料夾路徑（顯示在紀錄裡）：「規格/v1」；最上層是「最上層」
  async function pathOf(pj, folderId) {
    if (!folderId) return '最上層';
    const f = await db.get('SELECT * FROM doc_folders WHERE id = ? AND project = ?', folderId, pj);
    if (!f) return '最上層';
    const p = f.parent_id ? await db.get('SELECT name FROM doc_folders WHERE id = ?', f.parent_id) : null;
    return p ? `${p.name}/${f.name}` : f.name;
  }
  function readFolderName(raw) {
    const name = String(raw ?? '').trim();
    if (!name || name.length > 50 || /[\\/\n\r\u0000-\u001f]/.test(name)) throw invalid('資料夾名稱需為 1～50 字，不可含 / \\ 或換行');
    return name;
  }
  async function siblingTaken(pj, parentId, name, exceptId = '') {
    return !!(await db.get(`SELECT id FROM doc_folders WHERE project = ? AND deleted_at IS NULL AND name = ? AND id != ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`, pj, name, exceptId, ...(parentId ? [parentId] : [])));
  }
  const docView = (d, people) => ({
    docId: d.id, name: d.name, ext: d.ext, size: d.size, sha256: d.sha256, folderId: d.folder_id || null,
    uploader: people.get(d.uploader_id) ? identity(people.get(d.uploader_id), people) : { participantId: d.uploader_id },
    createdAt: d.created_at, updatedAt: d.updated_at,
    downloadUrl: `/api/projects/${encodeURIComponent(d.project)}/docs/${d.id}`,
    kb: kbView(d), 
  });

  // ---------- 知識庫底層：抽字、分段 ----------
  // 只有 in_kb＝1（放進知識庫）的文件才抽字、整理、被搜；一般專案文件只存原檔，狀態是 off
  // kb_status：pending 抽字中／indexed 已抽字／original 只有原檔（PDF、圖片）／secret 含疑似密鑰未建索引／failed 抽字失敗／full 全站字數已滿；空＝舊文件還沒建
  // 抽字中超過 10 分鐘還沒結束（背景工作被停掉）就當失敗，可以補建索引重試
  const KB_STUCK_MS = 10 * 60_000;
  const kbState = d => (!d.in_kb ? 'off' : d.kb_status === 'pending' && Date.now() - Date.parse(d.kb_at || 0) > KB_STUCK_MS ? 'failed' : d.kb_status || 'none');
  const kbView = d => ({ inKb: !!d.in_kb, status: kbState(d), chunks: d.kb_chunks || 0, chars: d.kb_chars || 0, truncated: !!d.kb_truncated });
  const setKb = (id, status, n = 0, chars = 0, truncated = 0) => db.run('UPDATE docs SET kb_status = ?, kb_chunks = ?, kb_chars = ?, kb_truncated = ?, kb_at = ? WHERE id = ?', status, n, chars, truncated ? 1 : 0, nowIso(), id);
  // 抽字並寫入 kb_chunks（舊的先刪）。一次 INSERT 多段（json_each），D1 每次請求的查詢數有上限
  // by：誰放進知識庫（leader／管理員放的才自動排整理卡）
  async function indexDoc(d, bytes, by) {
    try {
      await db.run('DELETE FROM kb_chunks WHERE doc_id = ?', d.id);
      if (!KB_TEXT_EXTS.includes(d.ext)) return await setKb(d.id, 'original');
      const r = await extractChunks(d.ext, bytes, KB_MAX_CHARS_PER_DOC);
      const used = (await db.get('SELECT COALESCE(SUM(kb_chars), 0) AS s FROM docs WHERE deleted_at IS NULL AND in_kb = 1 AND id != ?', d.id)).s;
      if (used + r.chars > kbMaxTotalChars) return await setKb(d.id, 'full');
      if (await findSecret(r.chunks.map(c => `${c.section}\n${c.content}`).join('\n'))) return await setKb(d.id, 'secret');
      if (!(await db.get('SELECT id FROM docs WHERE id = ? AND deleted_at IS NULL AND in_kb = 1', d.id))) return; // 抽字期間被刪掉或移出知識庫了
      const at = nowIso(), rows = r.chunks.map((c, i) => ({ id: randId('kbc'), idx: i, s: c.section, c: c.content }));
      const stmts = [];
      for (let i = 0; i < rows.length; i += 50) stmts.push(["INSERT INTO kb_chunks (id, project, doc_id, idx, section, content, doc_sha256, created_at) SELECT json_extract(value, '$.id'), ?, ?, CAST(json_extract(value, '$.idx') AS INTEGER), json_extract(value, '$.s'), json_extract(value, '$.c'), ?, ? FROM json_each(?)",
        [d.project, d.id, d.sha256, at, JSON.stringify(rows.slice(i, i + 50))]]);
      stmts.push(['UPDATE docs SET kb_status = ?, kb_chunks = ?, kb_chars = ?, kb_truncated = ?, kb_at = ? WHERE id = ?', ['indexed', rows.length, r.chars, r.truncated ? 1 : 0, at, d.id]]);
      await db.batch(stmts);
      await kbHooks.afterIndex?.(d.id, by); // leader／管理員放進知識庫的自動排進整理卡
    } catch (e) {
      console.error(`kb index ${d.id} failed:`, e.message);
      await db.run('DELETE FROM kb_chunks WHERE doc_id = ?', d.id).catch(() => {});
      await setKb(d.id, 'failed').catch(() => {});
    }
  }
  async function startIndex(d, bytes, by) {
    await setKb(d.id, KB_TEXT_EXTS.includes(d.ext) ? 'pending' : 'original');
    background(KB_TEXT_EXTS.includes(d.ext) ? indexDoc(d, bytes, by) : kbHooks.afterIndex?.(d.id, by)); // PDF、圖片不抽字，也可以整理（AI 讀原檔）
  }
  const kbOnly = async (ctx, me, pj, what) => { if (!(await kbManager(ctx, me, pj))) throw new ApiError(403, 'FORBIDDEN', `只有專案 leader 或群組管理員能${what}`); };
  const folderView = f => ({ folderId: f.id, name: f.name, parentId: f.parent_id || null, createdAt: f.created_at, createdBy: f.created_by });

  // 清單：整個專案的資料夾與文件一次給（前端自己組樹）
  route('GET', '/api/projects/:id/docs', async ({ ctx, me, params }) => {
    const pj = params.id;
    memberOf(me, pj);
    await loadReadOnly();
    const people = await peopleMap(ctx);
    const folders = await db.all('SELECT * FROM doc_folders WHERE project = ? AND deleted_at IS NULL ORDER BY name', pj);
    const docs = await db.all('SELECT * FROM docs WHERE project = ? AND deleted_at IS NULL ORDER BY name', pj);
    const used = (await db.get('SELECT COALESCE(SUM(size), 0) AS s FROM docs WHERE deleted_at IS NULL')).s;
    const marks = (await kbHooks.docMarks?.(pj, docs)) || new Map(); // 已整理／可能過時／排在整理卡
    return {
      project: pj, folders: folders.map(folderView), items: docs.map(d => { const v = docView(d, people), m = marks.get(d.id); if (m) Object.assign(v.kb, m); return v; }),
      projectBytes: docs.reduce((n, d) => n + d.size, 0), usedBytes: used, limitBytes: maxTotalBytes, maxFileBytes,
      maxFolderDepth: FOLDER_DEPTH, enabled: !!docStorage, canWrite: !roIn(me, pj),
      canManageKb: await kbManager(ctx, me, pj), // 補建索引
    };
  });

  // 上傳一個檔（原始位元組）：?name=檔名&folderId=&declared=true&kb=1。多選上傳＝前端一個一個送，各自回成功或失敗原因
  // kb=1＝上傳到知識庫（leader／管理員才能），會抽字、自動排整理卡；沒帶＝一般專案文件，只存原檔
  // kb=1&curate=0＝照樣抽字、搜得到原文，但不排整理卡（kb_org＝off）
  route('POST', '/api/projects/:id/docs', async ({ ctx, me, req, url, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    const q = url.searchParams;
    const toKb = ['true', '1', 'yes'].includes(String(q.get('kb')).toLowerCase());
    if (toKb) await kbOnly(ctx, me, pj, '把文件放進知識庫（不帶 kb 會上傳成一般專案文件，再請 leader 加入）');
    const noCurate = toKb && ['false', '0', 'no'].includes(String(q.get('curate')).toLowerCase());
    const name = cleanFileName(q.get('name'));
    const declared = ['true', '1', 'yes'].includes(String(q.get('declared')).toLowerCase());
    let bytes = new Uint8Array(0);
    const reject = async (status, code, message, size = bytes.length) => {
      await audit('reject', me, null, { name: name || null, size, declared: declared ? 1 : 0, detail: `${code}（專案文件 ${pj}）` });
      return new ApiError(status, code, message);
    };
    try { bytes = await readBody(req, maxFileBytes, `檔案超過 ${maxFileBytes / 1048576} MB 上限`, 'FILE_TOO_LARGE'); }
    catch (e) { if (e instanceof ApiError && e.status === 413) throw await reject(413, e.code, e.message, Number(req.headers.get('content-length')) || maxFileBytes + 1); throw e; }
    if (!name) throw await reject(400, 'INVALID_REQUEST', '請用 ?name= 提供檔名（含副檔名）');
    if (!declared) throw await reject(400, 'DECLARATION_REQUIRED', '上傳前必須聲明檔案不含程式碼與客戶個資（declared=true）');
    let info;
    try { info = inspectFile(name, bytes, maxFileBytes); }
    catch (e) { if (e instanceof FileRejected) throw await reject(e.status, e.code, e.message); throw e; }
    const folderId = readFolderId(q.get('folderId')) || null;
    if (folderId) await folderOf(pj, folderId);
    const used = (await db.get('SELECT COALESCE(SUM(size), 0) AS s FROM docs WHERE deleted_at IS NULL')).s;
    if (used + bytes.length > maxTotalBytes) throw await reject(507, 'STORAGE_FULL', `文件區總容量已達 ${formatBytes(maxTotalBytes)} 上限（已用 ${formatBytes(used)}），請先刪掉不用的文件`);
    const id = randId('doc'), at = nowIso();
    const hash = await sha256(bytes);
    await docStorage.put(`docs/${id}`, bytes, { mime: info.mime, name });
    await db.run('INSERT INTO docs (id, project, folder_id, name, ext, mime, size, sha256, uploader_id, created_at, updated_at, in_kb, kb_org) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, pj, folderId, name, info.ext, info.mime, bytes.length, hash, me.id, at, at, toKb ? 1 : 0, noCurate ? 'off' : null);
    if (toKb) await startIndex({ id, project: pj, ext: info.ext, sha256: hash }, bytes, me); // 背景抽字，不擋上傳
    const d = await db.get('SELECT * FROM docs WHERE id = ?', id);
    await audit('upload', me, { ...d, declared: 1 }, {});
    await kbHooks.afterUpload?.(d, me); // 同名新文件取代舊的 → 引用舊文件的知識頁標可能過時
    await event(pj, me, `${me.name} 上傳文件「${name}」到 ${await pathOf(pj, folderId)}（${formatBytes(bytes.length)}${toKb ? (noCurate ? '，放進知識庫、不整理' : '，放進知識庫') : ''}）`);
    return { __status: 201, doc: docView(d, await peopleMap(ctx)) };
  });

  route('GET', '/api/projects/:id/docs/:docId', async ({ me, params }) => {
    memberOf(me, params.id);
    requireStore();
    const d = await docOf(params.id, params.docId);
    const bytes = await docStorage.get(`docs/${d.id}`);
    if (!bytes) throw new ApiError(404, 'NOT_FOUND', '文件內容不存在');
    await audit('download', me, { ...d, declared: 1 });
    return new Response(bytes, {
      headers: {
        'Content-Type': d.mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="file.${d.ext}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });

  // 改名／搬移：{ name?, folderId? }（folderId: null＝搬到最上層）。改名不能換副檔名（類型檢查是照副檔名做的）
  route('PATCH', '/api/projects/:id/docs/:docId', async ({ ctx, me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const d = await docOf(pj, params.docId);
    const body = await readJson(req);
    const sets = [], args = [], notes = [];
    if (body.name !== undefined) {
      let name = cleanFileName(body.name);
      if (!name) throw invalid('name 不可空白');
      const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
      if (ext !== d.ext) name = `${name}.${d.ext}`; // 沒寫或寫錯副檔名：補回原本的，不能藉改名換類型
      if (name !== d.name) { sets.push('name = ?'); args.push(name); notes.push(`改名「${d.name}」→「${name}」`); await audit('rename', me, { ...d, declared: 1 }, { detail: name }); }
    }
    const to = readFolderId(body.folderId);
    if (to !== undefined && (to || null) !== (d.folder_id || null)) {
      if (to) await folderOf(pj, to);
      sets.push('folder_id = ?'); args.push(to);
      notes.push(`搬移「${d.name}」：${await pathOf(pj, d.folder_id)} → ${await pathOf(pj, to)}`);
      await audit('move', me, { ...d, declared: 1 }, { detail: await pathOf(pj, to) });
    }
    if (sets.length) {
      await db.run(`UPDATE docs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, nowIso(), d.id);
      await event(pj, me, `${me.name} ${notes.join('；')}`);
    }
    return { doc: docView(await db.get('SELECT * FROM docs WHERE id = ?', d.id), await peopleMap(ctx)) };
  });

  route('DELETE', '/api/projects/:id/docs/:docId', async ({ me, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    const d = await docOf(pj, params.docId);
    await docStorage.delete(`docs/${d.id}`);
    await db.run('UPDATE docs SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), me.id, d.id);
    await db.run('DELETE FROM kb_chunks WHERE doc_id = ?', d.id); 
    await kbHooks.afterDelete?.(d, me); // 引用它的知識頁標可能過時
    await audit('delete', me, { ...d, declared: 1 });
    await event(pj, me, `${me.name} 刪除文件「${d.name}」（${await pathOf(pj, d.folder_id)}）`);
    return { ok: true, docId: d.id };
  });

  // 資料夾：{ name, parentId? }；parentId 只能是第一層資料夾（最多兩層）
  route('POST', '/api/projects/:id/doc-folders', async ({ me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const body = await readJson(req);
    const name = readFolderName(body.name);
    const parentId = readFolderId(body.parentId) || null;
    if (parentId) {
      const p = await folderOf(pj, parentId);
      if (p.parent_id) throw new ApiError(400, 'FOLDER_TOO_DEEP', `資料夾最多 ${FOLDER_DEPTH} 層，「${p.name}」底下不能再建資料夾`);
    }
    if (await siblingTaken(pj, parentId, name)) throw new ApiError(409, 'NAME_TAKEN', `這裡已經有「${name}」資料夾`);
    const id = randId('dfo'), at = nowIso();
    await db.run('INSERT INTO doc_folders (id, project, parent_id, name, created_by, created_at) VALUES (?,?,?,?,?,?)', id, pj, parentId, name, me.id, at);
    await event(pj, me, `${me.name} 在 ${await pathOf(pj, parentId)} 建資料夾「${name}」`);
    return { __status: 201, folder: folderView(await db.get('SELECT * FROM doc_folders WHERE id = ?', id)) };
  });

  // 資料夾改名／搬移：{ name?, parentId? }。有子資料夾的只能放最上層（不然會變三層）
  route('PATCH', '/api/projects/:id/doc-folders/:folderId', async ({ me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const f = await folderOf(pj, params.folderId);
    const body = await readJson(req);
    const name = body.name === undefined ? f.name : readFolderName(body.name);
    const to = readFolderId(body.parentId);
    const parentId = to === undefined ? f.parent_id || null : to;
    if (parentId) {
      if (parentId === f.id) throw new ApiError(400, 'FOLDER_TOO_DEEP', '資料夾不能放進自己');
      const p = await folderOf(pj, parentId);
      if (p.parent_id) throw new ApiError(400, 'FOLDER_TOO_DEEP', `資料夾最多 ${FOLDER_DEPTH} 層，「${p.name}」底下不能再放資料夾`);
      if (await db.get('SELECT id FROM doc_folders WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1', f.id)) throw new ApiError(400, 'FOLDER_TOO_DEEP', `「${f.name}」裡面還有資料夾，只能放在最上層（最多 ${FOLDER_DEPTH} 層）`);
    }
    if (name === f.name && (parentId || null) === (f.parent_id || null)) return { folder: folderView(f) };
    if (await siblingTaken(pj, parentId, name, f.id)) throw new ApiError(409, 'NAME_TAKEN', `這裡已經有「${name}」資料夾`);
    const from = await pathOf(pj, f.id);
    await db.run('UPDATE doc_folders SET name = ?, parent_id = ? WHERE id = ?', name, parentId, f.id);
    await event(pj, me, `${me.name} 資料夾 ${from} → ${await pathOf(pj, f.id)}`);
    return { folder: folderView(await db.get('SELECT * FROM doc_folders WHERE id = ?', f.id)) };
  });

  // 刪資料夾：要先清空（不連帶刪裡面的文件，避免一次誤刪一整批）
  route('DELETE', '/api/projects/:id/doc-folders/:folderId', async ({ me, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const f = await folderOf(pj, params.folderId);
    const docs = (await db.get('SELECT COUNT(*) AS n FROM docs WHERE folder_id = ? AND deleted_at IS NULL', f.id)).n;
    const subs = (await db.get('SELECT COUNT(*) AS n FROM doc_folders WHERE parent_id = ? AND deleted_at IS NULL', f.id)).n;
    if (docs || subs) throw new ApiError(409, 'FOLDER_NOT_EMPTY', `「${f.name}」裡面還有${docs ? ` ${docs} 個文件` : ''}${subs ? ` ${subs} 個資料夾` : ''}，請先搬走或刪除`);
    const from = await pathOf(pj, f.id);
    await db.run('UPDATE doc_folders SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), me.id, f.id);
    await event(pj, me, `${me.name} 刪除資料夾「${from}」`);
    return { ok: true, folderId: f.id };
  });

  // ---------- 知識庫：搜尋、分段讀、補建索引 ----------
  // 搜尋文件原文段落：空白切最多 5 個詞，每個詞都要出現（LIKE），各取前 200 筆候選再在程式裡排序；只掃同一專案（走 idx_kb_chunks）
  // 不限搜尋次數；單一專案超過 KB_MAX_PROJECT_CHUNKS 段就不搜（LIKE 掃描的成本）
  route('GET', '/api/projects/:id/kb/search', async ({ me, url, params }) => {
    const pj = params.id;
    memberOf(me, pj);
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2 || q.length > 100) throw invalid('q 需為 2～100 字');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 20);
    const scope = url.searchParams.get('scope') || 'all';
    if (!['all', 'pages', 'docs'].includes(scope)) throw invalid('scope 只能是 all、pages、docs');

    const terms0 = kbTerms(q);
    const pages = scope !== 'docs' && kbHooks.searchPages ? await kbHooks.searchPages(pj, terms0) : []; // 知識頁排在原文前面（整理過的比較好讀）
    if (scope === 'pages') return { project: pj, q, terms: terms0, pages: pages.slice(0, limit), pageTotal: pages.length, items: [], total: 0 };
    const docs = await db.all("SELECT id, name, kb_chunks FROM docs WHERE project = ? AND deleted_at IS NULL AND in_kb = 1 AND kb_status = 'indexed'", pj);
    const total = docs.reduce((n, d) => n + d.kb_chunks, 0);
    if (total > kbMaxProjectChunks) throw new ApiError(409, 'KB_TOO_MANY', `這個專案的文件太多（${total} 段，上限 ${kbMaxProjectChunks} 段），請縮小範圍：刪掉不用的文件，或請管理員評估改用全文索引`);
    const terms = kbTerms(q);
    const cond = terms.map(() => "(content LIKE ? ESCAPE '\\' OR section LIKE ? ESCAPE '\\')").join(' AND ');
    const rows = total ? await db.all(`SELECT id, doc_id, idx, section, content FROM kb_chunks WHERE project = ? AND ${cond} LIMIT 200`, pj, ...terms.flatMap(t => [likeArg(t), likeArg(t)])) : [];
    const names = new Map(docs.map(d => [d.id, d.name]));
    const ranked = rankChunks(rows.filter(r => names.has(r.doc_id)), terms, names);
    return {
      project: pj, q, terms, pages: pages.slice(0, limit), pageTotal: pages.length, total: ranked.length, ...(rows.length >= 200 ? { more: true } : {}),
      items: ranked.slice(0, limit).map(r => ({ kind: 'doc', docId: r.doc_id, docName: names.get(r.doc_id), idx: r.idx, section: r.section, snippet: snippet(r.content, terms), score: r.score })),
    };
  });

  // 分段讀抽出的文字：from（段落序號，預設 0）、limit（預設 5，最多 20）。沒抽字的回原因（只有原檔＝給下載網址，AI 自己讀原檔）
  const KB_NOTE = {
    pending: '還在抽字，請稍後再讀', original: '這份只有原檔（PDF、圖片不抽字）：請下載原檔用你自己的讀檔工具打開；讀不了就照實寫「無法讀取」',
    secret: '含疑似密鑰，未建立索引：不提供文字', failed: '抽字失敗：請專案 leader／管理員按「補建索引」重試', full: '全站知識庫字數已滿，這份沒有抽字',
    none: '舊文件還沒建索引：請專案 leader／管理員按「補建索引」',
    off: '這份是一般專案文件，不在知識庫、沒有抽字：本機轉接腳本會把原檔下載下來（localPath），請用你自己的讀檔工具讀全文；讀不了就照實寫「無法讀取」',
  };
  route('GET', '/api/projects/:id/docs/:docId/text', async ({ me, url, params }) => {
    const pj = params.id;
    memberOf(me, pj);
    const d = await docOf(pj, params.docId);
    const st = kbState(d), base = { docId: d.id, name: d.name, ext: d.ext, status: st, totalChunks: d.kb_chunks || 0 };
    if (st !== 'indexed') return { ...base, items: [], note: KB_NOTE[st] || KB_NOTE.none, ...(['original', 'off'].includes(st) ? { original: true, downloadUrl: docView(d, new Map()).downloadUrl } : {}) };
    const from = Math.max(Number.parseInt(url.searchParams.get('from'), 10) || 0, 0);
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit'), 10) || 5, 1), 20);
    const items = await db.all('SELECT idx, section, content FROM kb_chunks WHERE project = ? AND doc_id = ? AND idx >= ? ORDER BY idx LIMIT ?', pj, d.id, from, limit);
    const last = items.length ? items[items.length - 1].idx : from - 1;
    return { ...base, from, items, ...(last + 1 < d.kb_chunks ? { nextFrom: last + 1 } : {}), ...(d.kb_truncated ? { truncated: true, note: `超過 ${KB_MAX_CHARS_PER_DOC.toLocaleString()} 字，後面沒有抽字；要讀全文請下載原檔` } : {}) };
  });

  // 補建索引（專案 leader／管理員）：{ docId? }。不帶 docId＝這個專案還沒建、失敗、卡住的，一次最多 10 份，背景逐份處理
  route('POST', '/api/projects/:id/kb/reindex', async ({ ctx, me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    await kbOnly(ctx, me, pj, '補建索引');
    const body = await readJson(req).catch(() => ({}));
    const one = body.docId ? await docOf(pj, String(body.docId)) : null;
    if (one && !one.in_kb) throw new ApiError(409, 'KB_NOT_IN', `「${one.name}」不在知識庫，不抽字；要搜得到請先加入知識庫`);
    const all = one ? [one] : (await db.all('SELECT * FROM docs WHERE project = ? AND deleted_at IS NULL AND in_kb = 1 ORDER BY created_at', pj)).filter(d => ['none', 'failed'].includes(kbState(d)));
    const batch = all.slice(0, 10);
    for (const d of batch) await setKb(d.id, KB_TEXT_EXTS.includes(d.ext) ? 'pending' : 'original');
    background((async () => {
      for (const d of batch) {
        if (!KB_TEXT_EXTS.includes(d.ext)) continue;
        const bytes = await docStorage.get(`docs/${d.id}`).catch(() => null);
        if (bytes) await indexDoc(d, bytes, me); else await setKb(d.id, 'failed');
      }
    })());
    if (batch.length) await event(pj, me, `${me.name} 補建知識庫索引（${batch.length} 份）`);
    return { started: batch.length, remaining: all.length - batch.length };
  });

  // 加入／移出知識庫（leader／管理員）：{ docIds（1～20 份）, action: 'add' | 'remove' | 'stop', curate }
  // add 帶 curate:false＝只抽字不整理；stop＝已在知識庫的改成不整理（已寫的頁留著，不再自動排整理）
  // 加入：背景抽字，抽完排進整理卡；移出：刪抽出的段落、清整理排程，引用它的知識頁標「來源已移出知識庫」（原檔留著）
  route('POST', '/api/projects/:id/kb/docs', async ({ ctx, me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    const body = await readJson(req);
    if (!['add', 'remove', 'stop'].includes(body.action)) throw invalid('action 只能是 add（加入知識庫）、remove（移出知識庫）或 stop（改成不整理）');
    if (body.curate !== undefined && typeof body.curate !== 'boolean') throw invalid('curate 要是 true（讓 AI 整理，預設）或 false（只抽字不整理）');
    await kbOnly(ctx, me, pj, { add: '把文件加入知識庫', remove: '把文件移出知識庫', stop: '把文件改成不整理' }[body.action]);
    const ids = [...new Set(Array.isArray(body.docIds) ? body.docIds.map(String) : [])];
    if (!ids.length || ids.length > 20) throw invalid('docIds 要 1～20 份文件');
    const add = body.action === 'add', stop = body.action === 'stop';
    const docs = (await db.all('SELECT * FROM docs WHERE project = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at', pj, JSON.stringify(ids)))
      .filter(d => (stop ? d.in_kb && d.kb_org !== 'off' : !!d.in_kb !== add)); // 照上傳順序排整理卡
    const done = docs.map(d => d.id), skipped = ids.filter(id => !done.includes(id));
    if (!docs.length) return { action: body.action, done, skipped };
    if (stop) {
      await db.run("UPDATE docs SET kb_org = 'off', kb_card = NULL WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(done));
    } else if (add) {
      await db.run('UPDATE docs SET in_kb = 1, kb_org = ? WHERE id IN (SELECT value FROM json_each(?))', body.curate === false ? 'off' : null, JSON.stringify(done));
      for (const d of docs) await setKb(d.id, KB_TEXT_EXTS.includes(d.ext) ? 'pending' : 'original');
      background((async () => {
        for (const d of docs) {
          if (!KB_TEXT_EXTS.includes(d.ext)) { await kbHooks.afterIndex?.(d.id, me); continue; }
          const bytes = await docStorage.get(`docs/${d.id}`).catch(() => null);
          if (bytes) await indexDoc(d, bytes, me); else await setKb(d.id, 'failed');
        }
      })());
    } else {
      await db.batch([
        ['DELETE FROM kb_chunks WHERE doc_id IN (SELECT value FROM json_each(?))', [JSON.stringify(done)]],
        ['UPDATE docs SET in_kb = 0, kb_status = NULL, kb_chunks = 0, kb_chars = 0, kb_truncated = 0, kb_at = NULL, kb_org = NULL, kb_card = NULL WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(done)]],
      ]);
      for (const d of docs) await kbHooks.afterRemove?.(d, me);
    }
    const names = docs.map(d => `「${d.name}」`).join('');
    const what = stop ? '改成不整理' : add ? `加入知識庫${body.curate === false ? '（不整理）' : ''}` : '移出知識庫';
    await event(pj, me, `${me.name} 把 ${docs.length} 份文件${what}：${names}`.slice(0, 500));
    return { action: body.action, done, skipped };
  });
}
