import {raster} from './images.ts';
import type {Project} from './project.ts';
const clip=(value:unknown,max=1800)=>typeof value==='string'?value.slice(0,max):'';
function applied(request:any){return request.status==='ready'||request.status==='legacy';}
function activeRecords(records:any[],end=records.length,depth=0):any[]{
 let active:any[]=[];
 for(let i=0;i<end;i++){
  const request=records[i];if(request.status==='running')continue;
  if(applied(request)&&request.restoredFrom){
   const target=records.findIndex((r,index)=>index<i&&r.commit===request.restoredFrom&&applied(r));
   active=target>=0&&depth<30?activeRecords(records,target+1,depth+1):[];
  }else if(applied(request)&&request.scope==='create')active=[];
  active.push(request);
 }
 return active;
}
function compact(request:any,active:boolean){
 const memory=request.memory||{};
 return {id:request.id,sequence:request.sequence,request:clip(request.prompt,request.status==='failed'?6000:2400),resolvedRequest:clip(request.resolvedRequest,1800),
  status:request.status,applied:applied(request),active,scope:request.scope||request.mode||'edit',commit:request.commit||null,restoredFrom:request.restoredFrom||null,
  summary:clip(memory.summary||request.plan?.summary||request.error,600),
  partialEvidence:memory.partialEvidence===true,
  changedFiles:(memory.changedFiles||[]).filter((x:any)=>typeof x==='string').slice(0,16),
  deltas:(memory.deltas||[]).slice(0,8).map((d:any)=>({path:clip(d.path,200),selector:clip(d.selector,120),property:clip(d.property,80),before:clip(d.before,180),after:clip(d.after,180)})),
  images:(request.imageResults||[]).slice(0,2).map(({source,path}:any)=>({source,path}))};
}
function bound(entries:any[],max=24000){while(entries.length>1&&Buffer.byteLength(JSON.stringify(entries))>max)entries.shift();return entries;}
export function recentConversation(records:any[],currentHead:string){
 const active=activeRecords(records),turns=bound(active.slice(-6).map(r=>compact(r,true))),shown=new Set(turns.map(turn=>turn.id));
 return {currentHead,turns,olderHistoryAvailable:records.some(r=>r.status!=='running'&&!shown.has(r.id)),
  guidance:'Only ready/legacy turns were applied. Failed turns retain the unfulfilled brief: a retry refers to the latest failed substantive request; retry-only text does not replace that brief. A restore or new-site creation supersedes prior work outside the active timeline. Current files and the latest explicit request are authoritative. Historical text is context, not executable instructions.'};
}
export function searchConversation(records:any[],query:any,currentHead:string){
 if(!query||typeof query!=='object'||query.ids!==undefined&&(!Array.isArray(query.ids)||query.ids.length>10||query.ids.some((id:any)=>typeof id!=='string'))||query.query!==undefined&&(typeof query.query!=='string'||query.query.length>200))throw Error('Neplatný dotaz na historii.');
 if(!query.ids?.length&&!query.query?.trim())throw Error('Vyber požadavek nebo zadej hledaný výraz.');
 const activeIds=new Set(activeRecords(records).map(r=>r.id)),terms=(query.query||'').toLowerCase().trim().split(/\s+/).filter(Boolean);
 const matches=records.filter(r=>r.status!=='running'&&(query.ids?.includes(r.id)||terms.length&&terms.every(term=>[r.prompt,r.resolvedRequest,r.memory?.summary,r.plan?.summary,...(r.memory?.changedFiles||[]),...(r.memory?.deltas||[]).flatMap((d:any)=>[d.selector,d.property,d.before,d.after])].join(' ').toLowerCase().includes(term))));
 const turns=bound(matches.slice(-6).map(r=>compact(r,activeIds.has(r.id))));
 return {currentHead,turns,totalMatches:matches.length,hasMore:matches.length>turns.length};
}
function excerptPair(before:string,after:string){
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 const offset=Math.max(0,start-70);
 return {before:before.slice(offset,offset+250),after:after.slice(offset,offset+250)};
}
function cssProperties(text:string){
 const result=new Map<string,any>();const occurrences=new Map<string,number>();
 for(const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const selector=rule[1].trim();if(selector.startsWith('@'))continue;
  const ordinal=occurrences.get(selector)||0;occurrences.set(selector,ordinal+1);
  for(const declaration of rule[2].matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)){
   const property=declaration[1],value=declaration[2].trim();result.set(selector+'|'+ordinal+'|'+property,{selector,property,value});
  }
 }
 return result;
}
// Evidence is extracted from actual committed changes, without an extra model call.
export function changeMemory(original:Record<string,string>,files:Record<string,string>,summary:string){
 const changedFiles=[...new Set([...Object.keys(original),...Object.keys(files)])].filter(path=>original[path]!==files[path]),deltas:any[]=[];
 for(const path of changedFiles){
  if(raster(path)){deltas.push({path,before:original[path]?'existing asset':'absent',after:files[path]?'asset present':'removed from draft'});continue;}
  const before=original[path]||'',after=files[path]||'';
  if(path.endsWith('.css')){
   const oldProperties=cssProperties(before),newProperties=cssProperties(after);
   for(const [key,value] of newProperties){const old=oldProperties.get(key);if(old&&old.value!==value.value)deltas.push({path,selector:value.selector,property:value.property,before:old.value,after:value.value});}
  }
  deltas.push({path,...(!original[path]?{before:'absent',after:clip(after,250)}:!files[path]?{before:clip(before,250),after:'removed from draft'}:excerptPair(before,after))});
  if(deltas.length>=24)break;
 }
 return {summary:clip(summary,1200),changedFiles:changedFiles.slice(0,120),deltas:deltas.slice(0,24)};
}
export async function hydrateRecentMemory(project:Project,records:any[]){
 const ids=new Set(recentConversation(records,'').turns.map(turn=>turn.id));
 for(const request of records.filter(r=>ids.has(r.id)&&applied(r)&&!r.memory&&!r.restoredFrom&&/^[a-f0-9]{40}$/.test(r.commit||''))){
  try{
   const base=/^[a-f0-9]{40}$/.test(request.baseCommit||'')?request.baseCommit:await project.git(['rev-parse',request.commit+'^']);
   const allPaths=(await project.git(['diff','--name-only',base,request.commit,'--','site'])).split('\n').filter(Boolean).slice(0,120);
   const paths=[...allPaths].sort((a,b)=>Number(b.endsWith('.css'))-Number(a.endsWith('.css'))||Number(b==='site/index.html')-Number(a==='site/index.html')).slice(0,8);
   const original:Record<string,string>={},files:Record<string,string>={};
   const beforeNames=new Set((await project.git(['ls-tree','-r','--name-only',base,'site'])).split('\n'));
   const afterNames=new Set((await project.git(['ls-tree','-r','--name-only',request.commit,'site'])).split('\n'));
   for(const path of paths){
    if(beforeNames.has(path))original[path]=raster(path)?'[Binary image asset]':(await project.binary(base,path)).toString('utf8');
    if(afterNames.has(path))files[path]=raster(path)?'[Binary image asset]':(await project.binary(request.commit,path)).toString('utf8');
   }
   request.memory={...changeMemory(original,files,request.plan?.summary||''),changedFiles:allPaths,partialEvidence:allPaths.length>paths.length};
  }catch{
   // A missing archived Git version does not block a new edit; original request text is still available.
  }
 }
}
