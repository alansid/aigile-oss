// 專案級卡片範本與檢核（存於 app_settings 的 card_templates:<project>，不改資料表）
export const TEMPLATE_TYPES = ['工作', '阻塞', '決策'];
export const CHECK_RULES = ['none', 'not_empty', 'min_chars', 'min_steps', 'not_same_as'];

export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin_bug',
    builtin: true,
    name: '🐞 Bug 回報',
    type: '工作',
    titlePrefix: '[Bug] ',
    reason: '重現步驟：\n1. \n預期：\n實際：\n環境：',
    criteria: '照重現步驟做不再出錯\n補一個測試',
    enabled: true,
    usedCount: 0,
    checks: [
      { field: 'reason', section: '重現步驟', rule: 'min_steps', value: 2 },
      { field: 'reason', section: '預期', rule: 'not_empty' },
      { field: 'reason', section: '實際', rule: 'not_same_as', value: '預期', notEmpty: true },
      { field: 'reason', section: '環境', rule: 'not_empty' },
      { field: 'criteria', section: '', rule: 'none' },
    ],
  },
  {
    id: 'builtin_feature',
    builtin: true,
    name: '✨ 功能',
    type: '工作',
    titlePrefix: '',
    reason: '要解決的問題：\n誰會用：',
    criteria: '驗收條件：\n1. ',
    enabled: true,
    usedCount: 0,
    checks: [
      { field: 'reason', section: '要解決的問題', rule: 'min_chars', value: 10 },
      { field: 'reason', section: '誰會用', rule: 'not_empty' },
      { field: 'criteria', section: '驗收條件', rule: 'min_steps', value: 1 },
    ],
  },
];

// 中英文內建段落名稱對照（開源版英文介面帶入英文預填文字時也能對上同一個檢核）
const SECTION_ALIASES = {
  '重現步驟': ['重現步驟', 'steps to reproduce'],
  '預期': ['預期', 'expected'],
  '實際': ['實際', 'actual'],
  '環境': ['環境', 'environment'],
  '要解決的問題': ['要解決的問題', 'problem to solve'],
  '誰會用': ['誰會用', 'who uses it'],
  '驗收條件': ['驗收條件', 'acceptance criteria'],
};

const BUILTIN_NAME_ALIASES = {
  builtin_bug: ['🐞 bug 回報', 'bug 回報', '🐞 bug report', 'bug report', 'bug'],
  builtin_feature: ['✨ 功能', '功能', '✨ feature', 'feature'],
};

const clone = v => JSON.parse(JSON.stringify(v));
const stripEmoji = s => String(s || '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim().toLowerCase();

// 從預填或卡片文字切出「XXX：」段落；沒有冒號段落時視為整欄（name: ''）
export function parseTemplateSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([^：:\n]{1,30})[：:]\s*(.*)$/.exec(lines[i]);
    if (m && !/^\d+$/.test(m[1].trim())) {
      cur = { name: m[1].trim(), lineIndex: i, lines: [m[2]] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(lines[i]);
    }
  }
  if (!sections.length) {
    return [{ name: '', lineIndex: 0, content: String(text || '').trim() }];
  }
  return sections.map(s => ({
    name: s.name,
    lineIndex: s.lineIndex,
    content: s.lines.join('\n').trim(),
  }));
}

function findSection(sections, targetName) {
  if (!targetName) return sections[0] || { name: '', lineIndex: 0, content: '' };
  const lower = targetName.trim().toLowerCase();
  const aliases = SECTION_ALIASES[targetName] || [lower];
  return sections.find(s => {
    const sn = s.name.trim().toLowerCase();
    return sn === lower || aliases.includes(sn);
  }) || null;
}

function cleanMeaningfulText(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:\d+\s*[.、)）]|[-*•])\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function countSteps(content) {
  return String(content || '')
    .split(/\r?\n/)
    .filter(l => /^\s*(?:\d+\s*[.、)）]|[-*•])\s*\S/.test(l))
    .length;
}

const EN_BUILTIN_TEXT = {
  builtin_bug: {
    reason: 'Steps to reproduce:\n1. \nExpected:\nActual:\nEnvironment:',
    criteria: 'Following the steps no longer fails\nAdd a test',
  },
  builtin_feature: {
    reason: 'Problem to solve:\nWho uses it:',
    criteria: 'Acceptance criteria:\n1. ',
  },
};

// 建卡自動提醒：不讀已存 checks 設定；檢查標題前綴後至少 5 字，以及範本預填的每一段（含整欄）是否空白或仍是範本提示字
export function evaluateTemplateChecks(tpl, { title = '', reason = '', criteria = '' } = {}) {
  const items = [];
  const prefix = String(tpl.titlePrefix || '');
  let afterPrefix = String(title || '').trim();
  if (prefix && afterPrefix.startsWith(prefix.trim())) {
    afterPrefix = afterPrefix.slice(prefix.trim().length).trim();
  }
  const titleOk = afterPrefix.length >= 5;
  items.push({
    key: 'title',
    field: 'title',
    section: '標題',
    ok: titleOk,
    kind: titleOk ? 'ok' : 'title_short',
    label: titleOk ? '標題前綴後有寫內容' : '標題（前綴後至少 5 個字）',
    detail: '標題（前綴後至少 5 個字）',
    lineIndex: 0,
  });

  const userVals = { reason, criteria };
  const enRef = EN_BUILTIN_TEXT[tpl.id] || null;
  for (const field of ['reason', 'criteria']) {
    const tplRaw = String(tpl[field] || '');
    if (!tplRaw.trim()) continue;
    const tplSecs = parseTemplateSections(tplRaw);
    const enSecs = enRef ? parseTemplateSections(enRef[field]) : null;
    const userSecs = parseTemplateSections(userVals[field]);
    for (let idx = 0; idx < tplSecs.length; idx++) {
      const ts = tplSecs[idx];
      const secName = String(ts.name || '').trim();
      const displayName = secName || (field === 'criteria' ? '完成條件' : '原因');
      const uSec = findSection(userSecs, secName);
      const uRaw = uSec ? uSec.content : '';
      const uClean = cleanMeaningfulText(uRaw);
      const tClean = cleanMeaningfulText(ts.content);
      const enClean = enSecs?.[idx] ? cleanMeaningfulText(enSecs[idx].content) : '';
      const lineIndex = uSec ? uSec.lineIndex : 0;

      let kind = 'ok';
      if (!uClean) {
        kind = 'empty';
      } else if (secName && ((tClean && uClean === tClean) || (enClean && uClean === enClean))) {
        kind = 'hint';
      }
      const ok = kind === 'ok';
      const why = kind === 'empty' ? '空白' : kind === 'hint' ? '還是範本提示字' : '';
      items.push({
        key: `${field}:${displayName}`,
        field,
        section: displayName,
        ok,
        kind,
        lineIndex,
        label: ok ? `${displayName}已填寫` : `${displayName}（${why}）`,
        detail: ok ? `${displayName}已填寫` : `${displayName}（${why}）`,
      });
    }
  }
  const passed = items.filter(i => i.ok).length;
  const failed = items.filter(i => !i.ok);
  return { passed, total: items.length, items, failed };
}

export function normalizeChecks(checks, invalid) {
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) throw invalid('checks 需為陣列');
  if (checks.length > 30) throw invalid('檢核項目最多 30 個');
  return checks.map(c => {
    const field = c?.field === 'criteria' ? 'criteria' : 'reason';
    const section = String(c?.section || '').trim().slice(0, 30);
    const rule = CHECK_RULES.includes(c?.rule) ? c.rule : 'none';
    const out = { field, section, rule };
    if (rule === 'min_chars' || rule === 'min_steps') {
      const n = Number(c?.value);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw invalid(`${section || field} 的檢核數值需為 1～500 的整數`);
      out.value = n;
    } else if (rule === 'not_same_as') {
      const target = String(c?.value || '').trim().slice(0, 30);
      if (!target) throw invalid(`${section || field} 的「不能跟某段一樣」需指定比較段落`);
      out.value = target;
      out.notEmpty = c?.notEmpty !== false;
    }
    return out;
  });
}

export function mergeWithBuiltins(saved) {
  const list = Array.isArray(saved) ? saved : [];
  const byId = new Map(list.map(t => [t.id, t]));
  const out = [];
  for (const b of BUILTIN_TEMPLATES) {
    const ov = byId.get(b.id);
    if (ov) {
      out.push({ ...clone(b), ...clone(ov), id: b.id, builtin: true });
      byId.delete(b.id);
    } else {
      out.push(clone(b));
    }
  }
  for (const custom of byId.values()) {
    if (custom && custom.id && custom.name) out.push({ ...clone(custom), builtin: false });
  }
  return out;
}

export function findTemplate(templates, query, { includeDisabled = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const pool = includeDisabled ? templates : templates.filter(t => t.enabled !== false);
  const byId = pool.find(t => t.id === q);
  if (byId) return byId;
  const ql = q.toLowerCase();
  const qPlain = stripEmoji(q);
  const exact = pool.find(t => t.name.trim().toLowerCase() === ql || stripEmoji(t.name) === qPlain);
  if (exact) return exact;
  for (const t of pool) {
    const aliases = BUILTIN_NAME_ALIASES[t.id];
    if (aliases && (aliases.includes(ql) || aliases.includes(qPlain))) return t;
  }
  return null;
}

export function registerCardTemplates({ route, ApiError, invalid, readJson, randId, nowIso, PROJECTS, projectsOf, isManager, getJson, setJson }) {
  const keyOf = pj => 'card_templates:' + pj;
  const loadTemplates = async pj => mergeWithBuiltins(await getJson(keyOf(pj)));
  const saveTemplates = async (pj, list) => setJson(keyOf(pj), list);
  const assertProject = (me, pj) => {
    if (!PROJECTS.includes(pj)) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案');
    if (!projectsOf(me).includes(pj)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案');
  };
  const assertManager = async (ctx, me, pj) => {
    assertProject(me, pj);
    if (!(await isManager(ctx, me, pj))) throw new ApiError(403, 'FORBIDDEN', '只有管理員或這個專案的 leader 可以管理卡片範本');
  };

  route('GET', '/api/projects/:id/card-templates', async ({ ctx, me, params }) => {
    const pj = decodeURIComponent(params.id);
    assertProject(me, pj);
    const templates = await loadTemplates(pj);
    return { project: pj, canEdit: await isManager(ctx, me, pj), templates };
  });

  route('POST', '/api/projects/:id/card-templates', async ({ ctx, me, params, req }) => {
    const pj = decodeURIComponent(params.id);
    await assertManager(ctx, me, pj);
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) throw invalid('範本名稱為必填，最多 40 字');
    const type = body.type ?? '工作';
    if (!TEMPLATE_TYPES.includes(type)) throw invalid(`預設類型只能是 ${TEMPLATE_TYPES.join('、')}`);
    const titlePrefix = typeof body.titlePrefix === 'string' ? body.titlePrefix.slice(0, 30) : '';
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
    const criteria = typeof body.criteria === 'string' ? body.criteria.slice(0, 500) : '';
    const checks = normalizeChecks(body.checks, invalid);
    const list = await loadTemplates(pj);
    if (list.length >= 20) throw invalid('每個專案最多 20 個卡片範本');
    if (list.some(t => t.name.trim().toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'DUPLICATE_NAME', '這個專案已有同名範本');
    const tpl = {
      id: randId('tpl', 10),
      builtin: false,
      name,
      type,
      titlePrefix,
      reason,
      criteria,
      enabled: true,
      usedCount: 0,
      createdBy: me.id,
      createdByName: me.name,
      createdAt: nowIso(),
      checks,
    };
    list.push(tpl);
    await saveTemplates(pj, list);
    return { __status: 201, template: tpl, templates: list };
  });

  route('PATCH', '/api/projects/:id/card-templates/:tplId', async ({ ctx, me, params, req }) => {
    const pj = decodeURIComponent(params.id);
    await assertManager(ctx, me, pj);
    const body = await readJson(req);
    const list = await loadTemplates(pj);
    const idx = list.findIndex(t => t.id === params.tplId);
    if (idx < 0) throw new ApiError(404, 'NOT_FOUND', '找不到這個卡片範本');
    const cur = { ...list[idx] };
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 40) throw invalid('範本名稱為必填，最多 40 字');
      if (list.some((t, i) => i !== idx && t.name.trim().toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'DUPLICATE_NAME', '這個專案已有同名範本');
      cur.name = name;
    }
    if (body.type !== undefined) {
      if (!TEMPLATE_TYPES.includes(body.type)) throw invalid(`預設類型只能是 ${TEMPLATE_TYPES.join('、')}`);
      cur.type = body.type;
    }
    if (body.titlePrefix !== undefined) cur.titlePrefix = typeof body.titlePrefix === 'string' ? body.titlePrefix.slice(0, 30) : '';
    if (body.reason !== undefined) cur.reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
    if (body.criteria !== undefined) cur.criteria = typeof body.criteria === 'string' ? body.criteria.slice(0, 500) : '';
    if (body.enabled !== undefined) cur.enabled = !!body.enabled;
    if (body.checks !== undefined) cur.checks = normalizeChecks(body.checks, invalid);
    cur.updatedAt = nowIso();
    list[idx] = cur;
    await saveTemplates(pj, list);
    return { template: cur, templates: list };
  });

  route('POST', '/api/projects/:id/card-templates/:tplId/restore', async ({ ctx, me, params }) => {
    const pj = decodeURIComponent(params.id);
    await assertManager(ctx, me, pj);
    const base = BUILTIN_TEMPLATES.find(b => b.id === params.tplId);
    if (!base) throw invalid('只有內建範本可以回復預設');
    const list = await loadTemplates(pj);
    const idx = list.findIndex(t => t.id === params.tplId);
    const usedCount = idx >= 0 ? (list[idx].usedCount || 0) : 0;
    const restored = { ...clone(base), usedCount };
    if (idx >= 0) list[idx] = restored; else list.unshift(restored);
    await saveTemplates(pj, list);
    return { template: restored, templates: list };
  });

  route('DELETE', '/api/projects/:id/card-templates/:tplId', async ({ ctx, me, params }) => {
    const pj = decodeURIComponent(params.id);
    await assertManager(ctx, me, pj);
    const list = await loadTemplates(pj);
    const idx = list.findIndex(t => t.id === params.tplId);
    if (idx < 0) throw new ApiError(404, 'NOT_FOUND', '找不到這個卡片範本');
    if (list[idx].builtin) throw new ApiError(409, 'BUILTIN_TEMPLATE', '內建範本不能刪除，可以停用或修改內容');
    if (list[idx].enabled !== false) throw new ApiError(409, 'TEMPLATE_ENABLED', '請先停用這個範本再刪除');
    list.splice(idx, 1);
    await saveTemplates(pj, list);
    return { ok: true, templates: list };
  });

  async function resolveForCardCreate(pj, query) {
    const list = await loadTemplates(pj);
    const tpl = findTemplate(list, query);
    return { tpl, list };
  }

  async function bumpUsed(pj, tplId) {
    const list = await loadTemplates(pj);
    const idx = list.findIndex(t => t.id === tplId);
    if (idx < 0) return;
    list[idx] = { ...list[idx], usedCount: (list[idx].usedCount || 0) + 1 };
    await saveTemplates(pj, list);
  }

  return { loadTemplates, resolveForCardCreate, bumpUsed, evaluateTemplateChecks };
}
