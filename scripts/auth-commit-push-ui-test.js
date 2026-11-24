// 畫面測試（真的瀏覽器，中英文、1280／375）：
// commit／push 授權列區分（含基底 40 碼 SHA 不誤出「同意 Push」、同時提到 commit 與 push 分開顯示並只認「要 push 的 SHA：」、C-140 保留）
// 用法：node scripts/auth-commit-push-ui-test.js（SHOT_DIR=資料夾 會存截圖）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('auth-commit-push-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('acpush');
try {
  const { call } = kit;
  const SHA_BASE = '1111111111111111111111111111111111111111';
  const SHA_PUSH = '2222222222222222222222222222222222222222';
  const SHA_DONE = '3333333333333333333333333333333333333333';
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const pj = (await call(boss.token, '/api/me')).body.projects[0];
  const ai = (await call(boss.token, '/api/my-ais', 'POST', {
    projects: [pj], roleKey: 'PG', role: '程式開發', name: '程式助手',
    duties: '寫程式', style: '簡潔', autonomy: '跑測試', mustConfirm: 'commit 與 push 問', handoff: '回報結果',
  })).body;
  const pgTok = kit.aiToken(ai.participantId);
  let rq = 0;
  const postPg = text => call(pgTok, '/api/messages', 'POST', { project: pj, text, requestId: 'ac-' + (++rq) });

  const mCommit = (await postPg(`[需確認] 修好了請同意 commit（基底 SHA ${SHA_BASE}）`)).body;
  const mPush = (await postPg(`[需確認] 已 commit（${SHA_BASE}），請同意 push ${SHA_PUSH}`)).body;
  const mBoth = (await postPg(`[需確認] 請同意 commit（基底 SHA：${SHA_BASE}）並推送。\n要 push 的 SHA：${SHA_PUSH}`)).body;
  const mBothUnlabeled = (await postPg(`[需確認] 請同意 commit（基底 SHA：${SHA_BASE}）與 push`)).body;
  const mDone = (await postPg(`[完成] 已完成（${SHA_DONE}）`)).body;

  const { js, login, cdp, goto } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  const shotDir = process.env.SHOT_DIR;
  const shot = async name => {
    if (!shotDir) return;
    await sleep(300);
    fs.mkdirSync(shotDir, { recursive: true });
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const infoOf = id => js(`(() => {
    const el = document.getElementById('msg-' + ${JSON.stringify(id)});
    if (!el) return null;
    return JSON.stringify({
      commits: el.querySelectorAll('[data-auth="commit"]').length,
      pushes: [...el.querySelectorAll('[data-auth="push"]')].map(b => b.dataset.asha),
      authRows: el.querySelectorAll('.auth-row').length,
      pairCount: el.querySelectorAll('.auth-pair').length,
      boxText: el.querySelector('.auth-box')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    });
  })()`).then(s => JSON.parse(s));

  const runLocale = async lang => {
    await size(1280, 900);
    await goto('/', 'init');
    await js(`localStorage.setItem('aigile-lang', ${JSON.stringify(lang)}); true`);
    await login(boss.token, `/p/${encodeURIComponent(pj)}/messages`);
    await until(() => js(`!!document.getElementById('msg-${mCommit.messageId}') && !!document.getElementById('msg-${mDone.messageId}')`), 15000, `${lang} messages`);

    const c1 = await infoOf(mCommit.messageId);
    assert.deepEqual([c1.commits, c1.pushes], [1, []], `${lang} commit 含基底 SHA 只出 commit`);
    const c2 = await infoOf(mPush.messageId);
    assert.deepEqual([c2.commits, c2.pushes], [0, [SHA_PUSH]], `${lang} push 請求只出 Push`);
    const c3 = await infoOf(mBoth.messageId);
    assert.deepEqual([c3.commits, c3.pushes, c3.pairCount], [1, [SHA_PUSH], 1], `${lang} 同時提到 commit 與 push 在同框分開且不誤認基底 SHA`);
    const c4 = await infoOf(mBothUnlabeled.messageId);
    assert.deepEqual([c4.commits, c4.pushes], [1, []], `${lang} 同時提但沒標 push SHA 不誤拿基底 SHA`);
    const c5 = await infoOf(mDone.messageId);
    assert.equal(c5.authRows, 0, `${lang} C-140 完成含 SHA 不畫授權列`);

    if (lang === 'en') {
      assert.ok(!/[㐀-鿿]/.test(c1.boxText) && /Approve commit \(local only\)/.test(c1.boxText), 'EN commit 無中文: ' + c1.boxText);
      assert.ok(!/[㐀-鿿]/.test(c3.boxText) && /Approve commit \(local only\)/.test(c3.boxText) && /Version to push: 2222222…2222/.test(c3.boxText) && /Approve push \(to GitHub\)/.test(c3.boxText), 'EN both 無中文: ' + c3.boxText);
      assert.ok(!/[㐀-鿿]/.test(c4.boxText), 'EN both unlabeled hint 無中文: ' + c4.boxText);
      await js(`document.getElementById('msg-${mBoth.messageId}').scrollIntoView({ block: 'end' }); true`);
      assert.ok(await js('document.documentElement.scrollWidth <= 1281'), 'EN 1280 不橫向捲動');
      await shot('plat438-en-1280');
      await size(375, 812); await sleep(250);
      await js(`document.getElementById('msg-${mBoth.messageId}').scrollIntoView({ block: 'center' }); true`);
      assert.ok(await js('document.documentElement.scrollWidth <= 376'), 'EN 375 不橫向捲動');
      await shot('plat438-en-375');
    }
  };

  await runLocale('zh');
  await runLocale('en');
  console.log('auth-commit-push-ui-test：全部通過（中英文 1280/375、commit含基底SHA不出Push、push只出Push、同時提分開清楚）');
} catch (e) {
  console.error('auth-commit-push-ui-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
