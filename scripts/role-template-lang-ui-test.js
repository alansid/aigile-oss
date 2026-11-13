// 角色範本照介面語言預填（真的瀏覽器）：英文介面選範本，角色名、AI 名稱、五題都是英文；中文介面照舊中文
// 兩處預填都驗：1. 新增 AI 表單（我的 AI › 新增 AI）2. 第一次設定引導的「第一隻 AI」（建好的 AI 存的也是那個語言）
// 英文 AI 名稱：<人類>-<suffix>，例 Alex-PG-AI（名稱不能有空白）
// 截圖：設 ROLE_LANG_SHOT=<資料夾> 就把英文表單選 PG 後的樣子存成 add-ai-pg-en.png（1280 寬）
// 用法：node scripts/role-template-lang-ui-test.js（找不到 Chrome／Edge 就略過）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';
import { ROLES, SETTING_FIELDS } from '../src/roles.js';

if (!findBrowser()) { console.log('role-template-lang-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const FIELDS = SETTING_FIELDS.map(f => f.key);
const PG = ROLES.find(r => r.key === 'PG'), PO = ROLES.find(r => r.key === 'PO');
const kit = await startKit('rolelang');
try {
  const alex = (await kit.call(null, '/api/join', 'POST', { name: 'Alex', role: 'PO' })).body; // 第一位＝管理員
  const { js, login, cdp } = await kit.browser(1280, 900);
  const val = sel => js(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const form = () => js(`JSON.stringify(Object.fromEntries(['role', 'name', ${FIELDS.map(f => `'${f}'`).join(', ')}].map(k => [k, document.querySelector('#ai-form [name="' + k + '"]').value])))`).then(JSON.parse);
  const open = async lang => {
    await login(alex.token, '/');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); true`);
    await login(alex.token, '/my-ai');
    if (lang === 'en') await until(() => js("document.documentElement.lang === 'en'"), 5000, '英文介面');
  };
  const want = (r, lang, name) => ({ role: lang === 'en' ? r.en.role : r.role, name, ...Object.fromEntries(FIELDS.map(f => [f, lang === 'en' ? r.en[f] : r[f]])) });

  for (const lang of ['en', 'zh']) {
    const L = lang === 'en' ? '英文' : '中文';
    const nameOf = r => (lang === 'en' ? `Alex-${r.en.suffix}` : `Alex的${r.suffix}`);
    // 1. 新增 AI 表單：一打開預填第一個範本（PO），換成 PG 整組跟著換
    await open(lang);
    await until(() => click('#ai-new'), 10000, '新增 AI 按鈕');
    await until(() => js("!!document.querySelector('#ai-form [name=duties]')"), 8000, '新增 AI 表單');
    assert.deepEqual(await form(), want(PO, lang, nameOf(PO)), `${L}：一打開預填 PO`);
    await js("(() => { const s = document.querySelector('#ai-form [name=roleKey]'); s.value = 'PG'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    await until(async () => (await val('#ai-form [name=role]')) === (lang === 'en' ? PG.en.role : PG.role), 5000, `${L}：選 PG`);
    assert.deepEqual(await form(), want(PG, lang, nameOf(PG)), `${L}：選 PG 後角色名、AI 名稱、五題`);
    const shown = JSON.parse(await js("JSON.stringify({ opt: document.querySelector('#ai-form [name=roleKey] option[value=PG]').textContent, labels: [...document.querySelectorAll('#ai-form .ta-head > span:first-child')].map(s => s.textContent.trim()) })"));
    if (lang === 'en') {
      assert.equal(shown.opt, PG.en.option, '英文：下拉顯示英文');
      for (const l of shown.labels) assert.ok(!/[㐀-鿿]/.test(l), '英文：五題題目有翻：' + l);
      await sleep(400);
      if (process.env.ROLE_LANG_SHOT) {
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false }); // 拉高一點，五題看得到
        await sleep(400);
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        await cdp('Emulation.clearDeviceMetricsOverride');
        fs.mkdirSync(process.env.ROLE_LANG_SHOT, { recursive: true });
        fs.writeFileSync(path.join(process.env.ROLE_LANG_SHOT, 'add-ai-pg-en.png'), Buffer.from(shot.result.data, 'base64'));
      }
    } else {
      assert.equal(shown.opt, PG.option, '中文：下拉照舊');
      assert.deepEqual(shown.labels, SETTING_FIELDS.map(f => f.label), '中文：五題題目照舊');
    }

    // 2. 第一次設定引導：跳到「第一隻 AI」，預設 PG；建好的 AI 存的是同一個語言的範本
    await login(alex.token, '/');
    await js("(() => { const b = document.createElement('button'); b.dataset.next = 'wizard'; document.body.appendChild(b); b.click(); b.remove(); return true; })()"); // 跟總覽「重新打開設定引導」同一顆
    for (let i = 0; i < 3; i++) {
      await until(() => js("!!document.querySelector('#sw [data-sw=skip]')"), 8000, `引導第 ${i + 1} 步`);
      await click('#sw [data-sw=skip]');
    }
    await until(() => js("!!document.querySelector('#sw-role')"), 8000, '引導第 4 步');
    assert.equal(await val('#sw-role'), 'PG', '引導預設 PG');
    assert.equal(await val('#sw-ai-name'), nameOf(PG), `${L}：引導 AI 名稱`);
    if (lang === 'en') assert.equal(await js("document.querySelector('#sw-role option[value=PG]').textContent"), PG.en.option, '英文：引導下拉');
    await click('#sw [data-sw=ai]');
    await until(() => js("!!document.querySelector('.sw-text')"), 10000, '引導建好 AI');
    const ai = (await kit.call(alex.token, '/api/my-ais')).body.items.find(a => a.name === nameOf(PG));
    assert.ok(ai, `${L}：引導建好的 AI`);
    assert.deepEqual({ role: ai.role, name: ai.name, ...Object.fromEntries(FIELDS.map(f => [f, ai[f]])) }, want(PG, lang, nameOf(PG)), `${L}：引導建好的 AI 存的是${L}範本`);
  }

  // 已建好的 AI 不動：英文介面建的那隻，在中文介面編輯時照舊是英文
  const enAi = (await kit.call(alex.token, '/api/my-ais')).body.items.find(a => a.name === `Alex-${PG.en.suffix}`);
  assert.equal(enAi.duties, PG.en.duties, '切回中文後，英文建的 AI 設定不變');
  console.log('role-template-lang-ui-test：全部通過');
} catch (e) {
  console.error('role-template-lang-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
