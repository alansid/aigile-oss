// 畫面測試（真的瀏覽器）：技能「發給誰」三選一、角色清單有 SA 與專案自訂角色、指定 AI、抽屜裡改發給誰、我的 AI 看得到
// 修正前：上傳視窗只有固定 8 個角色膠囊（沒有 SA、沒有自訂角色），不能選 AI，上架後不能改
// 用法：node scripts/skill-target-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('skill-target-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  kit.sql("INSERT INTO app_settings (key, value) VALUES ('roles:預設專案', ?)", JSON.stringify([{ key: 'NUT', role: '營養顧問', status: 'active', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }]));
  const mkAi = async (name, roleKey) => (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body.participantId;
  const pg = await mkAi('程式助手', 'PG'), sa = await mkAi('系統分析助手', 'SA');
  await mkAi('產品助手', 'PO');
  const skill = n => [{ path: 'SKILL.md', text: `---\nname: ${n}\ndescription: ${n} 的說明\n---\n規則\n` }];
  const made = (await kit.call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: skill('pg-only'), aiIds: [pg] })).body;
  assert.ok(made.skillId, JSON.stringify(made));
  const { js, login, cdp } = await kit.browser(1280, 860);
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

  // 技能庫：管理員從我的 AI 進「成員與權限 › 技能」
  const openLib = async () => {
    await login(boss.token, '/my-ai');
    await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '技能庫入口');
    await click('#ma-skills');
    await until(() => js(`!!document.querySelector('[data-skc="${made.skillId}"]')`), 10000, '技能庫清單');
  };
  for (const w of [1280, 375]) {
    const L = w + 'px ';
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: w < 600 });
    await openLib();
    assert.match(await text(`[data-skc="${made.skillId}"]`), w === 1280 ? /指定 1 隻 AI/ : /PG.*SA/s, L + '清單標發給誰（375 時已在 1280 改成 PG、SA）');

    // 上傳視窗第 3 步：三選一
    await click('[data-skup]');
    await until(() => js("!!document.querySelector('#sk-to .sk-to-mode')"), 8000, L + '上傳視窗');
    assert.deepEqual(JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#sk-to .sk-to-mode')].map(b => b.textContent + ':' + b.getAttribute('aria-checked')))")), ['所有 AI:true', '指定角色:false', '指定 AI:false'], L + '預設所有 AI');
    assert.match(await text('#sk-to .sk-to-n'), /會裝到 3 隻 AI/, L + '所有 AI 的數字');
    // 指定角色：有 AI 在用的（PG、SA、PO）先列，其他收在「更多角色」；自訂角色在更多裡
    await click('#sk-to [data-sk-mode="roles"]');
    const roles = JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#sk-to .sk-up-role')].map(b => b.textContent))"));
    assert.ok(['PO', 'SA', 'PG'].every(k => roles.includes(k)) && !roles.includes('UX'), L + '先列專案在用的角色：' + roles);
    assert.match(await text('#sk-to .sk-to-n'), /先選角色/, L + '還沒選角色');
    await click('#sk-to [data-sk-more]');
    const all = JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#sk-to .sk-up-role')].map(b => b.textContent))"));
    assert.ok(all.includes('營養顧問') && all.includes('UX'), L + '更多角色裡有自訂角色：' + all);
    await click('#sk-to [data-skrole="SA"]');
    assert.match(await text('#sk-to .sk-to-n'), /會裝到 1 隻 AI/, L + '選 SA → 1 隻');
    assert.equal(await js("document.activeElement?.dataset?.skrole"), 'SA', L + '重畫後焦點留在 SA');
    // 指定 AI：列專案的 AI，沒選不能上架
    await click('#sk-to [data-sk-mode="ais"]');
    assert.match(await text('#sk-to .sk-to-n'), /先選 AI/, L + '還沒選 AI');
    const aiNames = JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#sk-to .sk-to-ai b')].map(b => b.textContent))"));
    assert.deepEqual(aiNames.sort(), ['產品助手', '程式助手', '系統分析助手'].sort(), L + '列專案的 AI');
    await click(`#sk-to [data-sk-ai="${sa}"]`);
    assert.match(await text('#sk-to .sk-to-n'), /會裝到 1 隻 AI/, L + '選一隻 → 1 隻');
    const ov = await js("(() => { const m = document.querySelector('.modal.sk-up'); return m.scrollWidth - m.clientWidth; })()");
    assert.ok(ov <= 1, L + '上傳視窗沒有橫向捲動：' + ov);
    await click('[data-skcancel]');
    await new Promise(r => setTimeout(r, 300));

    // 抽屜：看得到發給誰；按「改」→ 所有 AI → 儲存，不用重傳
    if (w === 1280) {
      await click(`[data-skc="${made.skillId}"]`);
      await until(() => js("!!document.querySelector('#sk-to-sec')"), 8000, L + '技能抽屜');
      assert.match(await text('#sk-to-sec'), /指定 1 隻 AI：程式助手/, L + '抽屜寫發給誰');
      await click('[data-skto]');
      await until(() => js("!!document.querySelector('#sk-to-edit .sk-to-mode')"), 5000, L + '改發給誰');
      await click('#sk-to-edit [data-sk-mode="roles"]');
      assert.equal(await js("document.querySelector('[data-sktosave]').disabled"), true, L + '指定角色沒選不能存');
      await click('#sk-to-edit [data-skrole="PG"]');
      await click('#sk-to-edit [data-skrole="SA"]');
      await click('[data-sktosave]');
      await until(async () => /PG、SA/.test(await text('#sk-to-sec')), 8000, L + '存好後抽屜更新');
      const now = (await kit.call(boss.token, `/api/skills/${made.skillId}`)).body;
      assert.deepEqual([now.version, now.roles.sort(), now.aiIds], [1, ['PG', 'SA'], []], L + '存到平台、不升版本');
      await click('[data-skx]');
    }
  }

  // 我的 AI › 技能：看得到發給誰
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await login(boss.token, '/my-ai');
  await until(() => js(`!!document.querySelector('[data-act="row"][data-id="${pg}"]')`), 10000, '我的 AI');
  await click(`[data-act="row"][data-id="${pg}"]`);
  await until(() => js(`!!document.querySelector('[data-act="tab"][data-tab="skills"][data-id="${pg}"]')`), 5000, '技能分頁');
  await click(`[data-act="tab"][data-tab="skills"][data-id="${pg}"]`);
  await until(() => js(`/pg-only/.test(document.querySelector('[data-ma-skills="${pg}"]')?.textContent || '')`), 8000, '我的 AI 技能');
  assert.match(await text(`[data-ma-skills="${pg}"]`), /pg-only.*發給 PG、SA/s, '我的 AI 看得到發給誰');
  console.log('skill-target-ui-test：全部通過');
} catch (e) {
  console.error('skill-target-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
