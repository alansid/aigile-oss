export function releaseData(version, notes, log = []) {
  const VER = /\(v(\d+\.\d+\.\d+)\)\s*$|^v(\d+\.\d+\.\d+)\b/;
  const CARD = /\b(?:C-\d{3,}|[A-Z]{2,5}-\d+)\b/g; // 新 commit 寫專案卡號；不是卡號的（UTF-8）由 /api/releases 濾掉
  const byVer = new Map();
  let last = null;
  for (const line of log) {
    const [sha, rawAt, subject] = line.split('\x1f');
    const at = new Date(rawAt).toISOString(); // 一律 UTC，才能跟部署時間比較（commit 時間是 +08:00）
    const m = VER.exec(subject);
    const v = m ? (m[1] || m[2]) : last;
    if (!v) continue;
    if (!byVer.has(v)) byVer.set(v, { version: v, at, commits: [], cards: new Set() });
    const r = byVer.get(v);
    r.commits.push({ sha, at, title: subject.replace(VER, '').trim() });
    for (const c of subject.match(CARD) || []) r.cards.add(c);
    if (m) { last = v; r.at = at; } // 版本時間＝帶版本號的那個 commit
  }
  // 發行說明寫的版本：git 沒有的補上（時間、標題照寫的）
  for (const n of notes.releases) if (!byVer.has(n.version)) byVer.set(n.version, { version: n.version, at: new Date(n.at).toISOString(), commits: n.title ? [{ sha: '', at: new Date(n.at).toISOString(), title: n.title }] : [], cards: new Set() });
  const items = [...byVer.values()].map(r => ({
    version: r.version,
    deployedAt: notes.deployed[r.version] || null, // 有記到部署時間就用；沒有就看 commit 時間（通常幾分鐘內就部署）
    at: notes.deployed[r.version] || r.at,
    cards: [...r.cards],
    commits: r.commits,
    causes: notes.incidents.filter(i => i.causeVersion === r.version).map(i => ({ fix: i.fix, fixVersion: i.fixVersion, note: i.note })),
    fixes: notes.incidents.filter(i => i.fixVersion === r.version).map(i => ({ cause: i.cause, causeVersion: i.causeVersion, note: i.note, flow: i.flow })),
  })).sort((a, b) => b.at.localeCompare(a.at));
  return { generatedAt: new Date().toISOString(), current: version, incidents: notes.incidents, items };
}
