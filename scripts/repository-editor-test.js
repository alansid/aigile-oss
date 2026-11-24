import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, until, findBrowser } from './browser-kit.js';

if (!findBrowser()) { console.log('repository editor test skipped: browser unavailable'); process.exit(0); }
const kit = await startKit('repository-editor');
try {
  const user = (await kit.call(null, '/api/join', 'POST', { name: 'Alex', role: 'PG' })).body;
  const project = (await kit.call(user.token, '/api/projects', 'POST', { name: 'Demo' })).body.id;
  const endpoint = '/api/projects/' + encodeURIComponent(project) + '/repo';
  const items = [
    { name: 'Frontend', url: 'https://github.com/example/web', branch: 'main', primary: true },
    { name: 'Backend', url: 'https://github.com/example/api', branch: 'stable', primary: false },
  ];
  assert.equal((await kit.call(user.token, endpoint, 'PUT', { items })).status, 200);
  const { login, js, cdp } = await kit.browser(1280, 850);
  async function screenshot(name) {
    if (!process.env.SHOT_DIR) return;
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    const image = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.SHOT_DIR, name + '.png'), Buffer.from(image.result.data, 'base64'));
  }
  const click = async selector => {
    const query = 'document.querySelector(' + JSON.stringify(selector) + ')';
    await until(() => js('!!' + query), 12000, selector);
    await js(query + '.click();true');
  };
  for (const lang of ['zh', 'en']) {
    await login(user.token);
    await js('localStorage.setItem("aigile-lang",' + JSON.stringify(lang) + ');true');
    await login(user.token);
    await click('.sidebar [data-proj="' + project + '"]');
    await click('.ph-gear[data-pset="' + project + '"]');
    await click('[data-pset-act="repo"]');
    await until(() => js("document.querySelectorAll('.repo-row').length === 2"), 8000, 'two repositories');
    if (lang === 'en') await until(() => js("document.querySelector('.repo-primary').textContent === 'Primary'"), 5000, 'English');
    for (const width of [1280, 375]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
      assert.ok(await js("document.querySelector('#repo-form').scrollWidth <= document.querySelector('#repo-form').clientWidth + 1"));
      if (width === 1280) assert.equal(await js("document.querySelector('.modal:has(#repo-form)').offsetWidth"), 600);
      await screenshot(lang + '-' + width);
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
  }
  await click('[data-row="1"] [data-move="-1"]');
  await click('[data-row="0"] [data-primary]');
  await click('[data-row="0"] [data-remove]');
  assert.equal(await js("document.querySelector('.repo-row input[name=name]').value"), 'Frontend');
  assert.ok(await js("!!document.querySelector('.repo-row .repo-primary')"));
  await click('button[form="repo-form"][type="submit"]');
  await until(async () => (await kit.call(user.token, '/api/projects')).body.items.find(p => p.id === project)?.repositories.length === 1, 10000, 'persisted removal');
  const single = (await kit.call(user.token, '/api/projects', 'POST', { name: 'Docs' })).body.id;
  const docsUrl = 'https://github.com/example/docs';
  await kit.call(user.token, '/api/projects/' + single + '/repo', 'PUT', { url: docsUrl });
  await kit.call(user.token, endpoint, 'PUT', { items });
  await login(user.token, '/admin/projects');
  await until(() => js("document.querySelectorAll('a.pm-url').length >= 3"), 10000, 'repository table');
  assert.equal(await js("document.querySelector('a.pm-url[href$=\"/web\"]').textContent"), 'Frontend');
  assert.equal(await js("document.querySelector('a.pm-url[href$=\"/api\"]').textContent"), 'Backend');
  assert.equal(await js("document.querySelector('a.pm-url[href$=\"/docs\"]').textContent"), 'github.com/example/docs');
  await screenshot('en-table-1280');
  assert.equal(await js("getComputedStyle(document.querySelector('.repo-names')).whiteSpace"), 'nowrap');
  assert.equal(await js("document.querySelector('.repo-names').title"), 'Frontend · Backend');
  const reviewer = (await kit.call(null, '/api/join', 'POST', { name: 'Sam', role: 'PG' })).body.participant.participantId;
  await kit.call(user.token, '/api/participants/' + reviewer + '/projects', 'PUT', { projects: [project] });
  await kit.call(user.token, '/api/projects/' + project + '/review-settings', 'PUT', { cards: 'all', who: 'any' });
  const card = (await kit.call(user.token, '/api/cards', 'POST', { project, title: 'Update project settings', requestId: 'settings' })).body;
  const review = await kit.call(user.token, '/api/cards/' + card.cardId + '/review-request', 'POST', {
    reviewerId: reviewer, version: '1234567890abcdef', branch: 'settings', note: 'Check repository selection', repo: 'Backend',
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const projects = (await kit.call(user.token, '/api/projects')).body.items;
  const slug = projects.find(p => p.id === project).slug;
  await login(user.token, '/p/' + encodeURIComponent(slug) + '/work');
  await click('[data-card="' + card.cardId + '"]');
  await click('#card-drawer .repo-compare summary');
  await js("document.querySelector('#card-drawer .repo-compare').scrollIntoView({block:'center'});true");
  assert.equal(await js("document.querySelectorAll('#card-drawer .repo-compare[open] a').length"), 2);
  await until(() => js("document.querySelector('.repo-compare a').textContent.includes('Primary')"), 5000, 'primary label translated');
  await screenshot('en-compare-1280');
  console.log('repository editor test passed');
} finally { await kit.stop(); }
