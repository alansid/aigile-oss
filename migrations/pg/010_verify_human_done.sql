-- 人自己完成、還沒驗收的舊卡補成已驗收（驗收人＝完成的人、驗收時間＝完成時間），跟 cards.js「人類完成即驗收」一致。
-- 那條規則之前完成的卡沒補到，伺服器擋「完成者不能自己驗」、畫面也不給按鈕，就永遠卡在待驗收。
-- 補到的列同時更新 updated_at、version，已開著的畫面和 AI 用增量同步（updated_at > 游標）才拿得到；重跑不會再改（只挑 verified_by 還是空的）。
-- 只動資料，不改結構；決策卡、AI 完成的卡照舊要別人驗。這是 PostgreSQL 版（時間函式不同），內容跟 migrations/010_verify_human_done.sql 一樣。
UPDATE cards SET verified_by = done_by, verified_at = done_at, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), version = version + 1
WHERE status = '已完成' AND verified_by IS NULL AND done_by IS NOT NULL AND type != '決策'
  AND done_by IN (SELECT id FROM participants WHERE kind = 'human');
