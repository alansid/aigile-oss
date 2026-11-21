import assert from 'node:assert/strict';
import { findBrowser, startKit, until } from './browser-kit.js';

if (!findBrowser()) {
  console.log('setup-wizard-onboarding-ui-test: skipped (no Chrome or Edge)');
  process.exit(0);
}

for (const [lang, width] of [['zh', 1280], ['en', 375]]) {
  const kit = await startKit('wizard-onboarding', { env: { AIGILE_TEST_PROJECTS: '0', ADMIN_PASSWORD: 'wizard-test-password', UPDATE_CHECK: '0' } });
  try {
    const { status, body } = await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'wizard-test-password' });
    assert.equal(status, 200);
    assert.equal((await kit.call(body.token, '/api/me/password', 'PUT', {
      username: 'setup.demo', currentPassword: 'wizard-test-password', newPassword: 'changed-test-password', newPasswordAgain: 'changed-test-password',
    })).status, 200);

    const height = width < 600 ? 812 : 900;
    const { cdp, goto, js } = await kit.browser(width, height);
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await goto('/');
    await js(`localStorage.setItem('aigile-lang', ${JSON.stringify(lang)}); localStorage.setItem('aigile-switch-token', ${JSON.stringify(body.token)}); true`);
    await goto('/');
    const visible = selector => js(`!!document.querySelector(${JSON.stringify(selector)})?.offsetParent`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
    const checkScreen = async (stage, selector) => {
      await until(() => visible(selector), 15000, stage);
      assert.equal(await js('innerWidth'), width);
    };
    const checkFooter = async () => {
      if (lang !== 'en' || width !== 375) return;
      const footer = await until(() => js(`(() => {
        const buttons = [...document.querySelectorAll('#sw .sw-actions button')];
        if (buttons.at(-1)?.textContent !== 'Save & next') return null;
        return buttons.map(button => {
          const { y, height } = button.getBoundingClientRect();
          return { label: button.textContent, center: y + height / 2 };
        });
      })()`), 5000, 'short English footer labels');
      assert.deepEqual(footer.map(button => button.label), ['Skip all', 'Skip', 'Save & next']);
      assert.ok(footer.every(button => Math.abs(button.center - footer[0].center) < 1), 'English controls share one line at 375px');
    };

    await checkScreen('01-group', '#sw-group');
    await checkFooter();
    await click('[data-sw=skip]');
    await checkScreen('02-project', '#sw-pj-name');
    await checkFooter();
    await click('[data-sw=skip]');
    await checkScreen('03-invites', '#sw-inv-name');
    await click('[data-sw=next]');
    await checkScreen('04-first-ai', '#sw-ai-name');

    await js(`(() => {
      window.onboardingRequests = [];
      const send = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (typeof url === 'string' && url.endsWith('/onboarding-link')) window.onboardingRequests.push(JSON.parse(options.body));
        return send(url, options);
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedOnboarding = text; } } });
      return true;
    })()`);
    await click('[data-sw=ai]');
    await checkScreen('05-claude', '[data-sw=copyai]');
    assert.deepEqual(await js('window.onboardingRequests'), [], 'creating the AI does not mint an onboarding link');
    assert.equal(await js("document.querySelector('[data-sw-tool=claude]').getAttribute('aria-pressed')"), 'true');
    const copyLabel = start => (lang === 'zh' ? (start ? '複製一行啟動' : '複製接入文字') : (start ? 'Copy one-line start' : 'Copy onboarding text'));

    for (const [tool, start, stage] of [['claude', true, '05-claude'], ['codex', true, '06-codex'], ['antigravity', true, 'antigravity'], ['copilot', true, 'copilot'], ['other', false, '07-other']]) {
      await click(`[data-sw-tool=${tool}]`);
      await until(async () => await js("document.querySelector('[data-sw=copyai]').textContent.trim()") === copyLabel(start), 6000, stage);
      const info = await js("document.querySelector('#sw').textContent");
      assert.match(info, /15/);
      const warning = await js("document.querySelector('#sw .sw-safety').textContent");
      assert.match(warning, lang === 'zh' ? /⚠.*請勿貼到群組/ : /⚠.*out of group chat/);
      assert.match(info, lang === 'zh' ? (start ? /這隻 AI 的工作資料夾的終端機/ : /AI 的對話/) : (start ? /into a terminal/ : /into this AI's chat/));
      assert.equal(await visible('.sw-text'), false, 'the command stays off-screen on normal copies');
      await checkScreen(stage, '[data-sw=copyai]');
      await js('window.copiedOnboarding = null; true');
      await click('[data-sw=copyai]');
      const copied = await until(() => js('window.copiedOnboarding'), 10000, stage);
      assert.deepEqual(await js('window.onboardingRequests.at(-1)'), { autoStandby: start && tool !== 'copilot', ...(start ? { start: true } : {}), tool });
      if (start) {
        assert.ok(copied.startsWith('node -e "') && copied.includes(`'--tool','${tool}'`));
      } else {
        assert.match(copied, /curl -s --create-dirs/);
        assert.doesNotMatch(copied, /node -e|sandbox_mode/);
      }
      await until(async () => /✓/.test(await js("document.querySelector('[data-sw=copyai]').textContent")), 5000, 'copy confirmed');
    }

    await click('[data-sw-tool=codex]');
    await js("navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; document.execCommand = () => false; true");
    await click('[data-sw=copyai]');
    await until(() => visible('.sw-text'), 10000, 'manual copy after clipboard failure');
    assert.ok(await js("document.querySelector('.sw-text').value.includes(\"'--tool','codex'\")"));
    await click('[data-sw-tool=other]');
    assert.equal(await visible('.sw-text'), false, 'switching tools clears the previous command');
  } finally { await kit.stop(); }
}
console.log('setup-wizard-onboarding-ui-test: passed (zh/en, 1280/375, all five tools)');
