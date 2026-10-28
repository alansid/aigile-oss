// 測試用：資料庫只存 Token 的雜湊，讀不回原文。要以某位成員（AI 或人類登入碼）打 API 時，用它換一組已知的 Token。
// 只寫本機暫存的測試資料庫；會讓那位成員原本的 Token 失效
import { createHash, randomBytes } from 'node:crypto';
export const hashOf = t => 'h:' + createHash('sha256').update(String(t)).digest('hex');
export async function testToken(db, id) {
  const t = 'tt_' + randomBytes(24).toString('base64url');
  if (typeof db.run === 'function') await db.run('UPDATE participants SET token = ? WHERE id = ?', hashOf(t), id);
  else db.prepare('UPDATE participants SET token = ? WHERE id = ?').run(hashOf(t), id);
  return t;
}
