-- 群組管理員改成明確標記（原本是「最早加入的人類」）：加欄位，並把現在的管理員標起來
-- 登入碼／AI Token 改存雜湊不在這裡：SQL 算不了 SHA-256，由程式啟動後第一個請求轉（src/core.js hashOldTokens）
ALTER TABLE participants ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE participants SET is_admin = 1 WHERE id = (SELECT id FROM participants WHERE kind = 'human' AND status = 'active' ORDER BY created_at, id LIMIT 1);
