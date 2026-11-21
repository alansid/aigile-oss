// 也產生 generated/script-hashes.json（AI 下載腳本的 SHA-256，見 scripts/script-hashes.mjs）。
// 版本紀錄：從 git log 產生 generated/releases.json（版本、上線時間、卡片、commit），部署時打包進 Worker，要登入才讀得到（GET /api/releases）。
// 流程圖 docs/flows.md 也打包進 Worker（GET /api/flows）。兩個都不放 public，外人讀不到（退回）。
// 用法：
//   node scripts/releases.mjs            只重新產生
//   node scripts/releases.mjs --deployed 把 package.json 目前版本的上線時間記成現在（部署時用：npm run deploy）
// 版本清單（releases）、事故對照、補記的上線時間放在 docs/releases-notes.json（手寫）；沒有 git 也產生得出來。
import { releaseData } from './release-data.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scriptHashes } from './script-hashes.mjs';

const root = new URL('../', import.meta.url);
const notesFile = new URL('docs/releases-notes.json', root);
const notes = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf8')) : { releases: [], deployed: {}, incidents: [] };
notes.releases ||= []; notes.deployed ||= {}; notes.incidents ||= [];
const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
if (process.argv.includes('--deployed')) {
  notes.deployed[version] = new Date().toISOString();
  fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2) + '\n');
}

// 由舊到新讀 commit；標題結尾「(v0.72.6)」或開頭「v0.30.0 」是版本號；沒有版本號的 commit 算進前一個版本
let log = [];
try { log = execFileSync('git', ['log', '--reverse', '--format=%h%x1f%aI%x1f%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean); } catch { /* 沒有 git：只用發行說明 */ }
const data = releaseData(version, notes, log);
fs.mkdirSync(new URL('generated/', root), { recursive: true });
fs.writeFileSync(new URL('generated/releases.json', root), JSON.stringify(data) + '\n');
for (const f of ['public/releases.json', 'public/flows.md']) fs.rmSync(new URL(f, root), { force: true }); // 舊版放在 public，外人讀得到，拿掉
// AI 下載腳本的 SHA-256 一起打包（worker.js 讀），不再手寫在 core.js
const hashes = scriptHashes();
fs.writeFileSync(new URL('generated/script-hashes.json', root), JSON.stringify(hashes, null, 2) + '\n');
console.log(`generated/script-hashes.json：${Object.keys(hashes).length} 個腳本雜湊`);
console.log(`generated/releases.json：${data.items.length} 個版本（目前 v${version}）`);
