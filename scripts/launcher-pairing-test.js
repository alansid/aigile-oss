import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startKit, until } from './browser-kit.js';

const kit = await startKit('launcher-pairing');
try {
  const owner = (await kit.call(null, '/api/join', 'POST', {name:'Owner',role:'PO'})).body;
  const call = async (token, route, method, body) => {
    const response = await kit.call(token, route, method, body);
    assert.ok(response.status < 300, route + ': ' + response.status + ' ' + (response.body?.error?.message || ''));
    return response.body;
  };
  const create = name => call(owner.token, '/api/my-ais', 'POST', {projects:['預設專案'],roleKey:'PG',role:'PG',name,duties:'test',style:'test',autonomy:'test',mustConfirm:'test',handoff:'test'});
  const first = await create('DemoOne'), second = await create('DemoTwo');
  const secret = randomUUID(), folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aigile-fixture-work-')));
  const {code} = await call(null,'/api/launcher/browser-request','POST',{secret,name:'Demo laptop',platform:'win32',folder});
  const {js,cdp,login} = await kit.browser(1280,900);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('aigile-lang','en')"});
  await login(owner.token,'/my-ai');
  const selector = '[data-act="local-launch"][data-id="'+first.participantId+'"]';
  await until(()=>js('!!document.querySelector('+JSON.stringify(selector)+')'),10000,'launcher row');
  await js('document.querySelector('+JSON.stringify(selector)+').click()');
  await until(()=>js('!!document.querySelector(".ma-launch-dialog[open]")'));
  const screenshot = async name => {
    if (!process.env.LAUNCHER_SHOTS) return;
    fs.mkdirSync(process.env.LAUNCHER_SHOTS,{recursive:true});
    const shot = await cdp('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(process.env.LAUNCHER_SHOTS,name+'.png'),Buffer.from(shot.result.data,'base64'));
  };
  const preview = value => js('(()=>{const x=document.querySelector("[name=pairCode]"); x.value='+JSON.stringify(value)+'; x.dispatchEvent(new Event("input")); document.querySelector("[data-preview]").click()})()');
  assert.ok(await js('document.querySelector(".ma-launch-dialog [type=submit]").disabled'));
  await js('document.querySelector("[name=tool]").value="codex"');
  await preview(code === '00000000' ? '00000001' : '00000000');
  await until(()=>js('document.querySelector("[data-code-error]").textContent.length>0'));
  assert.equal(await js('document.querySelector("[name=tool]").value'),'codex');
  await screenshot('wrong-code');
  const expired = await call(null,'/api/launcher/browser-request','POST',{secret:randomUUID(),name:'Expired fixture',platform:'win32',folder});
  kit.sql('UPDATE launcher_browser_requests SET created_at=0 WHERE name=?','Expired fixture');
  await preview(expired.code);
  await until(()=>js('document.querySelector("[data-code-error]").textContent.length>0'));
  await screenshot('expired-code');
  await preview(code);
  await until(()=>js('document.querySelector("[data-detail]")?.textContent.includes("Demo laptop")'));
  await js('document.querySelector(".ma-launch-dialog [name=tool]").value="codex"');
  for (const width of [1280,375]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'));
    assert.ok(await js('document.querySelector(".ma-launch-dialog").scrollWidth <= document.querySelector(".ma-launch-dialog").clientWidth + 1'));
    assert.ok(await js('document.querySelector(".ma-launch-dialog footer").getBoundingClientRect().bottom <= innerHeight+1'));
    if (process.env.LAUNCHER_SHOTS) {
      fs.mkdirSync(process.env.LAUNCHER_SHOTS,{recursive:true});
      const shot = await cdp('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(process.env.LAUNCHER_SHOTS,'pair-'+width+'.png'),Buffer.from(shot.result.data,'base64'));
    }
  }
  await js('document.querySelector(".ma-launch-dialog form").requestSubmit()');
  await until(()=>js('!document.querySelector(".ma-launch-dialog")'));
  const ticket = await call(null,'/api/launcher/browser-result','POST',{secret});
  const device = await call(null,'/api/launcher/pair','POST',{secret,code:ticket.code,name:'Demo laptop',platform:'win32',workspace:folder});
  const state = await call(owner.token,'/api/launcher');
  assert.deepEqual(state.launchers[0].folders,[folder]);
  assert.equal(state.ais[first.participantId].launcherId,device.launcherId);
  await call(owner.token,'/api/my-ais/'+second.participantId+'/launch','POST',{launcherId:device.launcherId,folder,tool:'claude'});
  await call(owner.token,'/api/ai-tools/transport','PUT',{transport:'rest'});
  const poll = await call(device.token,'/api/launcher/poll');
  assert.equal(new Set(poll.jobs.map(j=>j.aiId)).size,2);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-fixture-device-'));
  const config = path.join(localRoot, 'device');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({base:kit.BASE, token:device.token}));
  const pkg = path.resolve(process.env.LAUNCHER_CLI_DIR || 'packages/aigile-launcher');
  execFileSync(process.execPath,[path.join(pkg,'scripts/pack-runtime.mjs')]);
  const localJob = poll.jobs.find(j => j.aiId === second.participantId);
  const env = {...process.env,AIGILE_HOME:localRoot,CODEX_HOME:localRoot,AIGILE_LAUNCHER_HOME:config};
  await promisify(execFile)(process.execPath,[path.join(pkg,'bin/aigile-launcher.mjs'),'add'],{cwd:folder,env});
  const {executeLaunchJob} = await import(pathToFileURL(path.join(pkg,'src/launcher-core.js')).href);
  const rejected = await executeLaunchJob(localJob,{home:config,base:kit.BASE,token:device.token,
    fetchFn:async url => url.endsWith('/api/health') ? Response.json({launcherVersions:{min:'2.0.0',max:'2.0.0'}}) : Response.json({}),
    spawnTerminal:()=>assert.fail('incompatible launcher started')});
  assert.equal(rejected.detail,'launcher_update_required');
  const agentRoot = path.join(folder,'.aigile',localJob.agent);
  fs.mkdirSync(agentRoot,{recursive:true});
  fs.writeFileSync(path.join(agentRoot,'.token'),second.token);
  const legacyEnv = path.join(agentRoot,'watcher.env');
  fs.writeFileSync(legacyEnv,'AIGILE_BASE=https://unrelated.invalid\n');
  let output;
  const launched = await executeLaunchJob(localJob,{home:config,base:kit.BASE,token:device.token,
    spawnTerminal:async spec => {
      assert.equal(spec.cwd,folder);
      assert.equal(spec.args[0],path.join(pkg,'runtime/aigile-start.mjs'));
      await assert.rejects(promisify(execFile)(spec.cmd,[...spec.args,'--no-launch'],{cwd:spec.cwd,env}), err => err.stdout.includes('其他接入身分'));
      fs.writeFileSync(legacyEnv,'AIGILE_BASE='+kit.BASE+'\n');
      output = await promisify(execFile)(spec.cmd,[...spec.args,'--no-launch'],{cwd:spec.cwd,env});
    }});
  assert.equal(launched.status,'opened');
  assert.ok(output.stdout.includes('--no-launch'));
  assert.ok(fs.readFileSync(path.join(agentRoot,'.token'),'utf8').trim() === second.token,'same-origin legacy credential should be retained');
  assert.doesNotMatch(fs.readFileSync(path.join(agentRoot,'onboarding.md'),'utf8'),/下載 .*aigile-setup\.mjs/);
  assert.equal(fs.readFileSync(path.join(folder,'.aigile/watcher/poll.mjs'),'utf8'),fs.readFileSync(path.join(pkg,'runtime/poll.mjs'),'utf8'));
  await call(owner.token,'/api/my-ais/'+second.participantId+'/launcher','DELETE');
  assert.equal((await call(owner.token,'/api/launcher')).ais[first.participantId].registered,true);
  const third = await create('DemoThree');
  const secondSelector = '[data-act="local-launch"][data-id="'+third.participantId+'"]';
  const openSecond = async () => {
    await js('document.querySelector(".ma-launch-dialog")?.close()');
    await cdp('Page.reload');
    await until(()=>js('document.readyState === "complete"'));
    await until(()=>js('!!document.querySelector('+JSON.stringify(secondSelector)+')'));
    await js('document.querySelector('+JSON.stringify(secondSelector)+').click()');
    await until(()=>js('!!document.querySelector(".ma-launch-dialog[open]")'));
  };
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
  await openSecond();
  assert.equal(await js('document.querySelector("[name=tool]").value'),'');
  assert.ok(await js('document.querySelector("[data-token-note]").hidden'));
  await screenshot('registered');
  kit.sql('UPDATE launcher_folders SET folder=? WHERE launcher_id=?','D:/updated',device.launcherId);
  await js('document.querySelector("[name=tool]").value="codex"; document.querySelector(".ma-launch-dialog form").requestSubmit()');
  await until(()=>js('!document.querySelector("[data-folder-warning]").hidden'));
  await screenshot('folder-changed');
  kit.sql('UPDATE launcher_folders SET folder=? WHERE launcher_id=?',folder,device.launcherId);
  const returning = await call(null,'/api/launcher/browser-request','POST',{secret:randomUUID(),name:'Demo laptop',platform:'win32',folder,deviceToken:device.token});
  await js('(()=>{const d=document.querySelector("[name=device]");d.value="";d.dispatchEvent(new Event("change"))})()');
  await preview(returning.code);
  await until(()=>js('!!document.querySelector("[data-detail] p")'));
  await screenshot('returning');
  kit.sql('UPDATE launchers SET last_seen_at = 0 WHERE id = ?',device.launcherId);
  await openSecond();
  await until(()=>js('!document.querySelector(".ma-launch-dialog [data-offline]").hidden'));
  assert.ok(await js('document.querySelector(".ma-launch-dialog [type=submit]").disabled'));
  await screenshot('offline');
  console.log('Launcher browser pairing, shared folder, unbind and responsive layout passed');
} finally { await kit.stop(); }
