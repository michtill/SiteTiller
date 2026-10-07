import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,writeFile,rm} from 'node:fs/promises';import {join,posix} from 'node:path';
import {Project} from './project.ts';import {safeSitePath} from './core.ts';import {raster} from './images.ts';
import {staticChecks,browserChecks} from './checks.ts';import {clearDraftHistory} from './draft-state.ts';import {addRequest} from './journal.ts';
export function sourcePaths(snapshot:any){return Object.fromEntries(snapshot.evidence.resources.map((r:any)=>[r.path,r.url]));}
export async function recordRealityZero(project:Project,config:any,commit:string,url:string){
 if((config.releases||[]).length)return false;
 config.releases=[{id:'imported-version-0',number:0,commit,publishedAt:new Date().toISOString(),imported:true,description:'Výchozí stav načtený ze skutečného webu',previousCommit:null,sourceUrl:url}];
 config.publishedCommit=commit;config.draftBaseCommit=commit;config.publishedThrough=0;config.lastReviewCommit=commit;
 await project.git(['tag','sitetiller/imported/v0',commit]);return true;
}
function normalized(files:Record<string,string>,binary:Record<string,Buffer>,url:string,paths:Record<string,string>){
 const base=new URL(url),result:Record<string,any>={};
 const logical=(path:string)=>{const address=new URL(paths[path]||path.slice(5),base);return address.origin===base.origin?address.pathname+address.search:address.href;};
 for(const [path,text] of Object.entries(files)){
  const kind=path.endsWith('.html')?'pages':path.endsWith('.css')?'styles':path.endsWith('.js')?'scripts':raster(path)||path.endsWith('.svg')?'images':'text';
  let bytes:Buffer;if(binary[path])bytes=binary[path];else{
   const reference=(raw:string)=>{if(/^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(raw))return raw;try{const address=new URL(raw,'https://draft.invalid/'+path.slice(5));if(address.origin==='https://draft.invalid'){const target='site/'+address.pathname.slice(1);return new URL(paths[target]||target.slice(5),base).href+address.hash;}return address.href;}catch{return raw;}};
   const changed=text.replace(/\r\n/g,'\n').replace(/<base\b[^>]*>/gi,'').replace(/\b(src|href|poster|action)\s*=\s*(["'])(.*?)\2/gi,(_,a,q,v)=>a+'='+q+reference(v)+q).replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi,(_,q,v)=>'url('+q+reference(v)+q+')');bytes=Buffer.from(changed);
  }
  result[logical(path)]={kind,path,hash:createHash('sha256').update(bytes).digest('hex'),text:binary[path]?null:kind==='pages'?bytes.toString('utf8').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():bytes.toString('utf8')};
 }
 return result;
}
async function version(project:Project,commit:string,url:string,paths:Record<string,string>){const files=await project.committedFiles(commit),binary:Record<string,Buffer>={};for(const path of Object.keys(files).filter(raster))binary[path]=await project.binary(commit,path);return normalized(files,binary,url,paths);}
export async function compareReality(project:Project,config:any,commit:string,snapshot:any){
 const head=await project.head();if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Neplatná verze pro porovnání.');await project.git(['merge-base','--is-ancestor',commit,head]);
 const url=snapshot.evidence.url,paths={...(config.realityPaths||{}),...sourcePaths(snapshot)};
 const selected=await version(project,commit,url,paths),baseline=config.publishedCommit?await version(project,config.publishedCommit,url,paths):null,live=normalized(snapshot.files,snapshot.binary,url,paths);
 const changes:any[]=[];for(const path of new Set([...Object.keys(selected),...Object.keys(live),...Object.keys(baseline||{})])){
  const same=selected[path]?.hash===live[path]?.hash;if(same&&(!baseline||selected[path]?.hash===baseline[path]?.hash))continue;
  const before=selected[path]?.text||'',after=live[path]?.text||'';let index=0;while(index<Math.min(before.length,after.length)&&before[index]===after[index])index++;const start=Math.max(0,index-100);
  changes.push({path,kind:(live[path]||selected[path]||baseline?.[path]).kind,selectedPath:selected[path]?.path,livePath:live[path]?.path,excerpt:before!==after?{selected:before.slice(start,start+500),live:after.slice(start,start+500)}:null,status:!selected[path]?'only-live':!live[path]?'only-draft':same?'same':'different',draftChanged:baseline?selected[path]?.hash!==baseline[path]?.hash:null,liveChanged:baseline?live[path]?.hash!==baseline[path]?.hash:null});
 }
 return {commit,head,url,checkedAt:new Date().toISOString(),baseline:config.publishedCommit||null,equal:changes.every(c=>c.status==='same'),changes,warnings:snapshot.evidence.warnings,limitations:snapshot.evidence.limitations};
}
export async function loadReality(project:Project,config:any,snapshot:any,expectedHead:string,clear:boolean,check=browserChecks){
 if(await project.head()!==expectedHead)throw Error('Návrh se mezitím změnil. Porovnej web znovu.');
 const path=join(project.root,'..','reality-'+randomUUID());await cp(project.root,path,{recursive:true});
 try{
  const draft=new Project(path);await draft.writeSnapshot(snapshot.files);
  for(const [name,bytes] of Object.entries(snapshot.binary)){const target=safeSitePath(path,name);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,bytes as Buffer);}
  const tests=staticChecks(snapshot.files);if(!tests.passed)throw Error('Načtený web neprošel kontrolou: '+tests.errors.join('; '));
  const browser=await check(path,snapshot.files);if(!browser.passed)throw Error('Načtený web neprošel kontrolou zobrazení: '+browser.errors.join('; '));
  await draft.git(['add','site']);await draft.git(['commit','--allow-empty','-m','Načtení skutečného webu '+snapshot.evidence.url]);const commit=await draft.head();
  if(await project.head()!==expectedHead)throw Error('Návrh se mezitím změnil.');await project.git(['fetch',path,'main']);await project.git(['merge','--ff-only','FETCH_HEAD']);
  const first=!(config.releases||[]).length,hadSteps=(config.requests||[]).length>0;
  if(clear)clearDraftHistory(config,commit);
  config.realityPaths={...(config.realityPaths||{}),...sourcePaths(snapshot)};config.realityCheckedAt=new Date().toISOString();config.pendingRelease=null;config.approvedCommit=null;config.technicalApproval=null;
  if(first){const release={id:'imported-version-0',number:0,commit,publishedAt:config.realityCheckedAt,imported:true,description:'Výchozí stav načtený ze skutečného webu',previousCommit:null,sourceUrl:snapshot.evidence.url};config.releases=[release];config.publishedCommit=commit;config.draftBaseCommit=commit;config.publishedThrough=clear?config.requestSequence||0:0;config.lastReviewCommit=commit;await project.git(['tag','sitetiller/imported/v0',commit]);}
  let request=null;if(!first||hadSteps&&!clear)request=addRequest(config,{id:randomUUID(),prompt:'Načíst aktuální web z '+snapshot.evidence.url,createdAt:config.realityCheckedAt,status:'ready',commit,scope:'create',baseCommit:expectedHead,memory:{summary:'Aktuální web byl načten do návrhu. Skutečný web se nezměnil.'},tests:{passed:true,static:tests,browser:{...browser,screenshots:undefined}},webImport:snapshot.evidence});
  return {commit,first,request,cleared:clear,source:snapshot.evidence};
 }finally{await rm(path,{recursive:true,force:true});}
}
