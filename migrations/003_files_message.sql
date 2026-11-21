-- 一則訊息掛多個檔：讀訊息時用 files.message_id 找同一則的全部檔案，加索引避免整表掃描
-- 只加索引、不改資料：舊版程式照常能跑；沒加索引新版也能跑，只是讀附檔訊息比較慢
CREATE INDEX IF NOT EXISTS idx_files_message ON files (message_id);
