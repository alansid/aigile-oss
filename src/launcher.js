// AI 啟動器：配對碼、已配對電腦、本機白名單同步（唯讀展示）與遠端啟動紀錄／派工
// 安全設計：
//   - 資料夾與 AI 白名單只能在該電腦本機登記（launcher_regs 僅供網頁顯示；啟動器永遠只信任本機白名單）
//   - 只有 AI 所屬的人類本人能按「啟動」（管理員也不得代按）
//   - 配對碼 6 位數、10 分鐘有效、單次使用、不含 AI Token；裝置金鑰只存 SHA-256

const ALLOWED_TOOLS = ['claude', 'codex', 'antigravity'];
const PAIR_TTL_MS = 10 * 60_000;
const ONLINE_WINDOW_MS = 90_000;
const JOB_TIMEOUT_MS = 30_000;
const JOB_MAX_POLL_AGE_MS = 60_000;
const LOG_LIMIT = 20;

const randDigits = () => {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, '0');
};

const safeDetails = new Set(['illegal_request', 'illegal_action', 'illegal_payload', 'folder not registered',
  'folder missing', 'launcher_update_required', 'tool not allowed', 'spawn_failed', '電腦沒回應', '電腦已停用', '電腦不在線']);
const safeDetail = value => safeDetails.has(value) ? value : value ? 'launch_failed' : '';

export function registerLauncher({ assertToolOn, launchTransport, localLauncherPackage = false, launcherSetupText, route, db, ApiError, invalid, readJson, randId, newToken, sha256, requireHuman, requireAdmin, peopleMap, isOnline, agentDir, live = null, notifyLauncher = null }) {
  const isLauncherOnline = (row, now = Date.now()) => !!row && !row.revoked_at && (row.last_seen_at || 0) > 0 && now - row.last_seen_at < ONLINE_WINDOW_MS;

  async function expireOldJobs(ownerId = null, now = Date.now()) {
    const cutoff = now - JOB_TIMEOUT_MS;
    if (ownerId) {
      await db.run(
        "UPDATE launcher_jobs SET status = 'timeout', detail = '電腦沒回應', updated_at = ?, finished_at = ? WHERE owner_id = ? AND (status = 'pending' OR (status = 'opened' AND setup_claimed_at IS NULL)) AND created_at < ?",
        now, now, ownerId, cutoff,
      );
    }
  }

  async function requireLauncher(req) {
    const auth = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
    const tok = m ? m[1] : '';
    if (!tok.startsWith('lk_')) throw new ApiError(401, 'UNAUTHORIZED', '缺少啟動器裝置金鑰');
    const row = await db.get('SELECT * FROM launchers WHERE token_hash = ?', await sha256(tok));
    if (!row || row.revoked_at) throw new ApiError(401, 'LAUNCHER_DISABLED', '這台電腦的啟動器已停用或找不到，請重新配對');
    const now = Date.now();
    if (now - (row.last_seen_at || 0) > 15_000) {
      await db.run('UPDATE launchers SET last_seen_at = ? WHERE id = ?', now, row.id);
      row.last_seen_at = now;
    }
    return row;
  }

  async function pairGuard(req, now) {
    const ipKey = 'launcher-pair:' + await sha256(req.headers.get('cf-connecting-ip') || 'local');
    const globalKey = 'launcher-pair:global';
    async function checkLock() {
      const lock = await db.get('SELECT MAX(locked_until) AS until FROM login_fails WHERE username IN (?, ?)', ipKey, globalKey);
      const retryAfter = Math.ceil(((lock?.until || 0) - now) / 1000);
      if (retryAfter > 0) throw new ApiError(429, 'PAIR_RATE_LIMIT', `請在 ${retryAfter} 秒後再試`, { retryAfter });
    }
    async function rejectCode() {
      await checkLock();
      const lockSql = `INSERT INTO login_fails (username, count, last_at, locked_until)
        SELECT ?, COUNT(*), ?, ? FROM launcher_pair_failures WHERE failed_at > ? AND (CAST(? AS TEXT) IS NULL OR ip_key = ?)
        HAVING COUNT(*) >= ?
        ON CONFLICT(username) DO UPDATE SET count = excluded.count, last_at = excluded.last_at,
          locked_until = excluded.locked_until WHERE login_fails.locked_until <= excluded.last_at`;
      await db.batch([
        ['DELETE FROM launcher_pair_failures WHERE failed_at <= ?', [now - PAIR_TTL_MS]],
        ['INSERT INTO launcher_pair_failures (ip_key, failed_at) VALUES (?, ?)', [ipKey, now]],
        [lockSql, [ipKey, now, now + PAIR_TTL_MS, now - PAIR_TTL_MS, ipKey, ipKey, 5]],
        [lockSql, [globalKey, now, now + PAIR_TTL_MS, now - PAIR_TTL_MS, null, null, 51]],
      ]);
      await checkLock();
      throw new ApiError(400, 'INVALID_PAIR_CODE', '配對碼不存在、已使用或已過期');
    }
    return { ipKey, globalKey, checkLock, rejectCode };
  }

  async function issuePairCode(ownerId, now, aiId, tool, browserHash, expiresAt) {
    await db.run('DELETE FROM launcher_pair_codes WHERE expires_at < ?', now - 86_400_000);
    for (let i = 0; i < 20; i++) {
      const code = randDigits();
      const exp = expiresAt;
      const issued = await db.run(
        'INSERT INTO launcher_pair_codes (code, owner_id, created_at, expires_at, ai_id, tool, browser_hash) VALUES (?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING',
        code, ownerId, now, exp, aiId, tool, browserHash,
      );
      if (!issued.changes) continue;
      return { code, aiId, tool, expiresAt: new Date(exp).toISOString() };
    }
    throw new ApiError(500, 'INTERNAL', '暫時無法產生配對碼，請稍後再試');
  }

  async function launcherStateFor(me, ctx) {
    const now = Date.now();
    await expireOldJobs(me.id, now);
    const people = await peopleMap(ctx);
    const myAis = [...people.values()].filter(p => p.kind === 'ai' && p.owner_id === me.id && p.status !== 'deleted');
    const aiMap = new Map(myAis.map(a => [a.id, a]));

    const computers = await db.all('SELECT * FROM launchers WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', me.id);
    const compIds = computers.map(c => c.id);
    const regs = compIds.length
      ? await db.all('SELECT * FROM launcher_regs WHERE launcher_id IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC', JSON.stringify(compIds))
      : [];

    const regByAi = new Map();
    const aisByLauncher = new Map();
    for (const r of regs) {
      const ai = aiMap.get(r.ai_id);
      if (!ai) continue;
      if (!regByAi.has(r.ai_id)) regByAi.set(r.ai_id, r);
      const list = aisByLauncher.get(r.launcher_id) || [];
      list.push({ aiId: ai.id, name: ai.name, agent: r.agent, folder: r.folder, tool: r.tool });
      aisByLauncher.set(r.launcher_id, list);
    }

    const folders = await db.all('SELECT f.launcher_id, f.folder FROM launcher_folders f JOIN launchers l ON l.id = f.launcher_id WHERE l.owner_id = ? AND l.revoked_at IS NULL ORDER BY f.folder', me.id);
    const compMap = new Map(computers.map(c => [c.id, c]));
    const pendingRows = await db.all("SELECT * FROM launcher_jobs WHERE owner_id = ? AND (status = 'pending' OR (status = 'opened' AND setup_claimed_at IS NULL)) ORDER BY created_at DESC", me.id);
    const pendingByAi = new Map();
    for (const j of pendingRows) if (!pendingByAi.has(j.ai_id)) pendingByAi.set(j.ai_id, { id: j.id, status: j.status, createdAt: new Date(j.created_at).toISOString() });

    const closed = await db.all(
      `SELECT j.ai_id, j.launcher_id, j.folder FROM launcher_jobs j WHERE j.owner_id = ? AND j.window_closed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM launcher_jobs newer WHERE newer.ai_id = j.ai_id
         AND newer.status IN ('opened','pending') AND newer.created_at > j.created_at)`, me.id);
    for (const [launcherId, rows] of aisByLauncher) for (const item of rows) {
      item.windowClosed = closed.some(j => j.ai_id === item.aiId && j.folder === item.folder && j.launcher_id === launcherId);
    }
    const ais = {};
    for (const ai of myAis) {
      const r = regByAi.get(ai.id);
      const comp = r ? compMap.get(r.launcher_id) : null;
      ais[ai.id] = {
        registered: !!r && !!comp,
        launcherId: comp?.id || null,
        launcherName: comp?.name || '',
        launcherOnline: comp ? isLauncherOnline(comp, now) : false,
        launcherLastSeenAt: comp?.last_seen_at ? new Date(comp.last_seen_at).toISOString() : null,
        folder: r?.folder || '',
        tool: r?.tool || '',
        agent: r?.agent || agentDir(ai),
        pendingJob: pendingByAi.get(ai.id) || null,
      };
    }

    const logRows = await db.all(
      'SELECT j.*, l.name AS l_name FROM launcher_jobs j LEFT JOIN launchers l ON l.id = j.launcher_id WHERE j.owner_id = ? ORDER BY j.created_at DESC LIMIT ?',
      me.id, LOG_LIMIT,
    );
    const logs = logRows.map(j => ({
      id: j.id,
      aiId: j.ai_id,
      aiName: people.get(j.ai_id)?.name || j.agent,
      launcherId: j.launcher_id,
      launcherName: j.l_name || '電腦',
      status: j.status,
      detail: safeDetail(j.detail),
      createdAt: new Date(j.created_at).toISOString(),
      finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
    }));

    return {
      localLauncherPackage,
      launchers: computers.map(c => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        online: isLauncherOnline(c, now),
        lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
        createdAt: new Date(c.created_at).toISOString(),
        ais: aisByLauncher.get(c.id) || [],
        folders: folders.filter(f => f.launcher_id === c.id).map(f => f.folder),
      })),
      ais,
      logs,
    };
  }

  // ---------- 人類網頁端點 ----------
  route('GET', '/api/admin/launcher-pair-alert', async ({ me, ctx }) => {
    await requireAdmin(ctx, me, '查看配對告警');
    const lock = await db.get("SELECT last_at, locked_until FROM login_fails WHERE username = 'launcher-pair:global' AND locked_until > ?", Date.now());
    if (!lock) return { alert: null };
    const totals = await db.get('SELECT COUNT(*) AS failures, COUNT(DISTINCT ip_key) AS sources FROM launcher_pair_failures WHERE failed_at > ? AND failed_at <= ?', lock.last_at - PAIR_TTL_MS, lock.last_at);
    return { alert: { until: lock.locked_until, ...totals } };
  });

  route('GET', '/api/launcher', async ({ me, ctx }) => {
    requireHuman(me);
    return launcherStateFor(me, ctx);
  });

  route('POST', '/api/launcher/pair-code', async ({ me, req, ctx }) => {
    requireHuman(me);
    const { aiId, tool, confirmationCode, browserHash } = await readJson(req);
    if (browserHash !== undefined) throw invalid('無效的瀏覽器配對請求');
    const ai = (await peopleMap(ctx)).get(aiId);
    if (!ai || ai.kind !== 'ai' || ai.cloud_conn || ai.owner_id !== me.id || ai.status !== 'active') throw invalid('請選擇自己名下啟用的 AI');
    if (!ALLOWED_TOOLS.includes(tool)) throw invalid('請選擇支援的工具');
    await assertToolOn(tool);
    const request = await findBrowserRequest(req, confirmationCode, true);
    await issuePairCode(me.id, Date.now(), aiId, tool, request.secret_hash, request.created_at + PAIR_TTL_MS);
    return { approved: true };
  });

  async function findBrowserRequest(req, code, consume) {
    const now = Date.now();
    const guard = await pairGuard(req, now);
    await guard.checkLock();
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!/^[A-F0-9]{8}$/.test(normalized)) await guard.rejectCode();
    const where = ' WHERE code_hash = ? AND created_at > ?';
    const query = consume ? 'DELETE FROM launcher_browser_requests' + where + ' RETURNING *'
      : 'SELECT * FROM launcher_browser_requests' + where;
    const row = await db.get(query, await sha256(normalized), now - PAIR_TTL_MS);
    if (!row) await guard.rejectCode();
    return row;
  }

  route('POST', '/api/launcher/browser-request', async ({ req }) => {
    const { secret, name, platform, folder, deviceToken } = await readJson(req);
    if (typeof secret !== 'string' || !/^[a-f0-9-]{36}$/.test(secret) || typeof name !== 'string' || !name.trim() || typeof platform !== 'string' || !platform.trim()) throw invalid('無效的瀏覽器配對請求');
    if (typeof folder !== 'string' || !folder.trim() || folder.length > 500) throw invalid('資料夾路徑無效');
    const now = Date.now();
    const guard = await pairGuard(req, now);
    await guard.checkLock();
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    await db.run('DELETE FROM launcher_browser_requests WHERE created_at <= ?', now - PAIR_TTL_MS);
    const code = crypto.randomUUID().slice(0, 8).toUpperCase();
    const inserted = await db.run(
      'INSERT INTO launcher_browser_requests (code_hash, secret_hash, name, platform, ip, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM launcher_browser_requests WHERE ip = ?) < 50 ON CONFLICT DO NOTHING',
      await sha256(code), await sha256(secret), name.slice(0, 80), platform.slice(0, 32), ip, now, ip);
    if (!inserted.changes) throw invalid('暫時無法產生配對碼，請稍後再試');
    await db.run('DELETE FROM launcher_pair_workspaces WHERE expires_at <= ?', now);
    const returning = typeof deviceToken === 'string' && deviceToken.startsWith('lk_') ? await db.get('SELECT id FROM launchers WHERE token_hash = ? AND revoked_at IS NULL', await sha256(deviceToken)) : null;
    await db.run('INSERT INTO launcher_pair_workspaces (secret_hash, folder, expires_at, returning_id) VALUES (?, ?, ?, ?)', await sha256(secret), folder, now + PAIR_TTL_MS, returning?.id || null);
    return { code };
  }, { open: true });

  route('POST', '/api/launcher/browser-preview', async ({ me, req }) => {
    requireHuman(me);
    const row = await findBrowserRequest(req, (await readJson(req)).confirmationCode, false);
    const workspace = await db.get('SELECT w.folder, l.id AS returning_id FROM launcher_pair_workspaces w LEFT JOIN launchers l ON l.id = w.returning_id AND l.owner_id = ? AND l.revoked_at IS NULL WHERE w.secret_hash = ? AND w.expires_at > ?', me.id, row.secret_hash, Date.now());
    if (!workspace) throw invalid('無效的配對請求');
    return { returning: !!workspace.returning_id, name: row.name, platform: row.platform, folder: workspace.folder, ip: row.ip, createdAt: row.created_at };
  });

  route('POST', '/api/launcher/browser-result', async ({ req }) => {
    const { secret } = await readJson(req);
    if (typeof secret !== 'string' || !/^[a-f0-9-]{36}$/.test(secret)) throw invalid('無效的配對請求');
    const row = await db.get('SELECT code FROM launcher_pair_codes WHERE browser_hash = ? AND used_at IS NULL AND expires_at > ?', await sha256(secret), Date.now());
    return { code: row?.code || null };
  }, { open: true });

  route('PATCH', '/api/launchers/:id', async ({ me, params, req }) => {
    requireHuman(me);
    const { name } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw invalid('電腦名稱請填 1 到 80 個字');
    const row = await db.get('UPDATE launchers SET name = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL RETURNING id, name', name.trim(), params.id, me.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '找不到這台電腦的啟動器');
    return row;
  });

  route('POST', '/api/launchers/:id/disable', async ({ me, params }) => {
    requireHuman(me);
    const row = await db.get('SELECT * FROM launchers WHERE id = ? AND owner_id = ?', params.id, me.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '找不到這台電腦的啟動器');
    const now = Date.now();
    await db.batch([
      ['UPDATE launchers SET revoked_at = ? WHERE id = ? AND owner_id = ?', [now, row.id, me.id]],
      ['DELETE FROM launcher_regs WHERE launcher_id = ?', [row.id]],
      ["UPDATE launcher_jobs SET status = 'refused', detail = '電腦已停用', updated_at = ?, finished_at = ? WHERE launcher_id = ? AND status = 'pending'", [now, now, row.id]],
    ]);
    return { disabled: true, id: row.id };
  });

  route('POST', '/api/my-ais/:id/launch', async ({ me, params, ctx, req }) => {
    requireHuman(me);
    const people = await peopleMap(ctx);
    const ai = people.get(params.id);
    if (!ai || ai.kind !== 'ai' || ai.cloud_conn || ai.status === 'deleted') throw new ApiError(404, 'NOT_FOUND', '找不到這隻 AI');
    // 安全底線：只有這隻 AI 的主人本人能按「啟動」，管理員也不行
    if (ai.owner_id !== me.id) throw new ApiError(403, 'FORBIDDEN', '只有這隻 AI 的主人能按「啟動」');
    if (ai.status !== 'active') throw new ApiError(409, 'AI_DISABLED', '這隻 AI 已停用，請先重新啟用。');


    const target = await readJson(req);
    const explicit = target?.launcherId !== undefined || target?.folder !== undefined;
    if (explicit && (!target.launcherId || !target.folder || typeof target.launcherId !== 'string' || typeof target.folder !== 'string')) {
      throw invalid('請選擇已登記的電腦與資料夾');
    }
    const reg = explicit
      ? await db.get('SELECT f.folder, l.id AS l_id, l.name AS l_name, l.last_seen_at AS l_seen, l.revoked_at AS l_revoked FROM launcher_folders f JOIN launchers l ON l.id = f.launcher_id WHERE l.owner_id = ? AND l.id = ? AND f.folder = ? AND l.revoked_at IS NULL', me.id, target.launcherId, target.folder)
      : await db.get('SELECT r.*, l.id AS l_id, l.name AS l_name, l.last_seen_at AS l_seen, l.revoked_at AS l_revoked FROM launcher_regs r JOIN launchers l ON l.id = r.launcher_id WHERE r.ai_id = ? AND l.owner_id = ? AND l.revoked_at IS NULL ORDER BY r.updated_at DESC LIMIT 1', ai.id, me.id);
    if (!reg) throw new ApiError(409, 'WORKSPACE_CHANGED', '請選擇已登記的電腦與資料夾');
    if (explicit) { reg.tool = target.tool; reg.agent = agentDir(ai); }
    if (!ALLOWED_TOOLS.includes(reg.tool)) throw invalid('請選擇支援的工具');
    await assertToolOn(reg.tool);
    if (isOnline(ai)) {
      const last = await db.get("SELECT launcher_id, folder, window_closed_at FROM launcher_jobs WHERE ai_id = ? AND status IN ('opened','pending') ORDER BY created_at DESC LIMIT 1", ai.id);
      if (!last?.window_closed_at || last.launcher_id !== reg.l_id || last.folder !== reg.folder) throw new ApiError(409, 'AI_ALREADY_ONLINE', '這隻 AI 已在執行');
    }
    const now = Date.now();
    const jobId = randId('ljob');
    if (!isLauncherOnline({ last_seen_at: reg.l_seen, revoked_at: reg.l_revoked }, now)) {
      await db.run(
        'INSERT INTO launcher_jobs (id, owner_id, ai_id, launcher_id, agent, folder, tool, status, detail, created_at, updated_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        jobId, me.id, ai.id, reg.l_id, reg.agent, reg.folder, reg.tool, 'offline', '電腦不在線', now, now, now,
      );
      throw new ApiError(409, 'LAUNCHER_OFFLINE', `「${reg.l_name || '電腦'}」目前離線，無法啟動`, { jobId });
    }

    await expireOldJobs(me.id, now);
    const pending = await db.get("SELECT id FROM launcher_jobs WHERE ai_id = ? AND status = 'pending'", ai.id);
    if (pending) throw new ApiError(409, 'ALREADY_PENDING', '這隻 AI 正在啟動');
    const changes = [[
      "INSERT INTO launcher_jobs (id, owner_id, ai_id, launcher_id, agent, folder, tool, status, detail, created_at, updated_at) SELECT ?,?,?,?,?,?,?,'pending','',?,? WHERE NOT EXISTS (SELECT 1 FROM launcher_jobs WHERE ai_id = ? AND status = 'pending')",
      [jobId, me.id, ai.id, reg.l_id, reg.agent, reg.folder, reg.tool, now, now, ai.id],
    ]];
    if (explicit) {
      changes.push(['DELETE FROM launcher_regs WHERE ai_id = ? AND EXISTS (SELECT 1 FROM launcher_jobs WHERE id = ?)', [ai.id, jobId]],
        ['INSERT INTO launcher_regs (launcher_id, ai_id, agent, folder, tool, updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM launcher_jobs WHERE id = ?)', [reg.l_id, ai.id, reg.agent, reg.folder, reg.tool, now, jobId]]);
    }
    await db.batch(changes);
    if (!await db.get('SELECT id FROM launcher_jobs WHERE id = ?', jobId)) throw new ApiError(409, 'ALREADY_PENDING', '這隻 AI 正在啟動');
    if (live) live.toPeople(['ln:' + reg.l_id], 'launch', { jobId, aiId: ai.id, at: now });
    if (notifyLauncher) notifyLauncher(reg.l_id, jobId, now);

    return {
      job: {
        id: jobId,
        aiId: ai.id,
        launcherId: reg.l_id,
        launcherName: reg.l_name,
        status: 'pending',
        createdAt: new Date(now).toISOString(),
      },
    };
  });

  route('DELETE', '/api/my-ais/:id/launcher', async ({ me, params, ctx }) => {
    requireHuman(me);
    const ai = (await peopleMap(ctx)).get(params.id);
    if (!ai || ai.kind !== 'ai' || ai.owner_id !== me.id) throw new ApiError(404, 'NOT_FOUND', '找不到這隻 AI');
    await db.batch([
      ['DELETE FROM launcher_regs WHERE ai_id = ?', [ai.id]],
      ["UPDATE launcher_jobs SET status = 'refused', finished_at = ?, updated_at = ? WHERE owner_id = ? AND ai_id = ? AND status = 'pending'", [Date.now(), Date.now(), me.id, ai.id]],
    ]);
    return { removed: true };
  });

  route('GET', '/api/launcher/jobs/:id', async ({ me, params }) => {
    requireHuman(me);
    const now = Date.now();
    await expireOldJobs(me.id, now);
    const job = await db.get('SELECT * FROM launcher_jobs WHERE id = ? AND owner_id = ?', params.id, me.id);
    if (!job) throw new ApiError(404, 'NOT_FOUND', '找不到啟動請求');
    return {
      id: job.id,
      aiId: job.ai_id,
      launcherId: job.launcher_id,
      status: job.status,
      detail: safeDetail(job.detail),
      createdAt: new Date(job.created_at).toISOString(),
      finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
    };
  });

  // ---------- 電腦啟動器裝置端點（無人類／AI Token，配對換 lk_ 金鑰） ----------
  route('POST', '/api/launcher/pair', async ({ req, base, ctx }) => {
    const body = await readJson(req);
    const code = String(body.code || '').replace(/\D+/g, '');
    if (!/^\d{6}$/.test(code)) throw invalid('配對碼必須是 6 位數字');
    const name = String(body.name || '').trim().slice(0, 80) || '我的電腦';
    const platform = String(body.platform || '').trim().slice(0, 32);
    const now = Date.now();
    const { ipKey, globalKey, checkLock, rejectCode } = await pairGuard(req, now);
    await checkLock();
    const claim = await db.get(
      `UPDATE launcher_pair_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?
       AND browser_hash = ? AND EXISTS (SELECT 1 FROM launcher_pair_workspaces w WHERE w.secret_hash = launcher_pair_codes.browser_hash AND w.folder = ? AND w.expires_at > ?)
       AND NOT EXISTS (SELECT 1 FROM login_fails WHERE username IN (?, ?) AND locked_until > ?)
       AND (ai_id IS NULL OR EXISTS (SELECT 1 FROM participants p WHERE p.id = launcher_pair_codes.ai_id
         AND p.kind = 'ai' AND p.status = 'active' AND p.owner_id = launcher_pair_codes.owner_id))
       RETURNING owner_id, ai_id, tool`, now, code, now, typeof body.secret === 'string' && body.secret.length === 36 ? await sha256(body.secret) : null, body.workspace || null, now, ipKey, globalKey, now,
    );
    if (!claim) await rejectCode();

    // A returning device proves possession of its existing credential. A hostname alone is not an identity.
    const existing = body.deviceToken ? await db.get(
      'SELECT id, name FROM launchers WHERE owner_id = ? AND token_hash = ? AND revoked_at IS NULL',
      claim.owner_id, await sha256(String(body.deviceToken)),
    ) : null;
    const token = existing ? body.deviceToken : 'lk_' + newToken();
    const id = existing?.id || randId('ln');
    const people = await peopleMap(ctx);
    const owner = people.get(claim.owner_id);
    const ai = people.get(claim.ai_id);
    const stmts = existing ? [[
      'UPDATE launchers SET platform = ?, last_seen_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL',
      [platform, now, id, claim.owner_id],
    ]] : [[
      'INSERT INTO launchers (id, owner_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
      [id, claim.owner_id, name, platform, await sha256(token), now, now],
    ]];
    stmts.push(['INSERT INTO launcher_folders (launcher_id, folder) VALUES (?,?) ON CONFLICT DO NOTHING', [id, body.workspace]]);
    if (ai) {
      stmts.push(['DELETE FROM launcher_regs WHERE ai_id = ?', [ai.id]],
        ['INSERT INTO launcher_regs (launcher_id, ai_id, agent, folder, tool, updated_at) VALUES (?,?,?,?,?,?)', [id, ai.id, agentDir(ai), body.workspace, claim.tool, now]]);
    }
    // Only an AI-specific code from the owner's web session authorizes this
    // first launch. The client still checks its local workspace registration.
    if (ai && ai.owner_id === claim.owner_id && ai.status === 'active' && !isOnline(ai) &&
        typeof body.workspace === 'string' && body.workspace.length > 0 && body.workspace.length <= 500) {
      stmts.push([
        "INSERT INTO launcher_jobs (id, owner_id, ai_id, launcher_id, agent, folder, tool, status, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'pending','',?,?)",
        [randId('ljob'), claim.owner_id, ai.id, id, agentDir(ai), body.workspace, claim.tool, now, now],
      ]);
    }
    await db.batch(stmts);
    return { __status: 201, launcherId: id, token, name: existing?.name || name, aiId: claim.ai_id, tool: claim.tool, ownerName: owner?.name || '', base };
  }, { open: true });

  route('GET', '/api/launcher/me', async ({ req, ctx }) => {
    const ln = await requireLauncher(req);
    const people = await peopleMap(ctx);
    const ais = [...people.values()]
      .filter(p => p.kind === 'ai' && p.owner_id === ln.owner_id && p.status !== 'deleted')
      .map(p => ({ aiId: p.id, name: p.name, agent: agentDir(p), shortCode: p.code, role: p.role, status: p.status }));
    return { id: ln.id, name: ln.name, ownerId: ln.owner_id, ais };
  }, { open: true });

  route('POST', '/api/launcher/folders', async ({ req }) => {
    const ln = await requireLauncher(req);
    const { folder } = await readJson(req);
    if (typeof folder !== 'string' || !folder.trim() || folder.length > 500) throw invalid('資料夾路徑無效');
    await db.run('INSERT INTO launcher_folders (launcher_id, folder) VALUES (?, ?) ON CONFLICT DO NOTHING', ln.id, folder);
    return { folder };
  }, { open: true });

  route('GET', '/api/launcher/poll', async ({ req }) => {
    const ln = await requireLauncher(req);
    const now = Date.now();
    const jobs = await db.all(
      "SELECT id, ai_id, agent, folder, tool, created_at FROM launcher_jobs WHERE launcher_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at ASC LIMIT 10",
      ln.id, now - JOB_MAX_POLL_AGE_MS,
    );
    const transport = await launchTransport();
    return {
      launcherId: ln.id,
      live: !!live,
      jobs: jobs.map(j => ({ id: j.id, action: 'launch', transport, aiId: j.ai_id, agent: j.agent, folder: j.folder, tool: j.tool, createdAt: j.created_at })),
    };
  }, { open: true });

  route('GET', '/api/launcher/events', async ({ req }) => {
    const ln = await requireLauncher(req);
    if (!live) throw new ApiError(404, 'LIVE_DISABLED', '無內建即時通道');
    const r = live.open({ id: 'ln:' + ln.id, kind: 'launcher' }, { signal: req.signal });
    if (r.error) throw new ApiError(503, 'LIVE_FULL', '即時連線數已滿');
    return r.response;
  }, { open: true });

  route('POST', '/api/launcher/jobs/:id/setup', async ({ req, params, base }) => {
    const device = await requireLauncher(req);
    const setupRequest = await readJson(req);
    if (typeof setupRequest.folder !== 'string') throw invalid('資料夾路徑無效');
    // The job was created by the authenticated owner. Claim it atomically, only
    // while the selected registration and both ownership relationships still hold.
    const job = await db.get(
      `UPDATE launcher_jobs SET setup_claimed_at = ?
       WHERE id = ? AND launcher_id = ? AND owner_id = ? AND folder = ? AND status IN ('pending','opened')
         AND setup_claimed_at IS NULL AND created_at > ?
         AND EXISTS (SELECT 1 FROM launcher_regs r WHERE r.launcher_id = launcher_jobs.launcher_id
           AND r.ai_id = launcher_jobs.ai_id AND r.folder = launcher_jobs.folder AND r.tool = launcher_jobs.tool)
         AND EXISTS (SELECT 1 FROM participants p WHERE p.id = launcher_jobs.ai_id
           AND p.owner_id = launcher_jobs.owner_id AND p.kind = 'ai' AND p.status = 'active')
         AND EXISTS (SELECT 1 FROM launchers l WHERE l.id = launcher_jobs.launcher_id AND l.revoked_at IS NULL)
       RETURNING ai_id, owner_id, tool`, Date.now(), params.id, device.id, device.owner_id, setupRequest.folder, Date.now() - 300_000);
    if (!job) throw new ApiError(410, 'SETUP_UNAVAILABLE', '接入授權已失效，請主人重新按啟動');
    const ai = await db.get("SELECT * FROM participants WHERE id = ? AND owner_id = ? AND kind = 'ai' AND status = 'active'", job.ai_id, job.owner_id);
    if (!ai) throw new ApiError(410, 'SETUP_UNAVAILABLE', 'AI 狀態已改變');
    return new Response(await launcherSetupText(ai, base, job.tool, setupRequest.currentToken), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }, { open: true });

  route('POST', '/api/launcher/jobs/:id/closed', async ({ req, params }) => {
    const device = await requireLauncher(req);
    const result = await db.run("UPDATE launcher_jobs SET window_closed_at = COALESCE(window_closed_at, ?) WHERE id = ? AND launcher_id = ? AND status = 'opened'", Date.now(), params.id, device.id);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND', '找不到已開啟的視窗');
    return { closed: true };
  }, { open: true });

  route('POST', '/api/launcher/jobs/:id/ack', async ({ req, params }) => {
    const ln = await requireLauncher(req);
    const body = await readJson(req);
    const job = await db.get('SELECT * FROM launcher_jobs WHERE id = ? AND launcher_id = ?', params.id, ln.id);
    if (!job) throw new ApiError(404, 'NOT_FOUND', '找不到啟動請求');
    const st = body.status === 'opened' ? 'opened' : body.status === 'refused' ? 'refused' : null;
    if (!st) throw invalid('status 必須是 opened 或 refused');
    const detail = safeDetail(body.detail);
    const now = Date.now();
    await db.run(
      "UPDATE launcher_jobs SET status = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ? AND launcher_id = ? AND status = 'pending'",
      st, detail, now, now, job.id, ln.id,
    );
    return { ok: true, id: job.id, status: st };
  }, { open: true });

  return {
    cleanupAi: aiId => db.run('DELETE FROM launcher_regs WHERE ai_id = ?', aiId),
    revokeOwner: (ownerId, now = Date.now()) => db.run('UPDATE launchers SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL', now, ownerId),
  };
}
