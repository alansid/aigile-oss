import './test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { findBrowser, startKit, until } from './browser-kit.js';

if (!findBrowser()) { console.log('Skipped: no browser'); process.exit(0); }
const kit = await startKit('review-changes');
const project = '預設專案', route = '/p/main';
try {
  const human = (await kit.call(null,'/api/join','POST',{name:'劉昱志',role:'PO'})).body;
  async function call(url,body,token=human.token,method='POST') {
    const result = await kit.call(token,url,method,body);
    assert.ok(result.status < 300,JSON.stringify(result.body)); return result.body;
  }
  const pg = await call('/api/my-ais',{projects:[project],roleKey:'PG',role:'程式開發',name:'示範開發',duties:'test',style:'test',autonomy:'test',mustConfirm:'test',handoff:'test'});
  const settings = '/api/projects/'+encodeURIComponent(project)+'/review-settings';
  await call(settings,{diffUpload:true,who:'any',cards:'all',need:1,needHuman:false,notOwner:false,differ:'any'},human.token,'PUT');
  const card = await call('/api/cards',{project,title:'範例：匯出報表加入日期篩選',ownerId:pg.participantId,requestId:'fixture-card'},pg.token);
  const version='ab12cd3'.padEnd(40,'e');
  const tests=['date-range','export-name','empty-range','locale'].map(name=>({name,passed:true}));
  const apiCard='/api/cards/'+card.cardId;
  const sent=await call(apiCard+'/review-request',{version,note:'確認匯出報表的起訖日期與檔名。',tests,reviewerId:human.participant.participantId},pg.token);
  const round=sent.messageId;
  const seq=kit.get('SELECT seq FROM cards WHERE title=?','範例：匯出報表加入日期篩選').seq;
  const repositories=['platform','oss'].map(name=>({origin:'https://github.com/example/'+name,fingerprint:version}));
  const names=['reports/date-range.txt','reports/export-name.txt','samples/dates.csv','docs/export.md'];
  const lines=['@@ -8,3 +8,4 @@',' Report period','-End: Friday','+End: Sunday','+Timezone: local',' Total','@@ -25 +26 @@','-Daily summary','+Weekly summary'];
  const files=repositories.flatMap(({origin})=>names.map((name,i)=>({origin,name,status:i===2?'A':'M',added:i===2?2:3,removed:i===2?0:2,totalLines:i===2?3:9})));
  const baseManifest={version,base:'c49d21b'.padEnd(40,'a'),files,repositories,contentAllowed:true};
  const setManifest = m=>kit.sql('INSERT OR REPLACE INTO review_change_sets(card_seq,round_id,version,manifest) VALUES(?,?,?,?)',seq,round,version,JSON.stringify(m));
  setManifest(baseManifest);
  const comment = kit.get("SELECT comment FROM card_reviews WHERE message_id=? AND ev='request'",round).comment;
  const saved = JSON.parse(comment.slice(1));
  saved.summary={files:files.length,added:22,removed:12,repositories:repositories.map(repo=>({...repo,files:4,added:11,removed:6}))};
  kit.sql("UPDATE card_reviews SET comment=? WHERE message_id=? AND ev='request'",'\x1e'+JSON.stringify(saved),round);
  files.forEach((f,i)=>kit.sql('INSERT INTO review_change_parts(card_seq,round_id,file_index,part,lines,expires_at) VALUES(?,?,?,?,?,?)',seq,round,i,0,JSON.stringify(f.status==='A'?['@@ -0,0 +1,2 @@','+Sunday','+Monday']:lines),Date.now()+3600000));
  const {js,login,key,cdp}=await kit.browser(1280,850);
  const size=(width,height)=>cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
  await size(1280,850);
  const ready=sel=>until(()=>js('!!document.querySelector('+JSON.stringify(sel)+')'),10000,sel);
  const click=sel=>js('document.querySelector('+JSON.stringify(sel)+').click();true');
  async function capture(name) {
    const dir=process.env.REVIEW_CHANGE_SHOTS;
    if (!dir) return;
    fs.mkdirSync(dir,{recursive:true});
    const pic=await cdp('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from(pic.result.data,'base64'));
  }
  async function dialog(selector='.cc-review') {
    await login(human.token,route+'/messages#diff/'+card.cardId+'/'+round);await ready(selector);
  }
  async function cardView() {
    await login(human.token,route+'/work');
    const button='[data-card="'+card.cardId+'"]';await ready(button);await click(button);await ready('[data-rv-card]');await js("document.querySelector('[data-rv-card]').scrollIntoView({block:'center'});true");
  }
  await login(human.token,route+'/inbox');await ready('[data-rv-open]');
  await capture('03-inbox');
  await call(apiCard+'/review',{version,roundId:round,result:'pass',comment:'日期邊界與檔名都有涵蓋，月底及空資料的測試通過。'});
  await dialog('.change-patch');await capture('01-zh-unified');
  await click('.cc-modes [data-split=true]');assert.equal(await js("document.querySelector('.change-patch tr:last-child').children.length"),4);
  await capture('02-zh-split');
  await click('.cc-tabs button:nth-child(2)');assert.ok(await js("document.querySelector('.cc-tabs button:nth-child(2)').getAttribute('aria-pressed')==='true'"));
  await capture('04-read-only');
  if (fs.existsSync('public/i18n/en.js')) {
    await js("localStorage.setItem('aigile-lang','en');true");await dialog('.change-patch');await capture('01-en-unified');
    await js("localStorage.removeItem('aigile-lang');true");
  }
  for (const [name,extra] of [['local',{source:'local'}],['expired',{expiresAt:Date.now()-1000}],['summary',{contentAllowed:false}],['file-limit',{files:files.map((f,i)=>i===0?{...f,truncated:true,totalLines:740}:f)}],['size-limit',{byteLimit:true}]]) {
    setManifest({...baseManifest,...extra});await dialog();await capture('05-'+name);
  }
  // A separate history row with no saved changes represents an older submission.
  const oldId='msg_older';
  kit.sql('INSERT INTO card_reviews(id,card_seq,project,ev,version,actor_id,message_id,at,is_code) VALUES(?,?,?,?,?,?,?,?,?)','rv_older',seq,project,'request',version,pg.participantId,oldId,'2025-01-01',1);
  await login(human.token,route+'/messages#diff/'+card.cardId+'/'+oldId);await ready('.cc-review');await capture('05-older-tool');
  setManifest(baseManifest);
  await cardView();await capture('06-card');
  const ask=await call('/api/messages',{project,cardId:card.cardId,text:'[需確認] '+card.cardId+' 請同意 commit '+version,replyFrom:[human.participant.participantId],recipientIds:[human.participant.participantId],requestId:'fixture-ask'},pg.token);
  const messageId=ask.messageId;
  await login(human.token,route+'/messages');
  const link='[data-change-message="'+messageId+'"]';
  if (!(await js('!!document.querySelector('+JSON.stringify(link)+')'))) {
    const compact='#msg-'+messageId+' [data-open-msg]'; if(await js('!!document.querySelector('+JSON.stringify(compact)+')')) await click(compact);
  }
  await ready(link);
  await js('document.querySelector('+JSON.stringify(link)+').closest(".auth-box").scrollIntoView({block:"center",behavior:"instant"});true');
  await until(()=>js('document.querySelector('+JSON.stringify(link)+').getBoundingClientRect().bottom < innerHeight'),3000,'approval entry in viewport');
  await capture('07-message');await click(link);
  await ready('.cc-ask [data-auth=commit]');await capture('08-approval');
  await click('.cc-ask [data-auth=commit]');await ready('.cc-ask [data-auth-send]');await capture('09-confirm');
  await click('.cc-ask [data-auth-send]');await ready('.cc-approved');await capture('10-approved');
  await key('Escape');
  const wrong=await call('/api/messages',{project,cardId:card.cardId,text:'[需確認] '+card.cardId+' 請同意 commit，版本：'+('c'.repeat(40)),replyFrom:[human.participant.participantId],recipientIds:[human.participant.participantId],requestId:'fixture-wrong'},pg.token);
  await login(human.token,route+'/messages');
  const wrongLink='[data-change-message="'+wrong.messageId+'"]';await ready(wrongLink);await click(wrongLink);
  await ready('.cc-mismatch');await ready('.change-banner.ok');await capture('11-mismatch');
  if (fs.existsSync('public/i18n/en.js')) {
    await js("localStorage.setItem('aigile-lang','en');true");
    await login(human.token,route+'/messages');await ready(wrongLink);await click(wrongLink);await ready('.cc-mismatch');
    await capture('11-en-mismatch');await js("localStorage.removeItem('aigile-lang');true");
  }
  await key('Escape');await size(375,812);await cardView();await ready('.change-mobile');await capture('12-mobile');
  assert.equal(await js("getComputedStyle(document.querySelector('[data-rv-card] .change-link')).display"),'none');
  console.log('Review changes desktop, mobile, repositories, limits and approval flows passed');
} finally { await kit.stop(); }
