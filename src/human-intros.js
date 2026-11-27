const globals = ['business', 'skills', 'decisions', 'contact'];
const saveField = 'INSERT INTO human_intro_fields (participant_id,project,field,value,updated_by,updated_at) ';
const onConflict = ' ON CONFLICT(participant_id,project,field) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at';

export function registerHumanIntros({ route, db, readJson, invalid, requireHuman, assertWritable, projectsOf, nowIso, peopleMap, adminOf, loadLeaders, randId, ApiError, readRole, loadProjectRoles, projEvent, invalidatePeople }) {
  async function access({me,ctx,params}) {
    const people = await peopleMap(ctx);
    const target = params?.id ? people.get(params.id) : me;
    const self = target?.id === me.id;
    const admin = adminOf(people)?.id === me.id;
    const projects = target ? projectsOf(target).filter(p => self || admin || projectsOf(me).includes(p)) : [];
    if (target?.kind !== 'human' || (!self && !admin && !projects.length)) throw new ApiError(404,'NOT_FOUND','Introduction unavailable');
    const leaders = await loadLeaders(true);
    const writable = me.kind === 'human' ? projects.filter(p => self || admin || leaders[p]?.includes(me.id)) : [];
    return {target,self,projects,writable,canEdit:me.kind === 'human' && (self || admin)};
  }
  async function profile(args) {
    const {target,self,projects,writable,canEdit} = await access(args);
    const rows = await db.all('SELECT project,field,value,updated_by,updated_at FROM human_intro_fields WHERE participant_id=? ORDER BY updated_at DESC',target.id);
    const people = await peopleMap(args.ctx);
    const fields = rows.filter(r => !r.project || projects.includes(r.project)).map(r => ({...r,updatedByName:people.get(r.updated_by)?.name || ''}));
    const suggestions = self ? (await db.all('SELECT id,project,field,value,reason,proposed_by FROM human_intro_suggestions WHERE participant_id=? AND resolved_at IS NULL ORDER BY created_at',target.id)).filter(r => !r.project || projects.includes(r.project)).map(r => ({...r, proposerName:people.get(r.proposed_by)?.name || 'AI'})) : [];
    return {fields,projects,writable,canEdit,suggestions,untrusted_content:['fields.value','suggestions.value','suggestions.reason','suggestions.proposerName']};
  }
  function validate(edit,projects) {
    const {project='',field,value} = edit || {};
    if (typeof project !== 'string' || (project ? !projects.includes(project) || field !== 'responsibility' : !globals.includes(field))) throw invalid('Invalid intro field');
    if (typeof value !== 'string' || Array.from(value).length > 200) throw invalid('Maximum 200 characters per field');
    return {project,field,value:value.trim()};
  }
  async function update(args) {
    const {me,req} = args;
    requireHuman(me);
    const {target,self,writable,canEdit} = await access(args);
    if (!canEdit) throw new ApiError(403,'FORBIDDEN','Cannot edit introduction');
    const {edits} = await readJson(req);
    if (!Array.isArray(edits) || edits.length > writable.length + globals.length) throw invalid('Invalid intro fields');
    const writes = [], seen = new Set(), at = nowIso();
    for (const raw of edits) {
      const {project,field,value} = validate(raw,[]);
      const key = JSON.stringify([project,field]);
      if (seen.has(key)) throw invalid('Duplicate field');
      seen.add(key);
      await assertWritable(me,project || null);
      writes.push([saveField+'VALUES (?,?,?,?,?,?)'+onConflict,[target.id,project,field,value,me.id,at]]);
    }
    if (!self && writes.length) {
      const id = randId('intro'), notificationId = randId('notif');
      writes.push(['INSERT INTO notifications (id,recipient_id,message_id,reasons,created_at) VALUES (?,?,?,?,?)',[notificationId,target.id,id,'["profileIntro"]',at]],
        ['INSERT INTO human_intro_profile_notices (notification_id,author_id) VALUES (?,?)',[notificationId,me.id]]);
    }
    if (writes.length) await db.batch(writes);
    return profile(args);
  }
  route('GET','/api/projects/:project/member-intros',async ({ctx,me,params}) => {
    const project = params.project, people = await peopleMap(ctx);
    const admin = adminOf(people)?.id === me.id;
    if (!admin && !projectsOf(me).includes(project)) throw new ApiError(403,'FORBIDDEN','Project membership required');
    const leaders = await loadLeaders(true), roles = await loadProjectRoles(true);
    const rows = await db.all("SELECT participant_id,value,updated_by,updated_at FROM human_intro_fields WHERE project=? AND field='responsibility'",project);
    const details = new Map(rows.map(r => [r.participant_id,r]));
    const members = [...people.values()].filter(p => p.kind !== 'system' && p.status === 'active' && projectsOf(p).includes(project)).map(p => {
      const row = details.get(p.id);
      return {id:p.id,name:p.name,kind:p.kind,role:p.kind === 'ai' ? p.role : (roles[p.id]?.[project] ?? ''),responsibility:row?.value || '',
        updatedAt:row?.updated_at,updatedBy:people.get(row?.updated_by)?.name,updatedByOther:!!row && row.updated_by !== p.id,
        canEdit:me.kind === 'human' && (admin || p.id === me.id || leaders[project]?.includes(me.id))};
    });
    const leaderNames = (leaders[project] || []).map(id => members.find(m => m.id === id)?.name).filter(Boolean);
    return {members,leaderNames,untrusted_content:['leaderNames','members.name','members.role','members.responsibility','members.updatedBy']};
  });
  route('PATCH','/api/projects/:project/member-intros/:id',async args => {
    requireHuman(args.me);
    const {project,id:targetId} = args.params, people = await peopleMap(args.ctx), target = people.get(targetId);
    const self = targetId === args.me.id, admin = adminOf(people)?.id === args.me.id, leaders = await loadLeaders(true);
    if (!target || target.kind === 'system' || target.status !== 'active' || !projectsOf(target).includes(project) ||
        !(admin || (projectsOf(args.me).includes(project) && (self || leaders[project]?.includes(args.me.id))))) throw new ApiError(403,'FORBIDDEN','Cannot edit this project');
    await assertWritable(args.me,project);
    const body = await readJson(args.req);
    if (typeof body.role !== 'string') throw invalid('Role required');
    const role = target.kind === 'ai' ? target.role : readRole(body.role);
    if (target.kind === 'ai' && body.role !== role) throw invalid('AI role is read-only');
    await loadProjectRoles(true);
    const raw = (await db.get("SELECT value FROM app_settings WHERE key='project_roles'")).value;
    const roles = JSON.parse(raw), before = target.kind === 'ai' ? target.role : (roles[target.id]?.[project] ?? '');
    const previous = await db.get("SELECT value FROM human_intro_fields WHERE participant_id=? AND project=? AND field='responsibility'",target.id,project);
    const {value} = validate({project,field:'responsibility',value:body.responsibility === undefined ? (previous?.value || '') : body.responsibility},[project]);
    if (before === role && (previous?.value || '') === value) return {ok:true};
    const at = nowIso(), writes = [];
    if (before !== role) {
      roles[target.id] = {...roles[target.id],[project]:role};
      // Roll back the entire batch on a concurrent role change (value is NOT NULL).
      writes.push(["UPDATE app_settings SET value=CASE WHEN value=? THEN ? ELSE NULL END WHERE key='project_roles'",[raw,JSON.stringify(roles)]],
        projEvent(project,args.me.id,args.me.name+' 更新 '+target.name+' 的專案角色：'+role,at));
    }
    writes.push([saveField+'VALUES (?,?,?,?,?,?)'+onConflict,[target.id,project,'responsibility',value,args.me.id,at]]);
    if (!self) {
      const id = randId('msg');
      writes.push(['INSERT INTO messages (id,author_id,text,project,created_at) VALUES (?,?,?,?,?)',[id,args.me.id,'[通知] 已更新 '+target.name+' 的專案角色與分工',project,at]],
        ['INSERT INTO notifications (id,recipient_id,message_id,reasons,created_at) VALUES (?,?,?,?,?)',[randId('notif'),target.id,id,'["mention","memberRole"]',at]],
        ['INSERT INTO human_intro_notices (message_id,new_role,new_responsibility) VALUES (?,?,?)',
          [id,before !== role ? role : null,(previous?.value || '') !== value ? value : null]]);
    }
    try { await db.batch(writes); } catch (err) {
      if (/not.null/i.test(String(err)) && before !== role) throw new ApiError(409,'CONFLICT','Project roles changed. Reopen and retry.');
      throw err;
    }
    await loadProjectRoles(true);
    invalidatePeople();
    return {ok:true};
  });
  for (const path of ['/api/me/intro','/api/participants/:id/intro']) {
    route('GET',path,profile);
    route('PATCH',path,update);
  }
  route('POST','/api/participants/:id/intro/suggestions',async args => {
    if (args.me.kind !== 'ai') throw invalid('AI only');
    const {target,projects} = await access(args);
    const body = await readJson(args.req);
    const {field,value,project} = validate(body,projects);
    const reason = body.reason ?? '';
    if (typeof reason !== 'string' || Array.from(reason).length > 200) throw invalid('Maximum 200 characters for suggestion reason');
    await assertWritable(args.me,project || null);
    const id = randId('intro');
    await db.run('INSERT INTO human_intro_suggestions (id,participant_id,proposed_by,project,field,value,reason,created_at) VALUES (?,?,?,?,?,?,?,?)',id,target.id,args.me.id,project,field,value,reason.trim(),nowIso());
    return {id};
  });
  route('POST','/api/me/intro/suggestions/:id',async ({me,req,params}) => {
    requireHuman(me);
    const {resolution} = await readJson(req);
    if (!['accept','reject'].includes(resolution)) throw invalid('Invalid resolution');
    const r = await db.get('SELECT * FROM human_intro_suggestions WHERE id=? AND participant_id=? AND resolved_at IS NULL',params.id,me.id);
    if (!r || (r.project && !projectsOf(me).includes(r.project))) throw invalid('Suggestion unavailable');
    await assertWritable(me,r.project || null);
    const at = nowIso(), writes = [];
    if (resolution === 'accept') writes.push([saveField+'SELECT participant_id,project,field,value,?,? FROM human_intro_suggestions WHERE id=? AND participant_id=? AND resolved_at IS NULL'+onConflict,[me.id,at,r.id,me.id]]);
    writes.push(['UPDATE human_intro_suggestions SET resolved_at=?, resolution=? WHERE id=? AND participant_id=? AND resolved_at IS NULL',[at,resolution,r.id,me.id]]);
    await db.batch(writes);
    return {ok:true};
  });
  return async function summaries(me,people,project) {
    const visible = new Map(), mine = projectsOf(me), admin = adminOf(people)?.id === me.id;
    for (const p of people.values()) {
      if (p.kind !== 'human') continue;
      const shared = projectsOf(p).filter(k => admin || mine.includes(k));
      if ((admin || p.id === me.id || shared.length) && (!project || shared.includes(project))) visible.set(p.id,'');
    }
    if (visible.size) {
      const rows = await db.all("SELECT participant_id,value FROM human_intro_fields WHERE participant_id IN (SELECT value FROM json_each(?)) AND (project='' OR project=?) AND value<>'' ORDER BY project DESC, CASE field WHEN 'business' THEN 1 WHEN 'skills' THEN 2 WHEN 'decisions' THEN 3 ELSE 4 END",JSON.stringify([...visible.keys()]),project || '');
      for (const r of rows) visible.set(r.participant_id,Array.from([visible.get(r.participant_id),r.value].filter(Boolean).join(' · ')).slice(0,150).join(''));
    }
    return visible;
  };
}
