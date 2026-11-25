// [決策紀錄]／[回覆] 正文點名某位成員要他動手（例「PG：請交接給 QA」），卻沒用 replyFrom 指定他
// → 他不會被叫醒（11/16 實測卡了 8 分鐘要人解卡）。發文照樣送出，只在回應 warnings 提醒（不擋）。
// 純函式，wake-hint-test 直接測。
export const ACT_PREFIX = /^\s*(?:\[[^\]\n]{0,12}\]\s*)*\[(決策紀錄|回覆)\]/;
const ACT = '(?:請|麻煩|交接|接手|接著|動手|開始|負責|處理|修|改|驗|跑|做|補|發)';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 英數代號（PG、QA、RVVW、PG_RVVW）前後不能黏著英數字，避免 PGX、APP 之類誤判
const word = s => /^[\w-]+$/.test(s) ? `(?<![A-Za-z0-9_])${esc(s)}(?![A-Za-z0-9])` : esc(s);
// 成員可以被怎麼稱呼：名字、代號、角色代號、角色代號_代號、角色名稱
export function labelsOf(m) {
  const out = new Set([m.name, m.code, m.roleKey, m.roleKey && m.code ? `${m.roleKey}_${m.code}` : '', m.role].map(s => String(s || '').trim()).filter(s => s.length >= 2));
  return [...out].sort((a, b) => b.length - a.length);
}
// 這一行有沒有點名 label 要他動手：「PG：請…」「請 PG …」「@PG …請…」
function calls(line, label) {
  const L = word(label);
  return new RegExp(`(?:^|[\\s，。；、(（\\-•*>])@?${L}\\s*[：:]\\s*\\S*?${ACT}`).test(line)
    || new RegExp(`(?:請|麻煩)\\s*@?${L}`).test(line)
    || new RegExp(`@${L}[^\\n]*?${ACT}`).test(line);
}
export function handoffWarning(text, rawAsk, people, senderId, projectMembers) {
  if (!/^\s*\[交接\]/.test(text)) return [];
  const asksHuman = rawAsk?.some(id => people.get(id)?.kind === 'human');
  const mentionsAI = !rawAsk?.length && text.includes('@') && projectMembers.some(p =>
    p.kind === 'ai' && p.status === 'active' && p.id !== senderId &&
    labelsOf({ ...p, roleKey: p.role_key }).some(label =>
      new RegExp('(?:^|[^A-Za-z0-9_])@' + esc(label) + (/[A-Za-z0-9_]$/.test(label) ? '(?![A-Za-z0-9_])' : '')).test(text)));
  return asksHuman || mentionsAI ? ['交接訊息已送出。請在 replyFrom 指定接手的 AI，讓它收到叫醒通知。'] : [];
}
// members：同專案、不含發文者本人的成員 [{ id, name, code, roleKey, role }]；ask：最後要回覆的人（可能 null）
export function wakeHintWarnings(text, members, ask) {
  text = String(text || '');
  if (!ACT_PREFIX.test(text)) return [];
  const asked = new Set(ask || []);
  const lines = text.split('\n'), missed = [];
  for (const m of members) {
    if (asked.has(m.id)) continue;
    if (labelsOf(m).some(l => lines.some(line => calls(line, l)))) missed.push(m);
  }
  if (!missed.length) return [];
  const who = missed.map(m => `${m.name}（${m.id}）`).join('、');
  return [`正文點名 ${who} 要動手，但沒用 replyFrom 指定，對方不會被叫醒。訊息已送出；要他接著做，請再發一則在 recipientIds 和 replyFrom 帶他的 participantId（一則只能一位，多位分開發）。`];
}
