// AI 發文的格式檢查。只擋 AI 一看就會改的錯（回 400 附正確範例），判斷模糊的只警告。
// 同一位作者、同一草稿（同 requestId 或第一行相同）最多擋 2 次，第 3 次照送並在 warnings 說明。
import { optionWarnings } from './questions.js';
export const TAGS = ['接單', '進度', '完成', '需確認', '受阻', '交接', '通知', '回覆', '決策紀錄', '簽到', 'AI 簽到', '文件', '退回', '回報', '已 push', '已發布', '已部署'];
export const MAX_BLOCKS = 2;
const TAG_LIST = '[接單]、[進度]、[完成]、[需確認]、[受阻]、[交接]、[通知]、[回覆]、[決策紀錄]';
const NOT_SENT = `這則沒有送出，請照範例改好再發。`;

function dist1(a, b) { // 兩字串的編輯距離是否 ≤1（差一個字、多一個字或少一個字）
  const A = [...a], B = [...b];
  if (Math.abs(A.length - B.length) > 1) return false;
  let i = 0; while (i < A.length && i < B.length && A[i] === B[i]) i++;
  if (A.length === B.length) return A.slice(i + 1).join('') === B.slice(i + 1).join('');
  const [L, S] = A.length > B.length ? [A, B] : [B, A];
  return L.slice(i + 1).join('') === S.slice(i).join('');
}
const known = tag => TAGS.includes(tag) || /^進度[^\]\n]{0,6}$/.test(tag);

const OPTION_EXAMPLE = '範例（中間不空行、不加粗、不加項目符號）：\n問題1：要不要今天上線？\n選項：\nA. 今天上線\nB. 明天再上';

// 回 { blocks: [擋下的原因（含範例）], warnings: [只提醒的] }
export function formatProblems(text, { replyFrom } = {}) {
  const blocks = [], warnings = [];
  // PO msg_bZlNJxxk7GH2vWp7 選 A：只擋有 A./B. 條列卻變不成按鈕的 [需確認]；完全沒選項的（等人做事）照舊放行
  // 某一題沒解析到選項（可能是開放題）判斷模糊，照舊只警告（core 那邊的 optionWarnings）
  if (optionWarnings(text).some(w => w.includes('沒有變成按鈕'))) blocks.push(`這則 [需確認] 有 A./B. 選項，但沒有變成按鈕：每題用「問題N：」開頭，下一行寫「選項：」，再緊接 2～6 行 A.～F.。${OPTION_EXAMPLE}`);
  if (Array.isArray(replyFrom) && new Set(replyFrom).size > 1) {
    blocks.push('replyFrom 一則最多一位：要多位接著動手就分開發，每則 replyFrom 只放一位，其他人放 recipientIds 當知會。範例：{"recipientIds":["p_甲","p_乙"],"replyFrom":["p_甲"]}');
  }
  const tag = /^\s*\[([^\]\n]{1,12})\]/.exec(String(text))?.[1];
  if (tag && !known(tag)) {
    const near = TAGS.find(t => dist1(tag, t));
    if (near) blocks.push(`開頭標籤 [${tag}] 不在清單，是要寫 [${near}] 嗎？範例：「[${near}] 一句白話結論」。可用：${TAG_LIST}。`);
    else warnings.push(`開頭標籤 [${tag}] 不在清單，團隊狀態判斷不出你在做什麼；可用：${TAG_LIST}。`);
  }
  return { blocks, warnings };
}

// 記同一草稿被擋幾次（30 分鐘後重算）；第一行去掉標籤後相同、或 requestId 相同＝同一草稿
const headOf = text => String(text).trimStart().split('\n')[0].replace(/^\[[^\]\n]*\]\s*/, '').slice(0, 40);
// 純函式：拿某作者最近被擋的草稿清單，算這次是第幾次被擋（1、2），超過上限回 0＝照送；回新的清單給呼叫端存
export function bumpBlock(list, requestId, text, now = Date.now(), ttlMs = 30 * 60_000) {
  list = (Array.isArray(list) ? list : []).filter(x => now - x.at < ttlMs);
  const head = headOf(text);
  let e = list.find(x => x.rid === requestId || (head && x.head === head));
  if (!e) { e = { rid: requestId, head, at: now, n: 0 }; list.push(e); }
  Object.assign(e, { rid: requestId, head, at: now });
  const n = e.n >= MAX_BLOCKS ? 0 : ++e.n;
  return { n, list: list.slice(-20) };
}
// 記憶體版（測試用）
export function makeBlockCounter(ttlMs = 30 * 60_000) {
  const seen = new Map(); // authorId → [{ rid, head, at, n }]
  return {
    hit(authorId, requestId, text, now = Date.now()) {
      const r = bumpBlock(seen.get(authorId), requestId, text, now, ttlMs);
      seen.set(authorId, r.list);
      return r.n;
    },
  };
}
// 存 D1（app_settings 的 postblock:<作者>），Worker 開多個執行個體也共用同一份次數，第 3 次一定照送
export function dbBlockCounter(db, ttlMs = 30 * 60_000) {
  return {
    async hit(authorId, requestId, text, now = Date.now()) {
      const key = `postblock:${authorId}`;
      let list = []; try { list = JSON.parse((await db.get('SELECT value FROM app_settings WHERE key = ?', key))?.value || '[]'); } catch {}
      const r = bumpBlock(list, requestId, text, now, ttlMs);
      await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(r.list));
      return r.n;
    },
  };
}
export const blockMessage = blocks => `${blocks.join('\n')}\n${NOT_SENT}`;
export const passWarning = blocks => `格式問題已擋過 ${MAX_BLOCKS} 次，這次照送；下次注意：${blocks.join(' ')}`;
