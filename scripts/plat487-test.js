import assert from 'node:assert/strict';
import { testToken } from './test-token.js';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const db = openNodeDb(':memory:');
const [a,b] = (await db.all('SELECT id FROM projects ORDER BY created_at,id')).map(r=>r.id);
const app = createApp({db, storage:dbStorage(db),docText:'',config:{openJoin:'1',rateLimitPerMin:'100000'}});
async function call(user,path,method='GET',data) {
  const r = await app(new Request('http://localhost'+path,{method,headers:{'Content-Type':'application/json',...(user && {Authorization:'Bearer '+user.token})},body:data && JSON.stringify(data)}),'http://localhost');
  return {status:r.status,body:await r.json()};
}
async function join(name,projects) {
  const r = await call(null,'/api/join','POST',{name,role:'PO'});
  assert.equal(r.status,201,r.body.error?.message);
  const {participant,token} = r.body;
  await db.run('UPDATE participants SET projects=? WHERE id=?',projects.join(','),participant.participantId);
  return {id:participant.participantId,token};
}
try {
  const admin = await join('TestAdmin',[a]), author = await join('TestProfile',[a,b]), lead = await join('TestLead',[a]), outsider = await join('TestVisitor',[]);
  await db.run("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('project_leaders',?)",JSON.stringify({[a]:[lead.id]}));
  const path = '/api/participants/'+author.id+'/intro';
  const edit = (user,edits) => call(user,path,'PATCH',{edits});
  const fields = [{field:'skills',value:'shared'},{field:'responsibility',project:b,value:'private-project'}];
  const projectPath = p => '/api/projects/'+encodeURIComponent(p)+'/member-intros';
  const assign = (user,p,role,responsibility) => call(user,projectPath(p)+'/'+author.id,'PATCH',{role,responsibility});
  assert.equal((await assign(author,b,'QA','private-project')).status,200);
  const saved = await edit(author,[fields[0]]);
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await call(outsider,path)).status,404);
  assert.equal((await call(lead,path)).body.fields.length,1);
  assert.equal((await call(admin,path)).body.fields.length,2);
  assert.ok((await edit(lead,[fields[1]])).status >= 400);
  assert.equal((await edit(lead,[{field:'contact',value:'ask first'}])).status,403);
  assert.equal((await assign(lead,b,'PG','private-project')).status,403);
  assert.equal((await call(outsider,projectPath(a))).status,403);
  assert.equal((await assign(lead,a,'QA','public-project')).status,200);
  const assignment = (await call(lead,projectPath(a))).body.members.find(m=>m.id===author.id);
  assert.equal(assignment.role,'QA'); assert.equal(assignment.responsibility,'public-project');
  assert.equal(assignment.updatedBy,'TestLead');
  assert.equal((await call(lead,path)).body.canEdit,false);
  assert.ok(await db.get('SELECT id FROM notifications WHERE recipient_id=?',author.id));
  assert.ok((await edit(author,[{field:'skills',value:'超'.repeat(201)}])).status >= 400);
  const bot = await call(lead,'/api/my-ais','POST',{projects:[a],roleKey:'PG',role:'Developer',name:'TestAI',duties:'test',style:'test',autonomy:'test',mustConfirm:'test',handoff:'test'});
  const ai = await db.get("SELECT id,token FROM participants WHERE kind='ai' AND owner_id=?",lead.id);
  assert.ok(ai,bot.body.error?.message);
  ai.token = await testToken(db,ai.id);
  assert.ok((await edit(ai,fields)).status >= 400);
  const aiPath = projectPath(a)+'/'+ai.id;
  const aiRole = (await call(lead,projectPath(a))).body.members.find(m=>m.id===ai.id).role;
  assert.ok((await call(lead,aiPath,'PATCH',{role:'QA',responsibility:'invalid'})).status >= 400);
  assert.equal((await call(lead,aiPath,'PATCH',{role:aiRole,responsibility:'triage'})).status,200);
  assert.equal((await assign(lead,a,'PG')).status,200);
  assert.equal((await call(lead,projectPath(a))).body.members.find(m=>m.id===author.id).responsibility,'public-project');
  assert.equal((await call(admin,'/api/participants/'+outsider.id+'/intro','PATCH',{edits:[fields[0]]})).status,200);
  const notices = async user => (await call(user,'/api/notifications')).body.items;
  const notice = (await notices(outsider)).find(n=>n.reasons.includes('profileIntro'));
  assert.equal(notice?.sender.participantId,admin.id);
  assert.ok(!(await notices(lead)).some(n=>n.messageId===notice.messageId));
  assert.ok(!(await db.get('SELECT id FROM messages WHERE id=?',notice.messageId)));
  const summary = await call(ai,'/api/team-status?project='+encodeURIComponent(a));
  assert.equal(summary.status,200,JSON.stringify(summary.body));
  const intro = summary.body.members.find(m => m.participantId === author.id).intro;
  assert.ok(intro.includes('shared') && !intro.includes('private-project'));
  async function mcp(name,args) {
    const r = await call(ai,'/api/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
    assert.ok(!r.body.result?.isError, r.body.result?.content?.[0]?.text);
    return JSON.parse(r.body.result.content[0].text);
  }
  const team = await mcp('aigile_team',{project:a});
  assert.equal(team.members.find(m => m.participantId === author.id).intro,intro);
  assert.ok(team.untrusted_content.includes('members.intro'));
  assert.equal((await edit(admin,[{field:'skills',value:'shared'}])).status,200);
  const ownIntro = await call(lead,'/api/me/intro','PATCH',{edits:[{field:'skills',value:'owner skills'}]});
  assert.equal(ownIntro.status,200);
  assert.equal((await mcp('aigile_me',{ownerIntro:true})).ownerIntro.find(r=>r.field==='skills').value,'owner skills');
  const s = await call(ai,path+'/suggestions','POST',{field:'skills',value:'new',reason:'test review'});
  assert.equal(s.status,200,JSON.stringify(s.body));
  const profile = (await call(author,path)).body;
  assert.equal(profile.suggestions[0].reason,'test review');
  assert.ok(profile.suggestions[0].proposerName);
  assert.ok(profile.untrusted_content.includes('suggestions.reason'));
  const choice = '/api/me/intro/suggestions/'+s.body.id;
  assert.ok((await call(lead,choice,'POST',{resolution:'accept'})).status >= 400);
  assert.equal((await call(author,path)).body.fields.find(r => r.field==='skills').value,'shared');
  assert.equal((await call(author,choice,'POST',{resolution:'accept'})).status,200);
  assert.equal((await call(author,path)).body.fields.find(r => r.field==='skills').value,'new');
  assert.ok((await call(author,choice,'POST',{resolution:'reject'})).status >= 400);
  console.log('PLAT-487 access, notification, summary and suggestion checks passed');
} finally { db.close(); }
