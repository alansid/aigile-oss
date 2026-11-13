-- 叫醒次數：等待腳本每次叫醒 AI 的結束、watcher 每次真的執行喚醒指令，呼叫 POST /api/me/wake 記一次
-- 只存次數與時間，不存內容；一天以台灣時間 0 點切（wake_day 跟今天不同就從 1 重算）
-- 只加不刪：舊版程式不讀這三欄，照常能跑
ALTER TABLE participants ADD COLUMN wake_day TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN wake_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN wake_at INTEGER NOT NULL DEFAULT 0;
