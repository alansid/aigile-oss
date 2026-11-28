// 請同意 commit 的版本比對（只在伺服器 src/reviews.js 算一次；網頁只顯示 review.asks 的結果，不再自己比）
// - 只比標明是版本的碼（版本／指紋／SHA、請同意 push／部署／正式庫遷移：）；基底、疊在、候選、父提交、「從 … 開」等不比
// - 對不上時回傳真正對不上的那個碼（兩版指紋時不能回第一個碼）
// - 64 碼指紋寫開頭幾碼也認得
// 純函式測試，不連任何資料庫。用法：node scripts/commit-ask-version-test.js
import assert from 'node:assert';
import { askVersions, askMismatch } from '../src/reviews.js';

const FP = 'b03f15dd1a46ab04287c2aa95cd886edac53929e9f3fe353ef079487ac0e62e4', FP2 = '7749d16befd1bd934ecd70bb364fa60cbf1c9198fee6f91e2dd2ac9ac48fb162';
const B1 = '500c790ee837022e1890d79053177572dee527fd', B2 = 'e6d0e704b87bc7ad68ef299a461628d89ce256cd';
const C1 = 'c'.repeat(64), C2 = 'd'.repeat(64), V = 'a'.repeat(64), repos = [{ fingerprint: C1 }, { fingerprint: C2 }];
const mStacked = `[需確認] X-1 轉址修正已審過（審查者 通過），請同意兩版本機 commit。\n• 問題：Workers 的 fetch 不收 redirect:'error'。\n• 審過的完整指紋：${FP}\n• 工作樹：\n - 平台：/work/plat-redir（疊在 整合候選 ${B1}）\n - 開源：/work/oss-redir（疊在 ${B2}）\n• 同意後：我 commit，完整 SHA 交回整合。`;
const mShort = `[需確認] X-1 複審已通過（審查者，指紋 ${FP2.slice(0, 8)}…），請同意本機 commit。\n• X-1：兩版都改。\n - 平台：/work/plat-x（從 492cf6d 開）\n - 開源：/work/oss-x（從 2fd5bcc 開）\n• 測試修正：/work/plat-readcost（從 main b7ea2ee 開）`;
const cases = [
  // [說明, 請示原文, 審過的版本, 兩版指紋, 預期要比的碼, 預期對不上的碼]
  ['疊在候選的請示：疊在的候選 SHA 不比', mStacked, FP, null, [FP], null],
  ['疊在候選的請示但指紋真的變了：回報指紋', mStacked.replace(FP, FP2), FP, null, [FP2], FP2],
  ['指紋縮寫的請示：指紋縮寫認得、「從 … 開」不比', mShort, FP2, null, [FP2.slice(0, 8)], null],
  ['基底 SHA：不比；版本：要比', `[需確認] X-1 請同意 commit，基底 SHA：${B1}，版本：${FP.slice(0, 8)}`, FP, null, [FP.slice(0, 8)], null],
  ['沒標明的碼一律不比', `[需確認] X-1 請同意 commit（${B1}）`, FP, null, [], null],
  ['日期、編號不是碼', '[需確認] X-1 請同意 commit（20261123 測過，第 1234567 則）', FP, null, [], null],
  ['489 按鈕行', `[需確認] 請同意 push main\n請同意 push：${B1}`, B1, null, [B1], null],
  ['兩版指紋都給：對得上', `[需確認] X-1 請同意 commit\n• 平台指紋：${C1}，開源指紋：${C2}\n• 平台疊在 ${B1}`, V, repos, [C1, C2], null],
  ['兩版指紋接著寫（只隔空白）', `[需確認] X-1 請同意 commit，指紋：${C1.slice(0, 9)} ${C2.slice(0, 9)} 疊在 abc0123 之上`, V, repos, [C1.slice(0, 9), C2.slice(0, 9)], null],
  ['兩版指紋有一個認不得：回報認不得的那個，不是第一個', `[需確認] X-1 請同意 commit\n• 平台指紋：${C1}\n• 開源指紋：${'e'.repeat(64)}`, V, repos, [C1, 'e'.repeat(64)], 'e'.repeat(64)],
  ['一個程式庫：審過的版本＋另一個標明的 SHA，回報那個 SHA', `[需確認] X-1 請同意 commit\n• 版本：${FP}\n• SHA：${B1}`, FP, null, [FP, B1], B1],
  ['一個程式庫：兩個標明的碼都是審過的（全碼＋縮寫）', `[需確認] X-1 請同意 commit，版本：${FP} ${FP.slice(0, 8)}`, FP, null, [FP, FP.slice(0, 8)], null],
  ['只給一版指紋：對不上', `[需確認] X-1 請同意 commit，指紋：${C1}`, V, repos, [C1], C1],
];
for (const [name, text, version, rs, want, bad] of cases) {
  const got = askVersions(text);
  assert.deepEqual(got, want, `${name}：要比的碼`);
  assert.equal(got.length ? askMismatch(got, version, rs) : null, bad, `${name}：對不上的碼`);
}
const app = (await import('node:fs')).readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.ok(!/askVersions|askMismatch|ASK_LABEL_RE/.test(app), '網頁不再自己比版本（只留伺服器一份）');
console.log(`commit-ask-version-test：全部通過（${cases.length} 種請示：只比標明的版本、回報真正對不上的碼、指紋縮寫認得；網頁不再自己比）`);
