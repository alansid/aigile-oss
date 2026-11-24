// 解析訊息內文中的 @名字·短代碼 與 @名字
// - @名字·短代碼：精確指定該成員（coded）
// - @名字（沒有 ·短代碼）：若在範圍內只有 1 位，算明確指定；若 >= 2 位同名，列為 ambiguous，不猜測也不誤喚醒
export function parseMentions(text, members, { selfId = null } = {}) {
  text = String(text || '');
  if (!text.includes('@')) return { resolvedIds: [], codedIds: [], ambiguous: [] };
  const list = [...members].filter(Boolean);
  let scan = text;
  const hits = [];      // { at, id, member, coded }
  const codedIds = [];  // 以 @名字·短代碼 明確點名者
  const ambiguous = []; // { at, name, candidates }

  const scanLower = () => scan.toLowerCase();
  const byLen = [...list].filter(p => p.name).sort((a, b) => b.name.length - a.name.length);

  // 1. 先比對 @名字·短代碼
  for (const p of byLen) {
    const code = String(p.shortCode || p.code || '').trim();
    const id = p.participantId || p.id;
    if (!code || !id) continue;
    const tag = '@' + p.name + '·' + code;
    const tagL = tag.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = scanLower().indexOf(tagL, from);
      if (idx < 0) break;
      const next = scan[idx + tag.length] || '';
      if (/[A-Za-z0-9]/.test(next)) { from = idx + tag.length; continue; }
      hits.push({ at: idx, id, member: p, coded: true });
      if (id !== selfId) codedIds.push(id);
      scan = scan.slice(0, idx) + ' '.repeat(tag.length) + scan.slice(idx + tag.length);
      from = idx + tag.length;
    }
  }

  // 2. 再比對沒帶 ·短代碼 的 @名字
  const groups = new Map();
  for (const p of list) {
    if (!p.name) continue;
    const k = p.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const k of [...groups.keys()].sort((a, b) => b.length - a.length)) {
    const cands = groups.get(k);
    const name = cands[0].name;
    const tag = '@' + name;
    const tagL = tag.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = scanLower().indexOf(tagL, from);
      if (idx < 0) break;
      const next = scan[idx + tag.length] || '';
      if (next === '·') { from = idx + tag.length; continue; }
      scan = scan.slice(0, idx) + ' '.repeat(tag.length) + scan.slice(idx + tag.length);
      if (cands.length >= 2) {
        if (!ambiguous.some(a => a.name.toLowerCase() === k)) {
          ambiguous.push({ at: idx, name, candidates: cands });
        }
      } else {
        const p = cands[0];
        hits.push({ at: idx, id: p.participantId || p.id, member: p, coded: false });
      }
      from = idx + tag.length;
    }
  }

  const ordered = hits.sort((a, b) => a.at - b.at);
  return {
    resolvedIds: [...new Set(ordered.filter(h => h.id && h.id !== selfId).map(h => h.id))],
    codedIds: [...new Set(codedIds)],
    ambiguous: ambiguous.sort((a, b) => a.at - b.at),
  };
}
