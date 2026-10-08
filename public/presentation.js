import {t,locale,translateDocument} from './i18n.js';
const phaseNames={orchestrate:t('selecting_capabilities'),design:t('designing'),build:t('implementing'),test:t('checking'),verify:t('checking'),review:t('reviewing')};
function modelFor(events,roles,role){return [...events].reverse().find(e=>e.model)?.model||roles?.[role]?.model||'Model';}
export function compactProgress(events,job=null,busy=false,roles={},requests=[],reviews=[]){
 const groups=[],byId=new Map();let legacy=null;
 for(const [index,event] of events.entries()){
  let group;
  if(event.jobId){group=byId.get(event.jobId);if(!group){group={id:event.jobId,kind:event.kind||(event.stage==='review'?'review':'edit'),events:[]};byId.set(group.id,group);groups.push(group);}legacy=null;}
  else{const solo=['published','restored'].includes(event.stage),starts=(event.stage==='design'||event.stage==='review')&&(event.status==='running'||(!event.status&&event.model));if(solo||!legacy||starts&&event.stage==='design'){legacy={id:'legacy-'+(event.at||index)+'-'+event.stage,kind:solo?event.stage:event.stage==='review'?'review':'edit',events:[]};groups.push(legacy);}group=legacy;}
  group.events.push(event);if(!event.jobId&&['ready','failed','published','restored'].includes(event.stage))legacy=null;
 }
 if(busy&&job?.id&&!byId.has(job.id))groups.push({id:job.id,kind:job.kind||'edit',events:[]});
 const used=new Set();for(const group of groups){const commit=group.events.findLast(e=>e.stage==='ready'||e.stage==='restored')?.commit;const request=requests.find(r=>r.id===group.id)||(['edit','restore','restored'].includes(group.kind)&&commit?requests.findLast(r=>r.commit===commit):null);if(request){group.request=request;used.add(request.id);if(request.progress?.length)group.events=request.progress;}const review=reviews.find(r=>r.id===group.id);if(review?.progress?.length)group.events=review.progress;}
 const archived=requests.filter(r=>!used.has(r.id)).map(request=>({id:request.id,kind:request.restoredFrom?'restore':'edit',request,events:[{stage:'request',message:request.prompt,attachments:request.attachments},...(request.plan?[{stage:'design',status:'completed',plan:request.plan,message:request.plan.summary}]:[]),...(request.tests?[{stage:'test',message:request.tests.analysis?.summary,checks:request.tests.analysis?.checks}]:[]),{stage:request.status==='failed'?'failed':request.status==='running'?'design':'ready',commit:request.commit,message:request.error,agentResponse:!!request.errorFromAgent}]}));
 for(const group of archived)if(group.request.progress?.length)group.events=group.request.progress;
 const archivedReviews=reviews.filter(r=>!groups.some(g=>g.id===r.id)).map(r=>({id:r.id,kind:'review',events:r.progress||[],createdAt:r.createdAt}));
 const all=[...archived,...archivedReviews,...groups];const dated=all.every(g=>g.createdAt||g.request?.createdAt||g.events[0]?.at);if(dated)all.sort((a,b)=>String(a.createdAt||a.request?.createdAt||a.events[0]?.at).localeCompare(String(b.createdAt||b.request?.createdAt||b.events[0]?.at)));
 const ordered=all.filter(g=>g.request).sort((a,b)=>a.request.sequence-b.request.sequence);if(ordered.every(g=>Number.isFinite(g.request.sequence))){let next=0;for(let i=0;i<all.length;i++)if(all[i].request)all[i]=ordered[next++];}
 const publication=all.findLastIndex(g=>g.events.some(e=>e.stage==='published'));if(publication>0)all.unshift(all.splice(publication,1)[0]);
 return all.map(group=>{
  const last=group.events.at(-1),request=group.request,failed=last?.stage==='failed'||job?.id===group.id&&['failed','rejected'].includes(job.status),done=['ready','published','restored'].includes(last?.stage)||failed;
  const row={key:group.id+'-status',running:!done,error:failed,events:group.events};
  if(group.kind==='edit'){const phase=[...group.events].reverse().find(e=>['orchestrate','design','build','test','verify'].includes(e.stage))?.stage||'design';row.label=failed?t('error'):done?t('done'):phase==='test'&&!group.events.some(e=>e.stage==='test'&&e.model)?t('technical_checks'):modelFor(group.events.filter(e=>e.stage===phase),request?.models||roles,({orchestrate:'primary',design:'ui',build:'primary',test:'verify',verify:'verify'})[phase]||phase)+': '+phaseNames[phase];}
  else if(group.kind==='review')row.label=failed?t('review_failed'):done?t('review_complete'):modelFor(group.events,roles,'verify')+': '+t('reviewing');
  else if(group.kind==='publish')row.label=failed?t('publishing_failed'):last?.stage==='published'?(last.release?t('version')+last.release.number+(last.release.minor!==undefined?'.'+last.release.minor:'')+t('published_prefix'):t('published')):t('publishing_label');
  else{row.label=last?.stage==='published'?t('published'):t('version_loaded');row.running=false;}
  return {...group,prompt:request?.prompt||group.events.find(e=>e.stage==='request')?.message||'',baseCommit:request?.baseCommit||group.events.find(e=>e.baseCommit)?.baseCommit,commit:request?.commit||group.events.findLast(e=>e.commit)?.commit,done:done&&!failed,rows:[row]};
 });
}
