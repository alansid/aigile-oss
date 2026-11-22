-- 知識庫改成自己挑文件放進去：docs 加 in_kb（1＝在知識庫：抽字、整理、被搜；0＝一般專案文件：只存原檔）
-- 舊資料：有知識頁引用、或排在整理卡裡的文件標 in_kb = 1；其他的抽字段落刪掉、抽字狀態清空（之後加入知識庫會重抽）
ALTER TABLE docs ADD COLUMN in_kb INTEGER NOT NULL DEFAULT 0;
UPDATE docs SET in_kb = 1 WHERE deleted_at IS NULL AND (kb_org = 'todo' OR EXISTS (SELECT 1 FROM kb_pages p WHERE p.project = docs.project AND p.deleted_at IS NULL AND p.sources LIKE '%"' || docs.id || '"%'));
DELETE FROM kb_chunks WHERE doc_id NOT IN (SELECT id FROM docs WHERE in_kb = 1);
UPDATE docs SET kb_status = NULL, kb_chunks = 0, kb_chars = 0, kb_truncated = 0, kb_at = NULL WHERE in_kb = 0;
