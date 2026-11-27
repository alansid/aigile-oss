-- 模型設定改成各專案自己設定：記下每組屬於哪個專案。空字串＝舊版的全站設定（伺服器第一次用到時搬到有雲端 AI 在用的專案，沒人用的留著請管理員重貼）
ALTER TABLE model_connections ADD COLUMN project TEXT NOT NULL DEFAULT '';
