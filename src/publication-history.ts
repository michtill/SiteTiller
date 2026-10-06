import {recentConversation} from './memory.ts';
export function closePublishedHistory(config:any,events:any[]){
 const all=config.requests||[],latest=(config.releases||[]).findLast((r:any)=>r.commit===config.publishedCommit);
 if(!config.publishedCommit)return {events,removed:0};
 const publishedTime=latest?.publishedAt?Date.parse(latest.publishedAt):Infinity;
 const matching=all.filter((r:any)=>r.commit===config.publishedCommit&&(!r.createdAt||Date.parse(r.createdAt)<=publishedTime));
 const through=config.publishedThrough??Math.max(0,...matching.map((r:any)=>r.sequence||0));
 config.publishedThrough=through;config.requestSequence=Math.max(config.requestSequence||0,config.reviewedThrough||0,...all.map((r:any)=>r.sequence||0));
 const closed=all.filter((r:any)=>r.sequence<=through),open=all.filter((r:any)=>r.sequence>through);
 if(closed.length){
  const context=recentConversation([...(config.conversationMemory||[]),...closed],config.publishedCommit);
  config.conversationMemory=context.turns.filter((t:any)=>t.applied).map((t:any)=>({id:t.id,sequence:t.sequence,prompt:t.request,resolvedRequest:t.resolvedRequest,status:t.status,scope:t.scope,commit:t.commit,restoredFrom:t.restoredFrom,memory:{summary:t.summary,changedFiles:t.changedFiles,deltas:t.deltas},imageResults:t.images}));
 }
 for(const release of config.releases||[]){if(release.description===undefined)release.description='';if(!release.summary){const record=all.findLast((r:any)=>r.commit===release.commit);release.summary=(record?.memory?.summary||record?.plan?.summary||'').slice(0,1500);}}
 config.requests=open;config.reviewRuns=[];
 const ids=new Set(open.map((r:any)=>r.id));
 const kept=events.filter(e=>ids.has(e.jobId)||e.kind==='publish'&&e.at&&Date.parse(e.at)>publishedTime);
 return {events:kept,removed:closed.length};
}
export function publicationSummary(requests:any[]){return requests.filter(r=>r.status==='ready'||r.status==='legacy').slice(-3).map(r=>r.memory?.summary||r.plan?.summary||r.prompt||'').filter(Boolean).join('\n').slice(0,1500);}
export function visibleVersionHistory(history:any[],config:any){
 const boundary=history.findIndex(h=>h.commit===(config.draftBaseCommit||config.publishedCommit)),published=new Set((config.releases||[]).map((r:any)=>r.commit));
 return history.filter((h,i)=>i===0||published.has(h.commit)||boundary<0||i<boundary);
}
