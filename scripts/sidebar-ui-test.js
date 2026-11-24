import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, startKit, until, sleep } from './browser-kit.js';

if (!findBrowser()) {
  console.log('sidebar-ui-test skipped: browser unavailable');
  process.exit(0);
}
process.env.AIGILE_TEST_PROJECTS = '1';
const kit = await startKit('sidebar-ui');
try {
  const user = (await kit.call(null, '/api/join', 'POST', { name: 'Alex', role: 'PG' })).body;
  const project = (await kit.call(user.token, '/api/projects')).body.items[0].id;
  const sender = (await kit.call(null, '/api/join', 'POST', { name: 'Sam', role: 'UX' })).body;
  await kit.call(user.token, '/api/participants/' + sender.participant.participantId + '/projects', 'PUT', { projects: [project] });
  for (let i = 0; i < 3; i++) {
    const id = user.participant.participantId;
    const result = await kit.call(sender.token, '/api/messages', 'POST', {
      project, requestId: 'demo-' + i, text: 'Review sample ' + i, recipientIds: [id], replyFrom: [id]
    });
    assert.ok(result.body.messageId, JSON.stringify(result.body));
  }
  const { js, cdp, login, key } = await kit.browser();
  const size = width => cdp('Emulation.setDeviceMetricsOverride', { width, height: 810, deviceScaleFactor: 1, mobile: false });
  const waitFor = selector => until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), 10000, selector);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const sideWidth = () => js("document.querySelector('.sidebar').offsetWidth");
  const shot = async name => {
    if (!process.env.SHOT_DIR) return;
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    const result = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.SHOT_DIR, name + '.png'), Buffer.from(result.result.data, 'base64'));
  };
  await login(user.token);
  for (const lang of ['zh', 'en']) {
    await js(`localStorage.setItem('aigile-lang','${lang}');true`);
    await login(user.token);
    for (const width of [1280, 1600]) {
      await size(width);
      await waitFor('.project-entry');
      assert.ok(await sideWidth() > 64);
      await shot(lang + '-' + width + '-expanded');
      const before = await js("document.querySelector('.main').clientWidth");
      await click('#side-toggle');
      await until(async () => await sideWidth() === 64, 3000, '64px rail');
      assert.ok(await js("document.querySelector('.main').clientWidth") > before);
      assert.equal(await js("document.querySelector('#side-toggle').title"), lang === 'en' ? 'Expand menu' : '展開選單');
      const todo = '.sidebar [data-hub-todo-open]';
      await until(() => js(`document.querySelector('${todo} .hs-n')?.textContent === '3'`), 5000, 'pending count');
      const point = await js(`(() => { const r = document.querySelector('${todo}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      assert.ok(await js(`document.elementFromPoint(${point.x},${point.y}).closest('${todo}') !== null`), await js(`document.elementFromPoint(${point.x},${point.y}).outerHTML.slice(0,160)`));

      assert.equal(await js("document.querySelector('.side-hint').textContent"), lang === 'en' ? 'Needs you · 3' : '要你處理 · 3');
      assert.equal(await js(`document.querySelector('${todo} .hs-n').offsetWidth`), 9);
      for (const [action, icon, label] of [
        ['data-hub-newproj', '＋', lang === 'en' ? 'Add project' : '新增專案'],
        ['data-join-open', '↪', lang === 'en' ? 'Request to join a project' : '申請加入專案'],
      ]) {
        const selector = '.sidebar [' + action + ']';
        assert.equal(await js(`document.querySelector('${selector} .hs-ico').textContent`), icon);
        const rect = await js(`document.querySelector('${selector}').getBoundingClientRect().toJSON()`);
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        await until(() => js(`!document.querySelector('.side-hint').hidden && document.querySelector('.side-hint').textContent === ${JSON.stringify(label)}`), 3000, label);
      }
      await shot(lang + '-' + width + '-collapsed');
      await js('window.sidebarTestBeforeReload = true;true');
      await cdp('Page.reload');
      await until(() => js("!window.sidebarTestBeforeReload && !document.querySelector('#app').hidden && !!document.querySelector('.project-entry')"), 15000, 'reloaded dashboard');

      assert.equal(await sideWidth(), 64);
      await js("document.querySelector('.project-page input').focus();true");
      await key('[','BracketLeft');
      assert.equal(await sideWidth(), 64);
      await js("document.activeElement.blur();true");
      await key('[','BracketLeft');
      await until(async () => await sideWidth() > 200, 3000, 'expand shortcut');
      await sleep(160);
    }
    await click('.project-entry');
    await waitFor('.sidebar .ph-swap');
    await click('#side-toggle');
    await until(async () => await sideWidth() === 64, 3000, 'project rail');
    await click('.sidebar .ph-swap .pico');
    assert.ok(await js("document.querySelector('.sidebar .ps-list').getBoundingClientRect().width > 100"));
    const option = await js(`(() => {
      const el = document.querySelector('.sidebar .ps-list [data-proj]');
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { x, y, reachable: el.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert.ok(option.reachable, 'project picker remains reachable beside the rail');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, x: option.x, y: option.y, button: 'left', clickCount: 1 });
    }
    await size(375);
    assert.equal(await sideWidth(), 0);
    await click('#menu-btn');
    await waitFor('#sheet:not([hidden])');
    await shot(lang + '-375-drawer');
    await size(1280);
    await login(user.token);
    await click('#side-toggle');
    await until(async () => await sideWidth() > 200, 3000, 'restore');
  }
  console.log('sidebar-ui-test passed');
} finally { await kit.stop(); }
