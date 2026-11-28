-- 讀取成本：只加索引，不改資料（雲端 D1 按讀取列數算額度；本機與 PG 也少讀）
-- 每張卡最新的關聯訊息：順著 card_seq＋rowid 從最後關聯的往回找，找到就停（過時提示、看板動靜、看回報）
CREATE INDEX IF NOT EXISTS idx_card_msgs_card ON card_msgs (card_seq);
-- 誰正在做（認領／交接）：只收這兩種紀錄的小索引，含要讀的欄位（不用回表）；條件要跟 src/cards.js 的 CLAIM_VIA_SQL 一字不差
CREATE INDEX IF NOT EXISTS idx_card_log_claims ON card_log (card_seq, at, by_id, via) WHERE via IN ('認領', '交接');
-- 「整理自」：只收「已整理到 …」的紀錄；查詢的 LIKE 條件要跟這裡一字不差
CREATE INDEX IF NOT EXISTS idx_card_log_merged ON card_log (text) WHERE text LIKE '已整理到 %';
-- 文件同名檢查（上傳、知識頁）：原本用 (project, deleted_at) 讀整個專案的文件
CREATE INDEX IF NOT EXISTS idx_docs_name ON docs (project, name);
