const MAX_FILES = 3000;
const MAX_LINES = 500;
const MAX_CONTENT = 2 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;

async function readPage(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return JSON.parse(text + decoder.decode());
    size += value.byteLength;
    if (size > MAX_RESPONSE) {
      await reader.cancel();
      throw new Error('Git 主機回應超過大小上限');
    }
    text += decoder.decode(value, { stream: true });
  }
}

// The origin is fixed. Never forward a project URL, user credentials, or a redirect.
export async function fetchReviewChanges(repo, version, { fetchImpl = fetch, allowContent = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('這是差異指紋，Git 主機需要完整的 commit SHA');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(repo?.url || '');
  if (!match) throw new Error('這個程式庫尚未設定支援的唯讀 Git 連線');
  const slug = match[2].replace(/\.git$/, '');
  if (!slug || slug === '.' || slug === '..') throw new Error('程式庫網址無效');
  const baseUrl = 'https://api.github.com/repos/' + match[1] + '/' + slug + '/commits/' + version;
  const files = [], patches = [];
  const encoder = new TextEncoder();
  const signal = AbortSignal.timeout(15000);
  let byteLimit = false;
  let base = null, remaining = MAX_CONTENT;
  for (let page = 1; page <= 30; page++) {
    const response = await fetchImpl(baseUrl + '?per_page=100&page=' + page, {
      signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Aigile-review' }
    });
    if (!response.ok) throw new Error(response.status === 404 ? '主機找不到這個提交，或目前沒有程式庫讀取權限' : 'Git 主機讀取失敗（HTTP ' + response.status + '）');
    const data = await readPage(response);
    if (data.sha !== version || !Array.isArray(data.files)) throw new Error('Git 主機回傳的版本或檔案清單不符');
    base = data.parents?.[0]?.sha || null;
    for (const f of data.files) {
      if (typeof f.filename !== 'string' || ![f.additions,f.deletions].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Git 主機回傳的統計格式不符');
      const file = { name:f.filename, previousName:f.previous_filename, status:({ added:'A',removed:'D',renamed:'R',modified:'M' })[f.status] || f.status,
        added:f.additions, removed:f.deletions };
      if (typeof f.patch === 'string' && allowContent) {
        const lines = f.patch.split('\n');
        const kept = [];
        for (const line of lines.slice(0, MAX_LINES)) {
          const bytes = encoder.encode(JSON.stringify(line)).length + 1;
          if (bytes > remaining) { byteLimit = true; break; }
          if (bytes > 60000) break;
          remaining -= bytes;
          kept.push(line);
        }
        file.totalLines = lines.length;
        file.truncated = kept.length < lines.length;
        if (kept.length) patches.push({ index: files.length, lines: kept });
      }
      files.push(file);
    }
    const more = /;\s*rel="next"/.test(response.headers.get('link') || '');
    if (!more) return { manifest: { base, version, files, byteLimit, contentAllowed: allowContent }, patches };
    if (files.length >= MAX_FILES) break;
  }
  throw new Error('檔案數超過支援上限');
}

export async function testGitHubRepo(input, branch, fetchImpl = fetch) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(String(input || ''));
  if (!match) throw new Error('請填完整的 GitHub 程式庫網址');
  const slug = match[2].replace(/\.git$/, '');
  if (!slug || slug === '.' || slug === '..') throw new Error('程式庫網址無效');
  const url = 'https://api.github.com/repos/' + match[1] + '/' + slug;
  const opts = { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Aigile-review' } };
  const response = await fetchImpl(url, opts);
  if (!response.ok) throw new Error('無法讀取程式庫，請確認網址與讀取權限（HTTP ' + response.status + '）');
  const repo = await readPage(response);
  const selected = branch || repo.default_branch;
  if (!selected || !repo.full_name) throw new Error('Git 主機未回傳程式庫與分支');
  const result = await fetchImpl(url + '/branches/' + encodeURIComponent(selected), opts);
  if (!result.ok) throw new Error('找不到分支，請檢查設定（HTTP ' + result.status + '）');
  const head = await readPage(result);
  if (!/^[a-f0-9]{40}$/.test(head.commit?.sha || '')) throw new Error('分支沒有可驗證的最新提交');
  return { repository: repo.full_name, branch: selected, sha: head.commit.sha };
}

export function localSnapshot(body, version, origins, content, invalid) {
  if (body.version !== version || !Array.isArray(body.files) || body.files.length > 3000) throw invalid('版本或檔案數不符');
  const files = [], patches = [];
  let size = 0;
  for (const f of body.files) {
    if (!origins.includes(f?.origin) || typeof f.name !== 'string' || !f.name || f.name.length > 2048 ||
        !['A','M','R','D','T'].includes(f.status) || ![f.added,f.removed].every(n=>Number.isSafeInteger(n) && n >= 0)) throw invalid('檔案統計格式不符');
    if (f.lines !== undefined) {
      if (!content || !Array.isArray(f.lines) || f.lines.length > 500) throw invalid('這次送審不接受這份程式差異');
      for (const line of f.lines) {
        if (typeof line !== 'string') throw invalid('差異格式不符');
        const bytes = new TextEncoder().encode(JSON.stringify(line)).length + 1;
        if (bytes > 60000) throw invalid('單行超過大小上限');
        size += bytes;
      }
      if (size > MAX_CONTENT) throw invalid('這次差異超過 2 MB');
      patches.push({ index:files.length, lines:f.lines });
    }
    files.push({ name:f.name, origin:f.origin, status:f.status, added:f.added, removed:f.removed,
      previousName:typeof f.previousName === 'string' ? f.previousName.slice(0,2048) : undefined, binary:f.binary === true, truncated:f.truncated === true, totalLines:Number.isSafeInteger(f.totalLines) ? f.totalLines : undefined });
  }
  const repositories = origins.map(origin => {
    const entry = body.repositories?.find(r => r.origin === origin);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) throw invalid('缺少工作樹指紋');
    return { origin, fingerprint:entry.fingerprint };
  });
  const manifest = { version, repositories, source:'local', byteLimit:body.byteLimit === true, files, contentAllowed:content };
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > 500000) throw invalid('檔案清單超過大小上限');
  return { manifest, patches };
}
