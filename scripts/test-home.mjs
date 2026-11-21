// 測試一律把「家目錄」換成暫存資料夾。接入檢查會把通用 MCP 轉接腳本複製到 ~/.aigile/、Codex 版會改 ~/.codex/config.toml、Antigravity CLI 版會改 ~/.gemini/config/mcp_config.json，
// 測試不能寫到真的家目錄或真的工具設定。用法：測試檔最上面 import './test-home.mjs';（run-all.js 也會先設好）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.env.AIGILE_HOME) process.env.AIGILE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-home-'));
process.env.AIGILE_TEST_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codexhome-')); // 每支測試自己一份（run-all 共用的那份會被前面的測試寫過）
process.env.CODEX_HOME = process.env.AIGILE_TEST_CODEX_HOME; // 一律蓋掉（測試用不到真的 Codex 設定）
process.env.AIGILE_TEST_GEMINI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-geminihome-')); // Antigravity CLI 的 ~/.gemini 也隔離
process.env.AIGILE_GEMINI_HOME = process.env.AIGILE_TEST_GEMINI_HOME;
process.env.AIGILE_CODEX_BIN ||= fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
process.env.AIGILE_ANTIGRAVITY_BIN ||= fileURLToPath(new URL('./fake-antigravity.mjs', import.meta.url));
