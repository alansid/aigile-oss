import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit,until } from './browser-kit.js';
const kit = await startKit('intro-ui');
try {
  const user = (await kit.call(null,'/api/join','POST',{name:'DemoMemberWithALongDisplayName',role:'PO'})).body;
  const {js,cdp,login} = await kit.browser();
  const reader = (await kit.call(null,'/api/join','POST',{name:'DemoReader',role:'QA'})).body;
  const project = user.participant.projects[0];
  const lead = (await kit.call(null,'/api/join','POST',{name:'DemoLead',role:'PO'})).body;
  assert.equal((await kit.call(user.token,'/api/members/matrix','PUT',{changes:[{id:reader.participant.participantId,projects:[project]},{id:lead.participant.participantId,projects:[project]}]})).status,200);
  kit.sql("INSERT INTO app_settings(key,value) VALUES ('project_leaders',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({[project]:[lead.participant.participantId]}));
  assert.equal((await kit.call(user.token,'/api/participants/'+user.participant.participantId+'/project-roles','PUT',{roles:{[project]:'PO'}})).status,200);
  await kit.call(user.token,'/api/my-ais','POST',{projects:[project],roleKey:'PG',role:'Designer',name:'UX',duties:'demo',style:'demo',autonomy:'demo',mustConfirm:'demo',handoff:'demo'});
  const proposer = kit.get("SELECT id FROM participants WHERE name='UX' AND kind='ai'");
  kit.sql('INSERT INTO human_intro_suggestions(id,participant_id,proposed_by,project,field,value,reason,created_at) VALUES (?,?,?,?,?,?,?,?)','intro-test',user.participant.participantId,proposer.id,'','skills','畫面驗收','依據上次驗收回饋',new Date().toISOString());
  async function capture(name) {
    if (!process.env.INTRO_SCREENSHOTS) return;
    fs.mkdirSync(process.env.INTRO_SCREENSHOTS,{recursive:true});
    const png = await cdp('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(process.env.INTRO_SCREENSHOTS,name+'.png'),Buffer.from(png.result.data,'base64'));
  }
  const languages = fs.existsSync(new URL('../public/i18n/en.js',import.meta.url)) ? ['zh','en'] : ['zh'];
  for (const lang of languages) for (const width of [1280,375]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    kit.sql('UPDATE human_intro_suggestions SET value=?,reason=? WHERE id=?',lang==='zh'?'畫面驗收':'Design QA',lang==='zh'?'依據上次驗收回饋':'Based on the last design review','intro-test');
    await login(user.token);
    await js("localStorage.setItem('aigile-lang',"+JSON.stringify(lang)+");localStorage.setItem('aigile-switch-set-tab','me');true");
    await login(user.token);
    await js("document.querySelector('.topbar .av-btn').click()");
    await until(()=>js("!!document.querySelector('#av-menu [data-av=settings]')"));
    await js("document.querySelector('#av-menu [data-av=settings]').click()");
    await until(()=>js("!!document.querySelector('[data-my-intro] textarea')"),8000,'introduction editor');
    assert.equal(await js("document.querySelector('.intro-extra').open"),width>600);
    const samples = lang === 'zh' ? ['測試報表','需求釐清','測試驗收','附上案例','範例專案分工'] : ['Demo reporting','Clarifying requirements','Test acceptance','Include an example','Demo project work'];
    const edits = JSON.stringify(samples);
    await js(`document.querySelectorAll('[data-my-intro] textarea').forEach((t,i)=>{t.value=${edits}[Math.min(i,4)]+' '+${width};t.dispatchEvent(new Event('input'))});document.querySelector('[data-save]').click();true`);
    await until(()=>js("document.querySelector('[data-my-intro] textarea')?.defaultValue.endsWith("+JSON.stringify(String(width))+")"));
    assert.equal((await kit.call(user.token,'/api/me/intro')).body.fields.find(r=>r.field==='skills').value,samples[1]+' '+width);
    await js("document.querySelector('[data-my-intro] h3').scrollIntoView({block:'start'});true");
    const suffix = width+'-'+lang;
    assert.equal(await js("document.querySelectorAll('[data-human] dt').length"),4);
    assert.equal(await js("getComputedStyle(document.querySelector('.intro-extra summary')).display === 'none'"),width>600);
    if (width === 1280) {
      const fields = await js("[...document.querySelectorAll('[data-my-intro] .intro-columns .field')].map(el => el.getBoundingClientRect().toJSON())");
      assert.equal(fields.length, 4);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs((fields[i + 1].top - fields[i].bottom) - 16) <= 1, 'intro field gap ' + i + ': ' + (fields[i + 1].top - fields[i].bottom));
    }
    await capture('PLAT-487-editor-'+suffix);
    assert.ok(await js("document.querySelector('.intro-suggestion').innerText.includes('UX') && document.querySelector('.intro-suggestion').nextElementSibling.matches('.intro-columns')"));
    await capture('PLAT-487-suggestion-'+suffix);
    assert.equal(await js("document.querySelectorAll('[data-my-intro] textarea').length"),4);
    await js("document.querySelector('[data-intro-project]').click()");
    await until(()=>js("!!document.querySelector('[data-edit-row]')"),8000,'members and roles');
    await js("document.querySelector('[data-edit-row]').click()");
    const detail = lang==='zh'?'負責驗收範例':'Reviews demo releases';
    await js(`const form=document.querySelector('.intro-member form'); form.elements.role.value='QA';form.elements.responsibility.value=${JSON.stringify(detail)};form.requestSubmit();true`);
    await until(()=>js("!document.querySelector('.intro-member form') && document.querySelector('[data-role-list]').innerText.includes("+JSON.stringify(detail)+")"));
    await capture('PLAT-487-roles-'+suffix);
    await login(user.token,'/p/main/team');
    await until(()=>js("document.querySelectorAll('[data-team-intro]').length >= 2"),8000,'team members');
    await js("document.querySelectorAll('details.project-member').forEach(r=>r.open=!!r.querySelector('[data-team-intro]'));true");
    await until(()=>js("!!document.querySelector('.intro-read dd')"),8000,'expanded introduction');
    assert.ok(await js("[...document.querySelectorAll('[data-team-mention]')].some(b=>b.textContent.includes('›'))"));
    const labels = await js("[...document.querySelector('.intro-read').querySelectorAll('dt')].map(el=>el.textContent)");
    assert.deepEqual(labels.slice(0,4),lang === 'zh' ? ['懂','擅長','能決定','怎麼問'] : ['Knows','Strengths','Decides','How to ask']);
    assert.equal(await js("document.querySelector('.intro-read').scrollWidth <= document.querySelector('.intro-read').clientWidth"),true);
    if (width === 1280) {
      const tm = await js("(() => { const n = document.querySelector('.project-member summary .tm-name[title=DemoMemberWithALongDisplayName]'); const chip = n?.closest('summary')?.querySelector('.project-chip'); return n && chip ? { overflow: n.scrollWidth > n.clientWidth, ellipsis: getComputedStyle(n).textOverflow === 'ellipsis', nowrap: getComputedStyle(n).whiteSpace === 'nowrap', clear: n.getBoundingClientRect().right <= chip.getBoundingClientRect().left + 1 } : null; })()");
      assert.ok(tm && tm.overflow && tm.ellipsis && tm.nowrap && tm.clear, 'team long name ellipsis: ' + JSON.stringify(tm));
    }
    await js("document.querySelector('.intro-read').scrollIntoView({block:'center'});true");
    await capture('PLAT-487-team-'+suffix);

  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const rowFor = id => '.project-member[data-tm-id="'+id+'"]';
  const readerRow = rowFor(reader.participant.participantId);
  const otherRow = rowFor(user.participant.participantId);
  async function linkVisible(row) {
    return js(`!!document.querySelector(${JSON.stringify(row+' [data-intro-open]')})?.getClientRects().length`);
  }
  await until(()=>linkVisible(readerRow),8000,'admin can edit another profile');
  await login(reader.token,'/p/main/team');
  await until(()=>js("document.querySelectorAll('[data-team-intro]').length >= 2"),8000,'ordinary member team');
  await js("document.querySelectorAll('details.project-member').forEach(r=>r.open=!!r.querySelector('[data-team-intro]'));true");
  await until(()=>js(`!!document.querySelector(${JSON.stringify(otherRow+' .intro-read dd')})`),8000,'other profile loaded for reader');
  assert.equal(await linkVisible(otherRow),false,'ordinary member cannot see edit link on another profile');
  await until(()=>linkVisible(readerRow),8000,'ordinary member can edit own profile');
  await js("document.querySelector('[data-pset]').click()");
  await until(()=>js("!!document.querySelector('[data-pset-act=memberRoles]')"),8000,'project settings entry');
  await capture('PLAT-487-view-gear');
  await js("document.querySelector('[data-pset-act=memberRoles]').click()");
  await until(()=>js("document.querySelectorAll('.intro-member').length >= 2"));
  assert.deepEqual(await js("[...document.querySelectorAll('.intro-member')].filter(s=>s.querySelector('[data-edit-row]')).map(s=>s.querySelector('b').textContent)"),['DemoReader']);
  await capture('PLAT-487-view-member');
  assert.ok(await js("document.querySelector('.role-editors').textContent.includes('DemoLead')"));
  assert.ok(await js("document.querySelector('[data-role-list]').innerText.includes("+JSON.stringify(languages.includes('en')?'Select Edit to add your responsibilities':'還沒寫，按編輯補上')+")"));
  assert.ok(await js(`(() => {
    const headers = [...document.querySelectorAll('.role-list-head b')];
    return [...document.querySelectorAll('.role-row')].every(row => headers.every((h,i)=>Math.abs(h.getBoundingClientRect().left-row.children[i].getBoundingClientRect().left)<1));
  })()`));
  const teamUrl = new URL(await js('location.href')).pathname;
  await login(lead.token,teamUrl);
  await js("document.querySelector('[data-pset]').click()");
  await until(()=>js("!!document.querySelector('[data-pset-act=memberRoles]')"));
  await js("document.querySelector('[data-pset-act=memberRoles]').click()");
  await until(()=>js("!!document.querySelector('[data-edit-row]')"));
  await js("[...document.querySelectorAll('.intro-member')].find(s=>s.querySelector('b').textContent==='DemoReader').querySelector('[data-edit-row]').click();true");
  await js("document.querySelector('.intro-member textarea').value="+JSON.stringify(languages.includes('en')?'Check release notes':'核對版本說明')+";document.querySelector('.intro-member form').requestSubmit();true");
  await until(()=>js("[...document.querySelectorAll('[data-role-history]')].some(e=>e.textContent.includes('DemoLead'))"));
  assert.ok(await js("(()=>{const n=document.querySelector('.role-row b[title=DemoMemberWithALongDisplayName]');return n && n.scrollWidth>n.clientWidth && getComputedStyle(n).textOverflow==='ellipsis' && getComputedStyle(n).whiteSpace==='nowrap'})()"));
  await capture('PLAT-487-view-lead');
  await login(reader.token,teamUrl.replace(/team$/,'inbox'));
  await until(()=>js("!!document.querySelector('[data-role-project] .fyi-text')"),10000,'role update notification');
  const notice = await js("document.querySelector('[data-role-project] .fyi-text').textContent");
  assert.ok(notice.includes('DemoLead') && notice.includes(languages.includes('en') ? "changed what you're responsible for" : '改了你在') && notice.endsWith(languages.includes('en')?'Check release notes':'核對版本說明'),notice);
  await js("document.querySelector('[data-role-project]').scrollIntoView({block:'center'});true");
  await capture('PLAT-487-view-notice');
  await js("document.querySelector('[data-role-project]').click()");
  await until(()=>js("!!document.querySelector('[data-role-list] [data-edit-row]')"),8000,'open members and roles from notice');
  const denied = await kit.call(reader.token,'/api/participants/'+user.participant.participantId+'/intro','PATCH',{edits:[{field:'skills',value:'unauthorized'}]});
  assert.equal(denied.status,403);
  console.log('Introduction editor saved and restored across supported layouts and languages');
} finally { await kit.stop(); }
