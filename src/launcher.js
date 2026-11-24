// PLAT-436 AI 啟動器：配對碼、已配對電腦、本機白名單同步（唯讀展示）與遠端啟動紀錄／派工
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

export function registerLauncher({ route, db, ApiError, invalid, readJson, randId, newToken, sha256, requireHuman, peopleMap, isOnline, agentDir, live = null, notifyLauncher = null }) {
  const isLauncherOnline = (row, now = Date.now()) => !!row && !row.revoked_at && (row.last_seen_at || 0) > 0 && now - row.last_seen_at < ONLINE_WINDOW_MS;

  async function expireOldJobs(ownerId = null, now = Date.now()) {
    const cutoff = now - JOB_TIMEOUT_MS;
    if (ownerId) {
      await db.run(
        "UPDATE launcher_jobs SET status = 'timeout', detail = '電腦沒回應', updated_at = ?, finished_at = ? WHERE owner_id = ? AND status = 'pending' AND created_at < ?",
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

  async function latestPairCode(ownerId, now = Date.now()) {
    const cur = await db.get('SELECT code, expires_at FROM launcher_pair_codes WHERE owner_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1', ownerId, now);
    if (cur) return { code: cur.code, expiresAt: new Date(cur.expires_at).toISOString() };
    return issuePairCode(ownerId, now);
  }

  async function issuePairCode(ownerId, now = Date.now()) {
    await db.run('DELETE FROM launcher_pair_codes WHERE owner_id = ? OR expires_at < ?', ownerId, now - 86_400_000);
    for (let i = 0; i < 20; i++) {
      const code = randDigits();
      const hit = await db.get('SELECT 1 AS x FROM launcher_pair_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?', code, now);
      if (hit) continue;
      const exp = now + PAIR_TTL_MS;
      await db.run('DELETE FROM launcher_pair_codes WHERE code = ?', code);
      await db.run('INSERT INTO launcher_pair_codes (code, owner_id, created_at, expires_at) VALUES (?,?,?,?)', code, ownerId, now, exp);
      return { code, expiresAt: new Date(exp).toISOString() };
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

    const compMap = new Map(computers.map(c => [c.id, c]));
    const pendingRows = await db.all("SELECT * FROM launcher_jobs WHERE owner_id = ? AND status = 'pending' ORDER BY created_at DESC", me.id);
    const pendingByAi = new Map();
    for (const j of pendingRows) if (!pendingByAi.has(j.ai_id)) pendingByAi.set(j.ai_id, { id: j.id, status: j.status, createdAt: new Date(j.created_at).toISOString() });

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
      detail: j.detail || '',
      createdAt: new Date(j.created_at).toISOString(),
      finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
    }));

    const pairing = await latestPairCode(me.id, now);
    return {
      pairing,
      launchers: computers.map(c => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        online: isLauncherOnline(c, now),
        lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
        createdAt: new Date(c.created_at).toISOString(),
        ais: aisByLauncher.get(c.id) || [],
      })),
      ais,
      logs,
    };
  }

  // ---------- 人類網頁端點 ----------
  route('GET', '/api/launcher', async ({ me, ctx }) => {
    requireHuman(me);
    return launcherStateFor(me, ctx);
  });

  route('POST', '/api/launcher/pair-code', async ({ me }) => {
    requireHuman(me);
    return issuePairCode(me.id, Date.now());
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

  route('POST', '/api/my-ais/:id/launch', async ({ me, params, ctx }) => {
    requireHuman(me);
    const people = await peopleMap(ctx);
    const ai = people.get(params.id);
    if (!ai || ai.kind !== 'ai' || ai.status === 'deleted') throw new ApiError(404, 'NOT_FOUND', '找不到這隻 AI');
    // 安全底線：只有這隻 AI 的主人本人能按「啟動」，管理員也不行
    if (ai.owner_id !== me.id) throw new ApiError(403, 'FORBIDDEN', '只有這隻 AI 的主人能按「啟動」');
    if (ai.status !== 'active') throw new ApiError(409, 'AI_DISABLED', '這隻 AI 已停用，請先重新啟用。');
    if (isOnline(ai)) throw new ApiError(409, 'AI_ALREADY_ONLINE', '這隻 AI 已經在線上，有事會由 watcher 叫醒。');

    const reg = await db.get(
      `SELECT r.*, l.id AS l_id, l.name AS l_name, l.last_seen_at AS l_seen, l.revoked_at AS l_revoked
       FROM launcher_regs r JOIN launchers l ON l.id = r.launcher_id
       WHERE r.ai_id = ? AND l.owner_id = ? AND l.revoked_at IS NULL
       ORDER BY r.updated_at DESC LIMIT 1`,
      ai.id, me.id,
    );
    if (!reg) throw new ApiError(400, 'NOT_REGISTERED', '還沒登記資料夾：請在那台電腦跑 npx aigile-launcher allow 登記');

    const now = Date.now();
    const jobId = randId('ljob');
    if (!isLauncherOnline({ last_seen_at: reg.l_seen, revoked_at: reg.l_revoked }, now)) {
      await db.run(
        'INSERT INTO launcher_jobs (id, owner_id, ai_id, launcher_id, agent, folder, tool, status, detail, created_at, updated_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        jobId, me.id, ai.id, reg.l_id, reg.agent, reg.folder, reg.tool, 'offline', '電腦不在線', now, now, now,
      );
      throw new ApiError(409, 'LAUNCHER_OFFLINE', `「${reg.l_name || '電腦'}」目前離線，無法啟動`, { jobId });
    }

    await db.run(
      'INSERT INTO launcher_jobs (id, owner_id, ai_id, launcher_id, agent, folder, tool, status, detail, created_at, updated_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      jobId, me.id, ai.id, reg.l_id, reg.agent, reg.folder, reg.tool, 'pending', '', now, now, null,
    );
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
      detail: job.detail || '',
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
    const row = await db.get('SELECT * FROM launcher_pair_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?', code, now);
    if (!row) throw new ApiError(400, 'INVALID_PAIR_CODE', '配對碼不存在、已使用或已過期，請在網頁重產一組');
    const claim = await db.run('UPDATE launcher_pair_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?', now, code, now);
    if (!claim.changes) throw new ApiError(400, 'INVALID_PAIR_CODE', '配對碼已被使用');

    const token = 'lk_' + newToken();
    const id = randId('ln');
    await db.run(
      'INSERT INTO launchers (id, owner_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
      id, row.owner_id, name, platform, await sha256(token), now, now,
    );
    const owner = (await peopleMap(ctx)).get(row.owner_id);
    return { __status: 201, launcherId: id, token, name, ownerName: owner?.name || '', base };
  }, { open: true });

  route('GET', '/api/launcher/me', async ({ req, ctx }) => {
    const ln = await requireLauncher(req);
    const people = await peopleMap(ctx);
    const ais = [...people.values()]
      .filter(p => p.kind === 'ai' && p.owner_id === ln.owner_id && p.status !== 'deleted')
      .map(p => ({ aiId: p.id, name: p.name, agent: agentDir(p), shortCode: p.code, role: p.role, status: p.status }));
    return { id: ln.id, name: ln.name, ownerId: ln.owner_id, ais };
  }, { open: true });

  route('PUT', '/api/launcher/registrations', async ({ req, ctx }) => {
    const ln = await requireLauncher(req);
    const body = await readJson(req);
    if (!Array.isArray(body.items)) throw invalid('items 需為陣列');
    if (body.items.length > 50) throw invalid('單台電腦最多同步 50 個登記');
    const people = await peopleMap(ctx);
    const myAis = [...people.values()].filter(p => p.kind === 'ai' && p.owner_id === ln.owner_id && p.status !== 'deleted');
    const byId = new Map(myAis.map(a => [a.id, a]));
    const byAgent = new Map(myAis.map(a => [agentDir(a).toUpperCase(), a]));
    const byCode = new Map(myAis.map(a => [String(a.code || '').toUpperCase(), a]));

    const now = Date.now();
    const stmts = [['DELETE FROM launcher_regs WHERE launcher_id = ?', [ln.id]]];
    const synced = [];
    const seenAi = new Set();
    for (const raw of body.items) {
      const tool = String(raw?.tool || '').trim();
      if (!ALLOWED_TOOLS.includes(tool)) throw invalid(`tool 只能是 ${ALLOWED_TOOLS.join('、')}`);
      const folder = String(raw?.folder || '').trim().slice(0, 500);
      if (!folder) throw invalid('folder 不能空白');
      const key = String(raw?.aiId || raw?.agent || '').trim();
      const ai = byId.get(key) || byAgent.get(key.toUpperCase()) || byCode.get(key.toUpperCase());
      if (!ai) throw new ApiError(404, 'AI_NOT_FOUND', `找不到你名下的 AI「${key}」`);
      if (seenAi.has(ai.id)) continue;
      seenAi.add(ai.id);
      const agent = agentDir(ai);
      stmts.push([
        'INSERT INTO launcher_regs (launcher_id, ai_id, agent, folder, tool, updated_at) VALUES (?,?,?,?,?,?)',
        [ln.id, ai.id, agent, folder, tool, now],
      ]);
      synced.push({ aiId: ai.id, agent, name: ai.name, folder, tool });
    }
    await db.batch(stmts);
    return { synced };
  }, { open: true });

  route('GET', '/api/launcher/poll', async ({ req }) => {
    const ln = await requireLauncher(req);
    const now = Date.now();
    const jobs = await db.all(
      "SELECT id, ai_id, agent, folder, tool, created_at FROM launcher_jobs WHERE launcher_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at ASC LIMIT 10",
      ln.id, now - JOB_MAX_POLL_AGE_MS,
    );
    return {
      launcherId: ln.id,
      live: !!live,
      jobs: jobs.map(j => ({ id: j.id, action: 'launch', aiId: j.ai_id, agent: j.agent, folder: j.folder, tool: j.tool, createdAt: j.created_at })),
    };
  }, { open: true });

  route('GET', '/api/launcher/events', async ({ req }) => {
    const ln = await requireLauncher(req);
    if (!live) throw new ApiError(404, 'LIVE_DISABLED', '無內建即時通道');
    const r = live.open({ id: 'ln:' + ln.id, kind: 'launcher' }, { signal: req.signal });
    if (r.error) throw new ApiError(503, 'LIVE_FULL', '即時連線數已滿');
    return r.response;
  }, { open: true });

  route('POST', '/api/launcher/jobs/:id/ack', async ({ req, params }) => {
    const ln = await requireLauncher(req);
    const body = await readJson(req);
    const job = await db.get('SELECT * FROM launcher_jobs WHERE id = ? AND launcher_id = ?', params.id, ln.id);
    if (!job) throw new ApiError(404, 'NOT_FOUND', '找不到啟動請求');
    const st = body.status === 'opened' ? 'opened' : body.status === 'refused' ? 'refused' : null;
    if (!st) throw invalid('status 必須是 opened 或 refused');
    const detail = String(body.detail || '').trim().slice(0, 200);
    const now = Date.now();
    await db.run(
      'UPDATE launcher_jobs SET status = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ? AND launcher_id = ?',
      st, detail, now, now, job.id, ln.id,
    );
    return { ok: true, id: job.id, status: st };
  }, { open: true });

  return {
    cleanupAi: aiId => db.run('DELETE FROM launcher_regs WHERE ai_id = ?', aiId),
    revokeOwner: (ownerId, now = Date.now()) => db.run('UPDATE launchers SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL', now, ownerId),
  };
}
