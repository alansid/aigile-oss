// AI 發文格式檢查（純函式）：哪些擋、哪些只警告，同一草稿最多擋 2 次。HTTP 行為在 ask-test。
// 用法：node scripts/post-format-test.js
import assert from 'node:assert';
import { formatProblems, makeBlockCounter, TAGS } from '../src/post-format.js';

const f = (text, o) => formatProblems(text, o);
// 標籤
for (const t of TAGS) assert.deepEqual(f(`[${t}] 一句話`), { blocks: [], warnings: [] }, `[${t}] 在清單`);
assert.deepEqual(f('[進度 2/3] 寫測試').blocks, [], '[進度…] 前綴放行');
assert.match(f('[需確定] 要不要').blocks[0], /是要寫 \[需確認\] 嗎/, '差一個字');
assert.match(f('[完程] 好了').blocks[0], /\[完成\]/, '錯字');
assert.match(f('[接單了] 收到').blocks[0], /\[接單\]/, '多一個字');
assert.match(f('[決策紀] 決定').blocks[0], /\[決策紀錄\]/, '少一個字');
assert.deepEqual(f('[公告] 停機').blocks, [], '差太多不擋');
assert.match(f('[公告] 停機').warnings[0], /不在清單/, '只警告');
assert.deepEqual(f('沒有標籤的訊息'), { blocks: [], warnings: [] }, '沒標籤不管');
// replyFrom
assert.match(f('[通知] x', { replyFrom: ['p_a', 'p_b'] }).blocks[0], /replyFrom 一則最多一位[\s\S]*範例/, '兩位擋');
assert.deepEqual(f('[通知] x', { replyFrom: ['p_a', 'p_a'] }).blocks, [], '重複的同一位不算兩位');
assert.deepEqual(f('[通知] x', { replyFrom: ['p_a'] }).blocks, [], '一位不擋');
assert.deepEqual(f('[通知] x 請 @RVVW 處理', { replyFrom: [] }).blocks, [], '正文點名沒 replyFrom 不擋（條件 C）');
// [需確認] 選項（PO msg_bZlNJxxk7GH2vWp7 選 A）
assert.match(f('[需確認] 要哪個\n\nA. 甲\nB. 乙\n\n請選').blocks[0] || '', /沒有變成按鈕[\s\S]*範例/, '有 A./B. 卻變不成按鈕：擋');
assert.deepEqual(f('[需確認] 要哪個\n\n選項：\nA. 甲\nB. 乙').blocks, [], '正確寫法不擋');
assert.deepEqual(f('[需確認] 等你重發 Token').blocks, [], '完全沒選項（等人做事）不擋');
assert.deepEqual(f('[需確認] 兩件事\n問題1：做 A 嗎？\n選項：\nA. 做\nB. 不做\n問題2：什麼時候？\n今天或明天都可以').blocks, [], '某一題是開放題：判斷模糊不擋（只警告）');
assert.deepEqual(f('[進度] 選一個\nA. x\nB. y').blocks, [], '不是 [需確認] 不管');
// 同一草稿最多擋 2 次
const c = makeBlockCounter(1000);
assert.equal(c.hit('p_a', 'r1', '[需確定] 要不要'), 1);
assert.equal(c.hit('p_a', 'r2', '[需確定] 要不要'), 2, '第一行相同＝同一草稿');
assert.equal(c.hit('p_a', 'r3', '[需確定] 要不要'), 0, '第 3 次照送');
assert.equal(c.hit('p_b', 'r1', '[需確定] 要不要'), 1, '別的作者分開算');
assert.equal(c.hit('p_a', 'r9', '[需確定] 另一件事'), 1, '別的草稿重算');
assert.equal(c.hit('p_a', 'r9', '[需確定] 另一件事改寫'), 2, '同 requestId＝同一草稿');
assert.equal(c.hit('p_a', 'r1', '[需確定] 要不要', Date.now() + 5000), 1, '過期重算');
console.log('post-format-test：全部通過');
