-- 知識庫底層：文件抽出來的純文字分段（可重建：刪掉後按「補建索引」重抽）
-- docs 加抽字狀態：kb_status（pending 抽字中／indexed 已抽字／original 只有原檔／secret 含疑似密鑰未建索引／failed 抽字失敗／full 全站字數已滿；空＝舊文件還沒建）
-- 只加表與欄位：舊版程式照常能跑
CREATE TABLE IF NOT EXISTS kb_chunks (id TEXT PRIMARY KEY, project TEXT NOT NULL, doc_id TEXT NOT NULL, idx INTEGER NOT NULL, section TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, doc_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kb_chunks ON kb_chunks (project, doc_id, idx);
ALTER TABLE docs ADD COLUMN kb_status TEXT;
ALTER TABLE docs ADD COLUMN kb_chunks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE docs ADD COLUMN kb_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE docs ADD COLUMN kb_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE docs ADD COLUMN kb_at TEXT;
