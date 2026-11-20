import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIssueUrl, issueEnvironment } from '../public/issue-feedback.js';
import { findBrowser, startKit, until } from './browser-kit.js';

const repo = 'alansid/aigile-oss';
const bugInput = { title: '無法儲存 & #', steps: '1. 修改\n2. 儲存', expected: '儲存', version: '1.0.4', extra: 'Chrome 120', token: 'private' };
const featureInput = { title: 'Dark mode', problem: 'Too bright', idea: 'Add a switch', extra: 'Version: 1.0.4' };

for (const [type, name, input] of [['bug', 'bug_report.yml', bugInput], ['feature', 'feature_request.yml', featureInput]]) {
  const { href, truncated } = buildIssueUrl(repo, type, input);
  const url = new URL(href);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, `/${repo}/issues/new`);
  assert.equal(url.searchParams.get('template'), name);
  assert.equal(truncated, false);
  const template = fs.readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(input)) {
    if (key === 'token') { assert.equal(url.searchParams.has(key), false); continue; }
    assert.equal(url.searchParams.get(key), value);
    if (key !== 'title') assert.ok(template.includes(`id: ${key}\n`) || template.includes(`id: ${key}\r\n`), key);
  }
}

const long = buildIssueUrl(repo, 'feature', { ...featureInput, idea: '繁體😀'.repeat(1500) });
assert.ok(long.truncated && long.href.length <= 2000);
const shortened = new URL(long.href).searchParams;
assert.equal(shortened.get('title'), featureInput.title);
assert.equal(shortened.get('extra'), featureInput.extra);
assert.ok(featureInput.problem === shortened.get('problem') && '繁體😀'.repeat(1500).startsWith(shortened.get('idea')));
assert.ok(!shortened.get('idea').includes('\uFFFD'));
assert.deepEqual(issueEnvironment('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/121.0', 1280), { browser: 'Edge 121', system: 'Windows', width: 1280 });
assert.deepEqual(issueEnvironment('Mozilla/5.0 (Linux; Android 13) Chrome/120.0', 375), { browser: 'Chrome 120', system: 'Android', width: 375 });
assert.deepEqual(issueEnvironment('Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120.0', 1280), { browser: 'Chrome 120', system: 'Windows', width: 1280 });

async function checkSite(env, expectedRepo, testForm) {
  const kit = await startKit('issue-feedback', { env });
  try {
    assert.deepEqual(await kit.call(null, '/api/feedback-config'), { status: 200, body: { repo: expectedRepo } });
    if (!findBrowser() || !testForm) return;
    const { status, body: user } = await kit.call(null, '/api/join', 'POST', { name: '回報測試', role: 'PO' });
    assert.equal(status, 201, JSON.stringify(user.error));
    const { js, cdp, login, goto } = await kit.browser(1280, 900);
    for (const [width, lang, type] of [[1280, 'zh', 'bug'], [375, 'en', 'feature']]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: width < 600 });
      await goto('/', 'login');
      await js(`localStorage.setItem('aigile-lang', '${lang}')`);
      await login(user.token, '/help');
      await until(() => js("document.querySelectorAll('.help-toc li').length > 0"), 10000, 'Help index');
      if (expectedRepo === null) {
        assert.equal(await js("!!document.querySelector('.help-feedback')"), false);
        continue;
      }
      assert.equal(await js("document.querySelector('.help-feedback a').href"), `https://github.com/${expectedRepo}/discussions`);
      const button = `[data-issue-feedback="${type}"]`;
      assert.equal(await js(`document.querySelector('${button}').textContent`), lang === 'zh' ? '回報問題' : 'Request a feature');
      await js(`window.open = (...args) => { window.testIssue = args; }; document.querySelector('${button}').click()`);
      await until(() => js("!!document.querySelector('.issue-feedback')"), 10000, 'feedback form');
      assert.match(await js("document.querySelector('.issue-feedback-warning').textContent"), lang === 'zh' ? /可能公開/ : /may be public/);
      assert.match(await js("document.querySelector('#issue-feedback-submit-hint').textContent"), lang === 'zh' ? /需要 GitHub 帳號/ : /requires a GitHub account/);
      assert.match(await js("document.querySelector('#issue-feedback-submit').textContent"), /↗$/);
      await js("Promise.all(document.querySelector('.issue-feedback').closest('.modal').getAnimations().map(animation => animation.finished)).then(() => true)");
      assert.ok(await js("document.querySelector('#issue-feedback-submit').getBoundingClientRect().bottom <= innerHeight"), `${width}px action visible with the initial draft`);
      assert.equal(await js("document.querySelector('.issue-feedback').scrollWidth <= document.querySelector('.issue-feedback').clientWidth && document.querySelector('.modal').getBoundingClientRect().width <= innerWidth"), true, `${width}px without overflow`);
      assert.ok(await js("document.querySelector('.issue-env-toggle input').getBoundingClientRect().width < 24"), `${width}px checkbox uses its natural width`);
      assert.match(await js("document.querySelector('.issue-env-preview').textContent"), new RegExp(`${width} px`));
      await js(`(() => {
        const form = document.querySelector('.issue-feedback');
        form.elements.title.value = 'Example & test';
        for (const field of form.querySelectorAll('textarea')) field.value = 'Short text';
        ${type === 'feature' ? "form.elements.includeEnv.click(); form.elements.idea.value = '繁體😀'.repeat(1500);" : ''}
        form.requestSubmit();
      })()`);
      if (type === 'feature') {
        assert.equal(await js("document.querySelector('.issue-env-preview').hidden && !document.querySelector('.issue-feedback-notice').hidden && !window.testIssue"), true);
        await js("document.querySelector('.issue-feedback').requestSubmit()");
      }
      const [href, target, features] = await js('window.testIssue');
      assert.equal(target, '_blank');
      assert.equal(features, 'noopener,noreferrer');
      const url = new URL(href);
      assert.equal(url.pathname, `/${expectedRepo}/issues/new`);
      assert.equal(url.searchParams.get('title'), 'Example & test');
      if (type === 'feature') {
        assert.ok(href.length <= 2000 && !url.searchParams.has('extra') && !url.searchParams.has('version'));
        assert.equal(url.searchParams.get('problem'), 'Short text');
      } else {
        assert.equal(url.searchParams.get('steps'), 'Short text');
        assert.match(url.searchParams.get('extra'), /1280 px/);
        assert.match(url.searchParams.get('version'), /^\d+\.\d+\.\d+$/);
      }
    }
  } finally { await kit.stop(); }
}

await checkSite({ FEEDBACK_REPO: undefined }, repo, false);
await checkSite({ FEEDBACK_REPO: 'example/fork' }, 'example/fork', true);
await checkSite({ FEEDBACK_REPO: '0' }, null, true);
await checkSite({ FEEDBACK_REPO: 'example/..' }, null, false);
console.log(`issue-feedback-test passed (URL, config${findBrowser() ? ', 1280/375 browser checks' : '; browser unavailable'})`);
