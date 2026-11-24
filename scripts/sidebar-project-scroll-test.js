import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, until, findBrowser, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('sidebar-project-scroll-test skipped: browser unavailable'); process.exit(0); }
const kit = await startKit('sidebar-project-scroll');
try {
  const user = (await kit.call(null, '/api/join', 'POST', { name: 'Alex', role: 'PG' })).body;
  let lastId;
  for (let i = 1; i <= 30; i++) {
    const result = await kit.call(user.token, '/api/projects', 'POST', { name: i === 30 ? 'qqq' : 'Project ' + String(i).padStart(2, '0') });
    assert.equal(result.status, 201);
    lastId = result.body.id;
  }
  const { js, login, cdp } = await kit.browser(1280, 720);
  const viewport = width => cdp('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
  const exists = selector => until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), 10000, selector);
  async function point(selector) {
    const rect = await js(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  async function reach(list, target) {
    const center = await point(list);
    for (let i = 0; i < 8; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...center, deltaX: 0, deltaY: 800 });
      await sleep(100);
      const p = await point(target);
      if (await js(`document.elementFromPoint(${p.x}, ${p.y})?.closest(${JSON.stringify(target)}) != null`)) return p;
    }
    assert.fail('Last project is unreachable: ' + target);
  }
  async function clickAt(p) {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  }
  async function shot(name) {
    if (!process.env.SHOT_DIR) return;
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    const image = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.SHOT_DIR, name + '.png'), Buffer.from(image.result.data, 'base64'));
  }
  const target = '.sidebar [data-proj="' + lastId + '"]';
  for (const collapsed of [false, true]) {
    await viewport(1280);
    await login(user.token);
    await exists(target);
    if (collapsed) await js("document.querySelector('#side-toggle').click();true");
    await sleep(180);
    const pinned = '.sidebar [data-hub-todo-open]';
    const home = '.sidebar [data-proj="hub"]';
    const top = await point(pinned), homeTop = await point(home);
    const p = await reach('.hs-projects', target);
    assert.deepEqual(await point(pinned), top);
    assert.deepEqual(await point(home), homeTop);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await shot(collapsed ? 'collapsed-1280' : 'expanded-1280');
    await clickAt(p);
    await until(() => js("document.querySelector('.sidebar .ph-name b')?.textContent === 'qqq'"), 6000, 'opened last project');
  }
  await viewport(375);
  await js("document.querySelector('#menu-btn').click();true");
  const swap = '.sheet-panel .ph-swap';
  await exists(swap);
  await js("Promise.all(document.querySelector('.sheet-panel').getAnimations().map(a => a.finished));");
  await js(`document.querySelector('${swap}').click();true`);
  const list = '.sheet-panel .ps-list:not([hidden])';
  const mobileTarget = list + ' [data-proj="' + lastId + '"]';
  await exists(mobileTarget);
  await js(`document.querySelector('${list}').scrollTop = 0;true`);
  const p = await reach(list, mobileTarget);
  await shot('drawer-375');
  await clickAt(p);
  await until(() => js("document.querySelector('#sheet').hidden"), 5000, 'drawer closes after selection');
  console.log('30 projects: last project reachable in expanded, collapsed and mobile views');
} finally { await kit.stop(); }

