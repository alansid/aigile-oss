// 驗收測試（開源版）：拖曳上傳（群組輸入框、卡片輸入區、專案文件／知識庫、全頁防跳走）
// 用法：node scripts/drag-drop-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const cssPath = fileURLToPath(new URL('../public/style.css', import.meta.url));
const enPath = fileURLToPath(new URL('../public/i18n/en.js', import.meta.url));
execFileSync(process.execPath, ['--check', appPath], { windowsHide: true });
execFileSync(process.execPath, ['--check', enPath], { windowsHide: true });

const js = fs.readFileSync(appPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const en = fs.readFileSync(enPath, 'utf8');

// A. 群組訊息頁（含訊息清單＋輸入框）拖放走 openUpload
assert.match(js, /setDropZone\(msgPageEl,/, '綁定整個群組訊息頁 #page-messages');
assert.match(js, /放開就上傳到群組（跟 📎 一樣的限制與聲明）[\s\S]{0,120}onFiles:\s*files\s*=>\s*openUpload\(files\)/, '群組拖檔走現有 openUpload 流程');

// B. 卡片抽屜輸入區 .dcompose 拖放＋視覺提示
assert.match(js, /e\.target\.closest\?\.\('\.dcompose'\)[\s\S]{0,200}drop-over[\s\S]{0,200}放開檔案以加入卡片附件/, '卡片輸入區有拖放提示框');
assert.match(js, /attAdd\(attOf\(key\),\s*\[\.\.\.e\.dataTransfer\.files\]\);\s*attRefresh\(key\)/, '卡片輸入區拖檔加入附件格');

// C. 專案文件與知識庫分頁拖放走 uploadDocs
assert.match(js, /放開就上傳到「\$\{dropFolder\}」[\s\S]{0,180}onFiles:\s*files\s*=>\s*uploadDocs\(pj,\s*files\)/, '專案文件分頁拖檔走 uploadDocs 並顯示資料夾名');
assert.match(js, /放開就上傳到知識庫[\s\S]{0,120}onFiles:\s*files\s*=>\s*uploadDocs\(pj,\s*files,\s*true\)/, '知識庫分頁拖檔走 uploadDocs(pj, files, true)');

// D. 全域防止拖檔跳走（只攔截 Files，不動看板卡片拖曳）
assert.match(js, /window\.addEventListener\('dragover',\s*e\s*=>\s*\{\s*if\s*\(e\.dataTransfer\?\.types\?\.includes\('Files'\)\)\s*e\.preventDefault\(\);\s*\}\)/, '全域 dragover 防開檔跳走');
assert.match(js, /window\.addEventListener\('drop',\s*e\s*=>\s*\{\s*if\s*\(e\.dataTransfer\?\.types\?\.includes\('Files'\)\)\s*e\.preventDefault\(\);\s*\}\)/, '全域 drop 防開檔跳走');

// CSS 與英文翻譯
assert.match(css, /\.drop-target\.drop-over::after/, 'CSS 含拖曳提示框樣式');
assert.match(css, /content:\s*'⬆\s+'\s*attr\(data-drop-hint\)/, 'CSS 顯示 ⬆ 圖示與 data-drop-hint');
assert.match(en, /Drop to upload to the group \(same limits and confirmation as 📎\)/, '英文含群組拖曳提示');
assert.match(en, /Drop files to attach to this card/, '英文含卡片拖曳提示');
assert.match(js, /Drop to upload to "\$\{fn\}"/, '英文含專案文件動態資料夾名提示');
assert.match(en, /Drop to upload to the knowledge base/, '英文含知識庫拖曳提示（小寫 knowledge base）');

console.log('drag-drop-test：全部通過');
