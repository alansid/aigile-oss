-- 訊息引用專案文件區的檔（JSON 陣列的 docId，最多 4 個）。不另存檔，文件區刪了就顯示「已刪除」
ALTER TABLE messages ADD COLUMN doc_ids TEXT;
