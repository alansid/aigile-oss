import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, startKit, until } from './browser-kit.js';

process.env.AIGILE_TEST_PROJECTS = '1';
process.env.TEAM_CACHE_MS = '0';
const kit = await startKit('project-overview');
try {
  const join = async (name) => (await kit.call(null, '/api/join', 'POST', { name, role: 'UX' })).body;
  const human = await join('設計驗證'),
    other = await join('專案同事');
  const call = (url, method, body) => kit.call(human.token, url, method, body);
  const items = (await call('/api/projects')).body.items;
  const pj = items[0].id,
    url = '/api/projects/' + encodeURIComponent(pj);
  assert.equal((await call(url, 'PATCH', { description: '共同開發與驗證' })).status, 200);
  assert.equal((await call(url, 'PATCH', { description: '共同開發與驗證' })).status, 200);
  const events = (await call(url + '/events')).body.items;
  assert.equal(
    events.filter((e) => e.actorId === human.participant.participantId && e.text.includes('更新專案描述')).length,
    1
  );
  assert.equal((await call(url, 'PATCH', { description: '字'.repeat(41) })).status, 400);
  for (const body of [{ starred: true }, { visit: true }])
    assert.equal((await call(url + '/preference', 'PUT', body)).status, 200);
  const prefs = (await call('/api/projects')).body.items.find((p) => p.id === pj);
  assert.ok(prefs.starred && prefs.visitedAt && prefs.description === '共同開發與驗證');
  assert.equal(
    (await call('/api/participants/' + other.participant.participantId + '/projects', 'PUT', { projects: [pj] }))
      .status,
    200
  );
  assert.equal((await kit.call(other.token, '/api/projects')).body.items.find((p) => p.id === pj).starred, false);
  const second = items.find((x) => x.id !== pj).id;
  const addAi = async (name, projects) => {
    const result = await call('/api/my-ais', 'POST', {
      name,
      projects,
      roleKey: 'PG',
      role: 'PG',
      duties: '開發',
      style: '清楚',
      autonomy: '自測',
      mustConfirm: '提交',
      handoff: '審查'
    });
    assert.equal(result.status, 201);
    return result.body.participantId;
  };
  const active = await addAi('團隊開發助手', [pj, second]),
    expired = await addAi('舊版助手', [pj]);
  kit.sql('UPDATE participants SET last_seen_at=? WHERE id=?', Date.now(), active);
  kit.sql('UPDATE participants SET token_expires_at=? WHERE id=?', Date.now() - 86400000, expired);
  const outside = await addAi('其他專案助手', [second]);
  const owner = human.participant.participantId;
  const send = async (label, project, age) => {
    const at = new Date(Date.now() - age * 86400000).toISOString();
    const mid = 'msg_sample_' + label;
    kit.sql(
      'INSERT INTO messages (id,author_id,text,project,created_at) VALUES (?,?,?,?,?)',
      mid,
      owner,
      '請確認 ' + label,
      project,
      at
    );
    kit.sql(
      'INSERT INTO notifications(id,recipient_id,message_id,reasons,status,created_at) VALUES(?,?,?,?,?,?)',
      'notif_sample_' + label,
      active,
      mid,
      '["mention"]',
      'pending',
      at
    );
    return mid;
  };
  const recent = await send('recent', pj, 1);
  await send('old', pj, 9);
  await send('other', second, 1);
  const seeded = await call('/api/cards', 'POST', {
    requestId: 'overview-project-test',
    project: pj,
    title: '協作頁面自測',
    status: '進行中',
    ownerId: active
  });
  assert.ok(seeded.body.cardId);
  const team = (await call('/api/team-status?project=' + encodeURIComponent(pj))).body;
  assert.deepEqual(
    team.unanswered.map((u) => u.messageId),
    [recent]
  );
  assert.ok(team.members.find((m) => m.participantId === expired).tokenExpired);
  assert.ok(!team.members.some((m) => m.participantId === outside));
  assert.ok(team.members.every((m) => m.projects.includes(pj)));
  assert.equal((await call('/api/team-status?project=missing')).status, 403);
  if (!findBrowser()) {
    console.log('project-overview: API passed, browser unavailable');
  } else {
    const asAi = (url, method, body) => kit.call(kit.aiToken(active), url, method, body);
    const accepting = (await asAi('/api/cards', 'POST', { requestId: 'review-example', project: pj, title: '驗收專案首頁', ownerId: active, status: '進行中' })).body;
    assert.equal((await asAi('/api/cards/' + accepting.cardId, 'PATCH', { version: accepting.version, status: '待確認', waitForId: owner })).status, 200);
    assert.ok((await call('/api/cards', 'POST', { requestId: 'my-example', project: pj, title: '整理專案說明', ownerId: owner, status: '進行中' })).body.cardId);
    for (const [i, text] of ['請回覆首頁驗證時段', '[需確認] 首頁要採用哪一版？\n選項：\nA. 精簡版\nB. 完整版'].entries()) {
      const sent = await asAi('/api/messages', 'POST', { project: pj, requestId: 'example-' + i, text, recipientIds: [owner], ...(i ? { replyFrom: [owner] } : {}) });
      assert.ok(sent.body.messageId, JSON.stringify(sent.body));
    }
    const ui = await kit.browser();
    await ui.login(human.token, '/');
    const waitFor = (selector) =>
      until(() => ui.js('!!document.querySelector(' + JSON.stringify(selector) + ')'), 15000, selector);
    const take = async (name, width) => {
      if (!process.env.AIGILE_SCREENSHOTS) return;
      const result = await ui.cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        path.join(process.env.AIGILE_SCREENSHOTS, name + '-' + width + '.png'),
        Buffer.from(result.result.data, 'base64')
      );
    };
    for (const width of [1280, 375]) {
      await ui.cdp('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await ui.cdp('Page.navigate', { url: kit.BASE + '/' });
      await waitFor('.project-entry');
      if (await ui.js('!!document.querySelector(".ob-toggle[aria-expanded=true]")')) {
        await ui.js('document.querySelector(".ob-toggle").click()');
        await waitFor('.ob.collapsed');
      }
      assert.equal(await ui.js('getComputedStyle(document.querySelector(".project-grid")).gridTemplateColumns.split(" ").length'), width === 375 ? 1 : 3);
      assert.equal(await ui.js('document.querySelectorAll(".hub-metrics strong").length'), 3);
      await take('projects', width);
      const starredBefore = await ui.js('document.querySelector(".project-star").getAttribute("aria-pressed")');
      await ui.js('document.querySelector(".project-star").click()');
      await until(
        () =>
          ui.js(
            'document.querySelector(".project-star").getAttribute("aria-pressed") !== ' + JSON.stringify(starredBefore)
          ),
        10000,
        '個人星號'
      );
      await ui.js('document.querySelector(".project-star").click()');
      await until(
        () =>
          ui.js(
            'document.querySelector(".project-star").getAttribute("aria-pressed") === ' + JSON.stringify(starredBefore)
          ),
        10000,
        '恢復星號'
      );
      for (const tab of ['needs', 'mine', 'projects']) {
        await ui.js('document.querySelector(\'[data-hub-choice="tab"][data-value="' + tab + '"]\').click()');
        if (tab === 'needs') {
          for (const label of ['要你決定', '要你回覆', '等你驗收'])
            await until(() => ui.js('Array.from(document.querySelectorAll(".hub-needs h3")).some(h=>h.textContent===' + JSON.stringify(label) + ')'), 8000, label);
        }
        if (tab === 'mine') assert.ok(await ui.js('document.querySelector(".project-page").textContent.includes("整理專案說明")'));
        if (tab !== 'projects') {
          assert.ok(await ui.js('!!document.querySelector(".hub-side")'));
          await take(tab, width);
        }
        assert.equal(
          await ui.js('document.querySelector(\'[data-hub-choice="tab"][aria-pressed="true"]\').dataset.value'),
          tab
        );
      }
      await ui.js('document.querySelector(".project-entry").click()');
      await ui.js('document.querySelector(\'[data-nav="team"]\').click()');
      await waitFor('[data-team-search]');
      assert.ok(await ui.js('document.querySelector(".project-page").textContent.includes("在用的成員")'));
      assert.ok(await ui.js('document.querySelector(".project-alerts").textContent.includes("訊息還沒看")'));
      assert.ok(
        await ui.js(
          'document.querySelector(".project-page").scrollWidth <= document.querySelector(".project-page").clientWidth+1'
        )
      );
      await take('team', width);
      const detail = '.project-member[data-tm-id="' + active + '"]';
      for (const [name, selector] of [['team-detail', detail], ['team-inactive', '.inactive-members']]) {
        await ui.js('(()=>{const d=document.querySelector(' + JSON.stringify(selector) + ');d.open=true;d.scrollIntoView({block:"center"})})()');
        if (name === 'team-detail') {
          const panel = 'document.querySelector(' + JSON.stringify(selector + ' section') + ')';
          const detailText = await ui.js(panel + '.textContent');
          for (const label of ['手上的待辦：沒有', '連線：', '還沒看的訊息：', '最早一則', 'Token：', '到期', '所屬：'])
            assert.ok(detailText.includes(label), detailText);
          assert.equal(await ui.js(panel + '.querySelector("[data-team-mention]").textContent'), '@ 提及');
        }
        await take(name, width);
      }
      await ui.js('document.querySelector(\'[data-nav="overview"]\').click()');
      await waitFor('.overview-chart');
      assert.equal(await ui.js('document.querySelectorAll(".overview-chart>div").length'), 7);
      await take('overview', width);
      await ui.js('localStorage.setItem("aigile-lang","en")');
      await ui.cdp('Page.navigate', { url: kit.BASE + '/' });
      await waitFor('.project-entry');
      await take('en-home', width);
      await ui.js('document.querySelector(".project-entry").click()');
      for (const [page, marker] of [['team', '[data-team-search]'], ['overview', '.overview-chart']]) {
        await ui.js('document.querySelector(\'[data-nav="' + page + '"]\').click()');
        await waitFor(marker);
        assert.ok(await ui.js('document.querySelector(".project-page").textContent.includes(' + JSON.stringify(page === 'team' ? 'Needs attention' : 'Last 7 days') + ')'));
        const heading = page === 'team' ? '.work-title span' : 'h2';
        assert.ok(await ui.js('document.querySelector(' + JSON.stringify('.project-page ' + heading) + ').textContent.includes("Default project")'));
        await take('en-' + page, width);
      }
      await ui.js('localStorage.setItem("aigile-lang","zh")');
    }
    await ui.login(other.token, '/');
    for (const width of [1280,375]) {
      await ui.cdp('Emulation.setDeviceMetricsOverride', { width, height:800, deviceScaleFactor:1, mobile:false });
      await waitFor('.hub-metrics');
      await ui.js('document.querySelector(".hub-metrics [data-value=needs]").click()');
      await waitFor('.hub-empty');
      assert.equal(await ui.js('document.querySelector(".hub-metrics [data-value=needs] strong").textContent'), '0');
      await take('empty', width);
      await ui.js('document.querySelector(".hub-empty [data-value=mine]").click()');
      await waitFor('.hub-metrics [data-value=mine][aria-pressed=true]');
    }
    console.log('project-overview: passed API and desktop/mobile browser checks');
  }
} finally {
  await kit.stop();
}
