import {productionProject,syncProduction} from './production-history.ts';
import {rebaseWorkspace} from './workspace-history.ts';
import {restoreProduction} from './restore-production.ts';
import {compareReality,loadReality} from './reality.ts';
import {importWebsite,publicUrl} from './web-import.ts';
import {realitySnapshot} from './reality-source.ts';
import {studioPreviewPolicy} from './site-policy.ts';
import {publicationTarget,publishableSteps} from './publication-target.ts';
import {draftState,clearDraftHistory} from './draft-state.ts';
import {closePublishedHistory,publicationSummary,visibleVersionHistory} from './publication-history.ts';
import {checkPublication} from './publication-check.ts';
import {cleanupPublication,mapCleanupHistory} from './image-cleanup.ts';
import {previewVersion,versionReferences} from './preview-version.ts';
import {previewDocument} from './preview-document.ts';
import {imageIssues,websiteImages} from './image-editor.ts';
import {decodeImage,selectImages,raster,imageMime} from './images.ts';
import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { defaults, seal, unseal,resolveSiteFile, type Slot } from './core.ts';
import { Project } from './project.ts';
import { workflow } from './workflow.ts';
import {initialTeam,initialImages,clientFor,validTeam,validImages,resolvePrimary,migrateAgentConfig,type Role} from './team.ts';
import {catalog,unavailable} from './catalog.ts';
import {reviewChanges} from './review.ts';
import {addRequest,pendingRequests} from './journal.ts';
import {recentConversation,searchConversation,hydrateRecentMemory} from './memory.ts';
import {initialReleases,publicationIntent,completePublication,groupHistory} from './releases.ts';
try {process.loadEnvFile('.env');} catch {}
const root=resolve(fileURLToPath(new URL('..',import.meta.url))), data=resolve(process.env.SITETILLER_DATA_DIR || join(root,'data'));
await mkdir(data,{recursive:true});
async function load(name:string,fallback:any) {try{return JSON.parse(await readFile(join(data,name),'utf8'));}catch(e:any){if(e.code==='ENOENT')return fallback;throw e;}}
async function save(name:string,value:any) {const p=join(data,name);await writeFile(p+'.tmp',JSON.stringify(value,null,2),{mode:name==='config.json'?0o640:0o600});await rename(p+'.tmp',p);}
let key:Buffer; try {key=await readFile(join(data,'master.key'));} catch(e:any) {if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(join(data,'master.key'),key,{mode:0o600});}
let bootstrap:string; try {bootstrap=await readFile(join(data,'bootstrap-token'),'utf8');}catch{bootstrap=randomBytes(24).toString('hex');await writeFile(join(data,'bootstrap-token'),bootstrap,{mode:0o600});}
let config=await load('config.json',{slots:[{provider:'openai',...defaults.openai,key:''},{provider:'anthropic',...defaults.anthropic,key:''}],password:null,approvedCommit:null,publishedCommit:null});
config.slots=config.slots||[];
config.reviewedCommits=Array.from(new Set([...(config.reviewedCommits||[]),config.approvedCommit,config.publishedCommit].filter(Boolean)));
function slots():Slot[] {return config.slots.map((s:any)=>({...s,key:s.key?unseal(s.key,key):(s.provider==='openai'?process.env.OPENAI_API_KEY:process.env.ANTHROPIC_API_KEY)||''}));}
const legacySlots=slots();
config.providers=config.providers||Object.fromEntries(['openai','anthropic'].map(provider=>[provider,{key:config.slots.find((s:any)=>s.provider===provider&&s.key)?.key||''}]));
if(migrateAgentConfig(config))await save('config.json',config);
config.roles=config.roles||initialTeam();config.imageModels=config.imageModels||initialImages();
if(!config.automaticReasoningPolicy){config.previousReasoningSettings=structuredClone(config.roles);config.roles.primary.reasoningEffort='auto';config.roles.ui.reasoningEffort='auto';config.roles.verify.reasoningEffort='auto';config.automaticReasoningPolicy=1;await save('config.json',config);}
function providerKeys(){return Object.fromEntries(['openai','anthropic'].map(provider=>[provider,config.providers[provider]?.key?unseal(config.providers[provider].key,key):(provider==='openai'?process.env.OPENAI_API_KEY:process.env.ANTHROPIC_API_KEY)||''])) as {openai:string;anthropic:string};}
function activeSlots():Slot[]{const keys=providerKeys();return (['openai','anthropic'] as const).map(provider=>({provider,key:keys[provider],...defaults[provider]}));}
const project=new Project(join(data,'project')); await project.init(process.env.SITETILLER_INITIAL_SITE==='seed'?join(root,'seed'):null);
const sessions=new Map<string,number>(), failures=new Map<string,{count:number,time:number}>();
let job:any=await load('last-job.json',null), busy=false;
if(job?.status==='running')job={...job,status:'failed',error:'Úloha byla přerušena restartem. Náhled zůstal zachován.'};
let events:any[]=await load('events.json',[]);
if(!config.releases){config.releases=initialReleases(config.publishedCommit,events);await save('config.json',config);}
config.lastReviewCommit=config.lastReviewCommit||config.approvedCommit||config.publishedCommit||await project.git(['rev-list','--max-parents=0','HEAD']);
config.reviewedThrough=config.reviewedThrough||0;
if(!config.requests){
  config.requests=[];config.reviewedThrough=0;config.lastReviewCommit=config.approvedCommit||config.publishedCommit||await project.git(['rev-list','--max-parents=0','HEAD']);
  const history=await project.git(['log','--reverse','--format=%H%x09%s',config.lastReviewCommit+'..HEAD']);
  for(const line of history.split('\n').filter(Boolean)){const [commit,...message]=line.split('\t');const text=message.join('\t');if(text.startsWith('SiteTiller: '))addRequest(config,{id:randomBytes(8).toString('hex'),prompt:job?.commit===commit&&job?.prompt?job.prompt:text.slice('SiteTiller: '.length),commit,status:'legacy'});}
  if(job?.prompt&&!config.requests.some((r:any)=>r.prompt===job.prompt)&&job.commit!==config.lastReviewCommit)addRequest(config,{id:randomBytes(8).toString('hex'),prompt:job.prompt,commit:job.commit||null,status:job.status});
  await save('config.json',config);
}
const cleanedHistory=closePublishedHistory(config,events);events=cleanedHistory.events;
if(cleanedHistory.removed&&job?.kind==='edit'&&!config.requests.some((r:any)=>r.id===job.id)){job={id:job.id,kind:'publish',status:'ready',commit:config.publishedCommit};await save('last-job.json',job);}
await save('config.json',config);await save('events.json',events);
const PORT=Number(process.env.PORT||8080), HOST=process.env.HOST||'127.0.0.1';
const publicOrigin=process.env.SITETILLER_ORIGIN||`http://127.0.0.1:${PORT}`;
function response(res:http.ServerResponse,status:number,body:any) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req:http.IncomingMessage,limit=1000000) {let bytes=0,text='';for await(const part of req){bytes+=part.length;if(bytes>limit)throw new Error('Příliš velký požadavek.');text+=part;}return JSON.parse(text||'{}');}
function auth(req:http.IncomingMessage) {const token=req.headers.cookie?.match(/(?:^|;\s*)sitetiller=([a-f0-9]+)/)?.[1];return !!token && (sessions.get(token)||0)>Date.now();}
function sameOrigin(req:http.IncomingMessage) {return req.headers.origin===publicOrigin;}
function login(res:http.ServerResponse) {const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*3600000);res.setHeader('Set-Cookie',`sitetiller=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${publicOrigin.startsWith('https:')?'; Secure':''}`);}
function hashPassword(p:string,salt:string) {return scryptSync(p,salt,64).toString('hex');}
function state() {return {name:'SiteTiller',version:'0.23.12',siteUrl:siteUrl(),hasDraftSteps:!!config.requests.length,hasLoadedReality:!!config.realityCheckedAt||!!Object.keys(config.realityPaths||{}).length,agentArchitecture:3,imageModels:config.imageModels,configured:!!config.password,providers:Object.entries(providerKeys()).map(([provider,key])=>({provider,hasKey:!!key})),roles:config.roles,requests:config.requests,reviewRuns:config.reviewRuns||[],job,events,busy,pendingCount:pendingRequests(config.requests,config.reviewedThrough).length,lastReviewCommit:config.lastReviewCommit,approvedCommit:config.approvedCommit,publishedCommit:config.publishedCommit,releases:config.releases,previewUrl:process.env.SITETILLER_PREVIEW_URL||'/preview/',publishConfigured:!!process.env.SITETILLER_PUBLISH_URL};}
const realitySnapshots=new Map<string,any>();
function siteUrl(){return config.siteUrl??process.env.SITETILLER_SITE_URL??'';}
let historyCache:any=null;
async function synchronizeHistory(){const production=await syncProduction(config),latest=config.releases?.at(-1);if(!production||!latest||busy)return production;const pending=config.pendingRelease,recover=pending?.commit===latest.sourceCommit&&pending?.number===latest.number&&(pending?.minor??null)===(latest.minor??null),initialize=!config.historyInitialized&&latest.number===0&&!latest.imported&&latest.sourceCommit===await project.head();if(recover||initialize){const through=recover?pending.through:Math.max(0,...config.requests.map(r=>r.sequence||0));const rebuilt=await rebaseWorkspace(project,production,latest.commit,latest.sourceCommit,recover?config.requests.filter(r=>r.sequence>through&&['ready','legacy'].includes(r.status)).map(r=>r.commit):[]);mapCleanupHistory(config,events,rebuilt.mapping);config.publishedThrough=through;config.reviewedThrough=through;config.draftBaseCommit=latest.commit;config.lastReviewCommit=latest.commit;config.pendingRelease=null;config.historyInitialized=true;const closed=closePublishedHistory(config,events);await eventWrites;events=closed.events;await save('events.json',events);await save('config.json',config);historyCache=null;}return production;}
async function historyState(){await synchronizeHistory();const head=await project.head(),signature=head+JSON.stringify([config.releases,config.draftBaseCommit,config.requests.map((r:any)=>[r.id,r.commit,r.status,r.sequence])]);if(historyCache?.signature!==signature){const history=visibleVersionHistory(await project.history(null),config),files=await project.committedFiles(head),projectTitle=files['site/index.html']?.match(/<title>(.*?)<\/title>/s)?.[1]?.slice(0,100)||'Nový web';if(config.separatedHistories)for(const release of config.releases)if(!history.some(item=>item.commit===release.commit))history.push({commit:release.commit,message:'Verze '+release.number,date:release.publishedAt,production:true});historyCache={publishableCommits:await publishableSteps(project,config,head),signature,history,projectTitle,groups:groupHistory(history,config.releases)};}return {...await draftState(project,config,head),head,publishableCommits:historyCache.publishableCommits,projectTitle:historyCache.projectTitle,history:historyCache.history,releaseGroups:historyCache.groups};}
async function imageInputs(items:any[]){return Promise.all(items.map(async i=>({...i,data:(await readFile(join(data,'uploads',i.id))).toString('base64')})));}
let eventWrites=Promise.resolve();
async function emit(event:any){const value={...event,jobId:event.jobId||job?.id,kind:event.kind||job?.kind,at:new Date().toISOString()};const record=value.kind==='edit'?config.requests.find((r:any)=>r.id===value.jobId):value.kind==='review'?(config.reviewRuns||[]).find((r:any)=>r.id===value.jobId):null;if(record){record.progress=record.progress||[];record.progress.push(value);}events.push(value);events=events.slice(-200);const snapshot=[...events];eventWrites=eventWrites.then(()=>save('events.json',snapshot));await eventWrites;}
const mime:any={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.json':'application/json','.txt':'text/plain'};
async function servePreview(req:http.IncomingMessage,res:http.ServerResponse,url:URL){
  // Only committed content is served. Sandbox isolates user-authored JS from studio origin.
  const version=await previewVersion(project,url,true);if(!version){res.writeHead(404);return res.end('Verze nenalezena');}
  const {commit,relative,prefix}=version,selected=version.project||project,files=await selected.committedFiles(commit);
  const name=resolveSiteFile('/'+relative,files);
  if (!Object.hasOwn(files,name)){res.writeHead(404);return res.end('Nenalezeno');}
  if(!url.pathname.endsWith('/')&&!Object.hasOwn(files,'site/'+relative)){res.writeHead(302,{Location:url.pathname+'/'+url.search});return res.end();}
  let content:any=raster(name)?await (version.project||project).binary(commit,name):files[name];
  // Root-relative website links remain inside the studio's isolated preview route.
  if(/\.(html|css)$/.test(name))content=versionReferences(content,prefix);
  if(name.endsWith('.html'))content=previewDocument(content,commit,url.searchParams.get('embedded')==='1');
  res.writeHead(200,{'Content-Type':raster(name)?imageMime(name):(mime[extname(name)]||'text/plain'),'X-Robots-Tag':'noindex, nofollow, noarchive','Cache-Control':'no-store','Content-Security-Policy':studioPreviewPolicy});res.end(content);
}
const server=http.createServer(async(req,res)=>{try{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
  const url=new URL(req.url||'/',publicOrigin), path=url.pathname;
  if(path==='/health')return response(res,200,{ok:true});
  if(path==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('User-agent: *\nDisallow: /\n');}
  if(path.startsWith('/preview/'))return await servePreview(req,res,url);
  if(path.startsWith('/api/')){
    const mutating=req.method!=='GET';
    if(mutating&&!sameOrigin(req))return response(res,403,{error:'Nepovolený původ požadavku.'});
    if(path==='/api/session'&&req.method==='GET')return response(res,200,{authenticated:auth(req),configured:!!config.password,localBootstrap:(!config.password&&HOST==='127.0.0.1'&&req.socket.remoteAddress==='127.0.0.1')?bootstrap:undefined});
    if(path==='/api/login'&&req.method==='POST'){
      const ip=req.socket.remoteAddress||'unknown', prev=failures.get(ip);
      if(prev&&prev.count>=8&&Date.now()-prev.time<600000)return response(res,429,{error:'Příliš mnoho pokusů. Počkej deset minut.'});
      const input=await body(req);const password=typeof input.password==='string'?input.password:'';
      if(!config.password){if(input.bootstrap!==bootstrap)return response(res,403,{error:'Neplatný instalační token.'});if(password.length<12||password.length>256)throw new Error('Heslo musí mít 12 až 256 znaků.');const salt=randomBytes(16).toString('hex');config.password={salt,hash:hashPassword(password,salt)};await save('config.json',config);}
      else if(password.length>256||!timingSafeEqual(Buffer.from(hashPassword(password,config.password.salt),'hex'),Buffer.from(config.password.hash,'hex'))){failures.set(ip,{count:(prev?.count||0)+1,time:Date.now()});return response(res,401,{error:'Nesprávné heslo.'});}
      failures.delete(ip);login(res);return response(res,200,{ok:true});
    }
    if(!auth(req))return response(res,401,{error:'Přihlas se do SiteTiller.'});
    if(path==='/api/state'&&req.method==='GET'){for(let attempt=0;attempt<3;attempt++){const history=await historyState(),snapshot={...state(),...history};if(history.head===await project.head()&&snapshot.busy===busy)return response(res,200,snapshot);historyCache=null;}throw Error('Návrh se právě mění. Obnovte stav.');}
    if(path==='/api/models'&&(req.method==='GET'||req.method==='POST')){
      const input=req.method==='POST'?await body(req):{};
      const keys=providerKeys();
      for(const provider of ['openai','anthropic'] as const){const value=input.keys?.[provider];if(value!==undefined){if(typeof value!=='string'||value.length>512)throw new Error('Neplatný klíč.');if(value.trim())keys[provider]=value.trim();}}
      const list=await catalog(keys),resolved=resolvePrimary(config.roles,list.models);return response(res,200,{...list,issues:unavailable(resolved,list,['primary']),optionalIssues:[...unavailable(resolved,list,['ui','verify','escalation']),...Object.values(config.imageModels).flatMap((model:any)=>imageIssues(model,list.models))]});
    }
    if(path==='/api/settings'&&req.method==='POST'){
      if(busy)throw new Error('Počkej na dokončení úlohy.');const input=await body(req);
      if(input.imageModels&&typeof input.imageModels==='object')input.imageModels={precise:input.imageModels.precise,fast:input.imageModels.fast};if(!validTeam(input.roles)||!validImages(input.imageModels))throw new Error('Vyber model pro každou capability.');
      const addressOnly=input.siteUrl!==undefined&&Object.entries(config.roles).every(([role,v]:[string,any])=>['provider','model','reasoningEffort'].every(k=>v[k]===input.roles[role]?.[k]))&&Object.entries(config.imageModels).every(([k,v])=>v===input.imageModels[k])&&!Object.values(input.keys||{}).some(v=>typeof v==='string'&&v.trim());
      if(addressOnly){if(busy)throw Error('Počkej na dokončení úlohy.');if(typeof input.siteUrl!=='string'||input.siteUrl.length>2000)throw Error('Neplatná adresa webu.');const address=input.siteUrl.trim()?publicUrl(input.siteUrl.trim()).href:'';busy=true;try{config.siteUrl=address;realitySnapshots.clear();await save('config.json',config);return response(res,200,{ok:true});}finally{busy=false;}}
      const keys=providerKeys(),providers=structuredClone(config.providers);
      for(const provider of ['openai','anthropic'] as const){const value=input.keys?.[provider];if(value!==undefined){if(typeof value!=='string'||value.length>512)throw new Error('Neplatný klíč.');if(value.trim()){keys[provider]=value.trim();providers[provider]={key:seal(value.trim(),key)};}}}
      if(busy)throw new Error('Počkej na dokončení úlohy.');busy=true;try{
      const list=await catalog(keys),resolved=resolvePrimary(input.roles,list.models),issues=unavailable(resolved,list,['primary']);
      if(issues.length)return response(res,400,{error:issues.join('\n')});
      if(input.siteUrl!==undefined){if(typeof input.siteUrl!=='string'||input.siteUrl.length>2000)throw Error('Neplatná adresa webu.');config.siteUrl=input.siteUrl.trim()?publicUrl(input.siteUrl.trim()).href:'';realitySnapshots.clear();}config.providers=providers;config.roles=input.roles;config.imageModels=input.imageModels;await save('config.json',config);return response(res,200,{ok:true,catalog:list,optionalIssues:[...unavailable(resolved,list,['ui','verify','escalation']),...Object.values(input.imageModels).flatMap((model:any)=>imageIssues(model,list.models))]});
      }finally{busy=false;}
    }
    if(path==='/api/images'&&req.method==='POST'){
      if(busy)throw Error('Počkej na dokončení úlohy.');const image=decodeImage(await body(req,7100000));const uploads=config.uploads||[];if(!uploads.some((i:any)=>i.id===image.id)&&uploads.reduce((n:number,i:any)=>n+i.size,0)+image.bytes.length>100*1024*1024)throw Error('Úložiště obrázků dosáhlo limitu 100 MB.');
      await mkdir(join(data,'uploads'),{recursive:true});await writeFile(join(data,'uploads',image.id),image.bytes,{mode:0o600});const info={id:image.id,name:image.name,mime:image.mime,size:image.bytes.length};config.uploads=[...uploads.filter((i:any)=>i.id!==image.id),info];await save('config.json',config);return response(res,201,info);
    }
    if(path.startsWith('/api/images/')&&req.method==='GET'){const id=path.slice(12),image=(config.uploads||[]).find((i:any)=>i.id===id);if(!image)return response(res,404,{error:'Obrázek nenalezen.'});res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'no-store'});return res.end(await readFile(join(data,'uploads',image.id)));}
    if(path==='/api/run'&&req.method==='POST'){
      if(busy)throw new Error('Jiná úloha právě běží.');const input=await body(req);
      if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>6000)throw new Error('Zadej požadavek do 6000 znaků.');
      const reasoningEffort=input.reasoningEffort??'auto';if(!['auto','low','medium','high'].includes(reasoningEffort))throw Error('Neplatná míra uvažování.');
      const mode=input.mode||'edit';if(!['edit','redesign','create'].includes(mode))throw Error('Neplatný rozsah požadavku.');
      const attachments=selectImages(input.attachments,config.uploads||[]);if(attachments.reduce((n:number,i:any)=>n+i.size,0)>12*1024*1024)throw Error('Přílohy dohromady musí mít nejvýše 12 MB.');const images=await imageInputs(attachments);
      const list=await catalog(providerKeys()),resolvedTeam=resolvePrimary(config.roles,list.models),issues=unavailable(resolvedTeam,list,['primary']);if(issues.length)throw new Error(issues.join('\n'));
      if(busy)throw new Error('Jiná úloha právě běží.');
      busy=true;const priorRequests=structuredClone([...(config.conversationMemory||[]),...config.requests]),baseCommit=await project.head();
      const request=addRequest(config,{id:randomBytes(8).toString('hex'),prompt:input.prompt.trim(),mode,reasoningEffort,attachments,models:structuredClone(config.roles),status:'running',baseCommit,createdAt:new Date().toISOString()});
      config.approvedCommit=null;job={id:request.id,kind:'edit',status:'running',prompt:request.prompt,attachments};await save('config.json',config);await save('last-job.json',job);
      await emit({stage:'request',message:request.prompt,attachments});
      void(async()=>{try{await hydrateRecentMemory(project,priorRequests);for(const prior of priorRequests){const saved=config.requests.find((r:any)=>r.id===prior.id);if(saved&&!saved.memory&&prior.memory)saved.memory=prior.memory;}const result=await workflow(project,activeSlots(),request.prompt,join(data,'drafts'),e=>{void emit(e);},undefined,resolvedTeam,images,{mode,reasoningEffort,conversation:recentConversation(priorRequests,baseCommit),history:query=>searchConversation(priorRequests,query,baseCommit),publication:()=>({publishedCommit:config.publishedCommit||null}),imageModels:config.imageModels,availableModels:list.models});Object.assign(request,{status:result.conversationOnly?'answered':'ready',commit:result.commit,scope:result.scope,resolvedRequest:result.resolvedRequest,memory:result.memory,plan:result.plan,imageResults:result.imageResults,tests:result.tests});if(result.webImport?.resources)config.realityPaths={...(config.realityPaths||{}),...Object.fromEntries(result.webImport.resources.map((r:any)=>[r.path,r.url]))};job={...job,status:'ready',...result};}catch(e:any){request.status='failed';request.error=e.message;request.errorFromAgent=!!e.agentResponse;job={...job,status:'failed',error:e.message};await emit({stage:'failed',message:e.message,agentResponse:!!e.agentResponse});}finally{await save('config.json',config);await save('last-job.json',job);busy=false;}})();
      return response(res,202,{job});
    }
    if(path==='/api/reality/image'&&req.method==='GET'){
      const cached=realitySnapshots.get(url.searchParams.get('token')||''),name=url.searchParams.get('path')||'';
      if(!cached||Date.now()-cached.created>10*60*1000||!raster(name)||!cached.snapshot.binary[name])return response(res,404,{error:'Obrázek není dostupný.'});
      res.writeHead(200,{'Content-Type':imageMime(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(cached.snapshot.binary[name]);
    }
    if(path==='/api/reality/compare'&&req.method==='POST'){await syncProduction(config);
      if(busy)throw Error('Počkej na dokončení úlohy.');const input=await body(req);if(busy)throw Error('Počkej na dokončení úlohy.');
      const url=siteUrl();if(!url)throw Error('Nejdřív nastav adresu skutečného webu.');
      busy=true;try{
        const head=await project.head();if(input.expectedHead!==head)throw Error('Návrh se mezitím změnil.');
        if(typeof input.commit!=='string'||!/^[a-f0-9]{40}$/.test(input.commit))throw Error('Neplatná verze.');if(!config.separatedHistories||!config.releases.some(r=>r.commit===input.commit))await project.git(['merge-base','--is-ancestor',input.commit,head]);
        const snapshot=await realitySnapshot(publicUrl(url).href,process.env.SITETILLER_PUBLISH_URL,process.env.SITETILLER_PUBLISH_TOKEN),result=await compareReality(project,config,input.commit,snapshot,productionProject()),token=randomBytes(24).toString('hex');
        for(const [key,value] of realitySnapshots)if(Date.now()-value.created>10*60*1000)realitySnapshots.delete(key);
        while(realitySnapshots.size>=3)realitySnapshots.delete(realitySnapshots.keys().next().value!);
        realitySnapshots.set(token,{snapshot,head,url,publication:config.publishedCommit||null,equal:result.equal,liveMatchesPublished:result.liveMatchesPublished,created:Date.now()});return response(res,200,{...result,token});
      }finally{busy=false;}
    }
    if(path==='/api/reality/load'&&req.method==='POST'){
      if(busy)throw Error('Počkej na dokončení úlohy.');const input=await body(req);if(busy)throw Error('Počkej na dokončení úlohy.');
      const cached=realitySnapshots.get(input.token);if(!cached||Date.now()-cached.created>10*60*1000||cached.url!==siteUrl()||cached.publication!==(config.publishedCommit||null))throw Error('Porovnání již není aktuální. Porovnej web znovu.');
      if(input.expectedHead!==cached.head||(typeof input.clearPrevious!=='boolean'||typeof input.saveVersion!=='boolean'))throw Error('Neplatné potvrzení načtení webu.');
      if(cached.equal)throw Error('Zobrazená verze se shoduje se skutečným webem. Není co načítat.');
      if(input.saveVersion&&cached.liveMatchesPublished)throw Error('Skutečný web již odpovídá uložené publikované verzi. Nová verze není potřeba.');
      busy=true;try{
        if(config.separatedHistories&&input.saveVersion&&(!Number.isInteger(input.versionNumber)||input.versionNumber<0||input.versionNumber>999999||config.releases.some(r=>r.number===input.versionNumber)||cached.snapshot.evidence.source!=='hosting-http'))throw Error('Vyber volné číslo verze skutečného webu připojeného k hostingu.');
        const beforeLoad=structuredClone(config),result=await loadReality(project,config,cached.snapshot,cached.head,input.clearPrevious,undefined,config.separatedHistories?false:input.saveVersion,input.versionNumber);
        if(config.separatedHistories&&input.saveVersion){
          try{await save('config.json',config);const endpoint=new URL(process.env.SITETILLER_PUBLISH_URL!);endpoint.pathname=endpoint.pathname.replace(/publish$/,'archive');const archived=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.SITETILLER_PUBLISH_TOKEN},body:JSON.stringify({commit:result.commit,number:input.versionNumber}),signal:AbortSignal.timeout(90000)});const value:any=await archived.json();if(!archived.ok)throw Error(value.error||'Uložení skutečné verze selhalo.');await syncProduction(config);}
          catch(error){await syncProduction(config);if(!config.releases.some(r=>r.number===input.versionNumber&&r.sourceCommit===result.commit)){await project.rewind(cached.head,result.commit,null);config=beforeLoad;await save('config.json',config);historyCache=null;throw error;}}
          result.savedVersion=input.versionNumber;config.draftBaseCommit=result.commit;
        }
        if(config.separatedHistories&&input.clearPrevious){await rebaseWorkspace(project,project,result.commit,result.commit,[]);if(result.request){result.request.baseCommit=null;config.requests=[result.request];}config.draftBaseCommit=result.commit;config.lastReviewCommit=result.commit;}
        if(input.clearPrevious||result.first&&!result.request){await eventWrites;events=[];await save('events.json',events);}
        job=result.request?{id:result.request.id,kind:'edit',status:'ready',commit:result.commit,plan:{summary:result.request.memory.summary},tests:result.request.tests}:null;
        if(result.request){await emit({stage:'request',jobId:result.request.id,kind:'edit',message:result.request.prompt});await emit({stage:'build',status:'completed',jobId:result.request.id,kind:'edit',message:result.request.memory.summary,commit:result.commit});await emit({stage:'ready',jobId:result.request.id,kind:'edit',commit:result.commit,message:'Web byl načten do návrhu.'});}
        await save('config.json',config);await save('last-job.json',job);historyCache=null;realitySnapshots.clear();return response(res,200,{ok:true,commit:result.commit,savedVersion:result.savedVersion});
      }finally{busy=false;}
    }
    if(path==='/api/review'&&req.method==='POST'){
      if(busy)throw new Error('Počkej na dokončení úlohy.');const input=await body(req);
      if(input.expectedHead!==await project.head())throw new Error('Náhled se mezitím změnil.');
      const list=await catalog(providerKeys()),issues=unavailable(config.roles,list,['verify']);if(issues.length)throw new Error(issues.join('\n'));
      if(busy)throw new Error('Počkej na dokončení úlohy.');if(input.expectedHead!==await project.head())throw new Error('Náhled se mezitím změnil.');busy=true;
      const requests=structuredClone(pendingRequests(config.requests,config.reviewedThrough));
      const through=config.requests.at(-1)?.sequence||config.reviewedThrough||0;
      config.approvedCommit=null;job={id:randomBytes(8).toString('hex'),kind:'review',status:'running'};config.reviewRuns=[...(config.reviewRuns||[]),{id:job.id,createdAt:new Date().toISOString(),progress:[]}];await save('config.json',config);await save('last-job.json',job);
      void(async()=>{try{
        const result=await reviewChanges(project,clientFor(config.roles,providerKeys(),'verify'),requests,config.lastReviewCommit,e=>{void emit(e);},undefined,await imageInputs(Array.from(new Map(requests.flatMap((r:any)=>r.attachments||[]).map((i:any)=>[i.id,i])).values()) as any[]),undefined,{publishedCommit:config.publishedCommit||null});
        if(result.review.approved){config.approvedCommit=result.commit;config.lastReviewCommit=result.commit;config.reviewedThrough=through;config.reviewedCommits=Array.from(new Set([...config.reviewedCommits,result.commit]));await emit({stage:'ready',message:'Revize všech požadavků prošla. Můžeš publikovat.',commit:result.commit});}
        else await emit({stage:'failed',message:'Revize našla nedostatky. Publikování zůstává vypnuté.',issues:result.review.issues});
        job={...job,...result,status:result.review.approved?'ready':'rejected'};
      }catch(e:any){job={...job,status:'failed',error:e.message};await emit({stage:'failed',message:e.message});}finally{await save('config.json',config);await save('last-job.json',job);busy=false;}})();
      return response(res,202,{job});
    }
    if(path==='/api/restore'&&req.method==='POST'){await syncProduction(config);
      if(busy)throw Error('Počkej na dokončení úlohy.');const input=await body(req);if(busy)throw Error('Počkej na dokončení úlohy.');
      const mode=input.historyMode||'keep';if(!['keep','clear-all','rewind'].includes(mode))throw Error('Neplatná volba historie úprav.');
      busy=true;try{
        if(mode==='rewind'){
          const selected=config.requests.findLast((r:any)=>r.commit===input.commit&&(!input.stepId||r.id===input.stepId)&&['ready','legacy'].includes(r.status));
          if(!selected)throw Error('Vybraný krok již není v rozpracovaných úpravách.');
          const result=await project.rewind(input.commit,input.expectedHead,config.separatedHistories?null:config.publishedCommit||null);
          config.requestSequence=Math.max(config.requestSequence||0,...config.requests.map((r:any)=>r.sequence||0));
          config.requests=config.requests.filter((r:any)=>r.sequence<=selected.sequence);config.reviewRuns=[];config.pendingRelease=null;config.approvedCommit=null;config.technicalApproval=null;
          config.reviewedThrough=Math.min(config.reviewedThrough||0,selected.sequence);config.lastReviewCommit=config.publishedCommit||await project.git(['rev-list','--max-parents=0','HEAD']);
          await save('config.json',config);await eventWrites;
          const ids=new Set(config.requests.map((r:any)=>r.id)),commits=new Set(config.requests.map((r:any)=>r.commit));
          events=events.filter(e=>e.stage==='published'||ids.has(e.jobId)||e.kind==='restore'&&commits.has(e.commit));await save('events.json',events);job=null;await save('last-job.json',job);historyCache=null;
          return response(res,200,{...result,rewound:true});
        }
        if(mode==='clear-all'&&!config.releases.some((r:any)=>r.id===input.releaseId&&r.commit===input.commit)&&!config.requests.some((r:any)=>r.commit===input.commit&&(!input.stepId||input.stepId===r.id)&&['ready','legacy'].includes(r.status)))throw Error('Vybraný krok nebo verze již nejsou dostupné.');
        const head=await project.head();if(input.expectedHead!==head)throw Error('Návrh se mezitím změnil. Obnov seznam úprav.');
        const isPublished=config.separatedHistories&&config.releases.some(r=>r.commit===input.commit);const result=mode==='clear-all'?{commit:(await rebaseWorkspace(project,isPublished?productionProject()!:project,input.commit,head,[])).head,restoredFrom:input.commit}:isPublished?await restoreProduction(project,productionProject()!,input.commit,input.expectedHead):await project.restore(input.commit,input.expectedHead);
        config.approvedCommit=null;config.technicalApproval=null;
        if(mode==='clear-all'){clearDraftHistory(config,result.commit);config.conversationMemory=[];await eventWrites;events=[];await save('events.json',events);historyCache=null;}
        const loadedRequest=addRequest(config,{id:randomBytes(8).toString('hex'),createdAt:new Date().toISOString(),prompt:'Načíst do úprav přesný stav webu z verze '+input.commit+'. Tento návrat nahrazuje dřívější změny, které v této verzi nejsou.',restoredFrom:input.commit,commit:result.commit,status:'ready'});
        await save('config.json',config);job={id:loadedRequest.id,kind:'restore',status:'ready',...result,review:null};await save('last-job.json',job);
        await emit({stage:'restored',message:'Do úprav načtena verze '+input.commit.slice(0,8)+'. Publikovaný web se nezměnil.',commit:result.commit});
        return response(res,200,{...result,reviewed:false,clearedPrevious:mode==='clear-all'});
      }finally{busy=false;}
    }
    if(path==='/api/discard'&&req.method==='POST'){
      if(busy)throw Error('Počkej na dokončení úlohy.');const input=await body(req);if(busy)throw Error('Počkej na dokončení úlohy.');
      busy=true;try{
        const head=await project.head(),published=config.publishedCommit;
        if(!published)throw Error('Zatím není žádná publikovaná verze.');
        if(input.expectedHead!==head||input.expectedPublishedCommit!==published)throw Error('Návrh nebo publikovaná verze se mezitím změnily. Obnov seznam verzí.');
        if(!(await draftState(project,config,head)).hasUnpublishedWork)throw Error('Nejsou žádné rozpracované změny k zahození.');
        const result=config.separatedHistories?{commit:(await rebaseWorkspace(project,productionProject()!,published,head)).head}:head===published?{commit:head}:await project.restore(published,head);
        clearDraftHistory(config,result.commit);await save('config.json',config);
        await eventWrites;events=events.filter(e=>e.stage==='published'&&e.commit===published);await save('events.json',events);
        job=null;await save('last-job.json',job);historyCache=null;
        return response(res,200,{ok:true,commit:result.commit,publishedCommit:published});
      }finally{busy=false;}
    }
    if(path==='/api/publish'&&req.method==='POST'){await synchronizeHistory();
      if(busy)throw new Error('Počkej na dokončení úlohy.');const input=await body(req);
      if(busy)throw new Error('Počkej na dokončení úlohy.');
      if(input.createSubversion!==undefined&&typeof input.createSubversion!=='boolean')throw Error('Neplatná volba publikování.');if(input.createSubversion&&(!config.releases.at(-1)||config.releases.at(-1).legacy||input.expectedReleaseId!==config.releases.at(-1).id||input.expectedPublishedCommit!==config.publishedCommit))throw Error('Aktuální publikovaná verze se změnila. Obnovte seznam verzí.');
      if(input.description!==undefined&&(typeof input.description!=='string'||input.description.length>2000))throw Error('Popis verze může mít nejvýše 2000 znaků.');
      const target=await publicationTarget(project,config,input.commit,input.expectedHead,input.stepId);if(busy)throw Error('Počkej na dokončení úlohy.');
      if(!process.env.SITETILLER_PUBLISH_URL)throw new Error('Produkční Git zatím není připojen.');
      busy=true;job={id:randomBytes(8).toString('hex'),kind:'publish',status:'running'};await save('last-job.json',job);await emit({stage:'publish',status:'running',message:'Provádím technickou kontrolu před publikováním.'});try{
        config.approvedCommit=null;config.technicalApproval=null;await save('config.json',config);
        const restored=config.requests.findLast((r:any)=>r.commit===input.commit&&r.restoredFrom);
        let tests=await checkPublication(project,input.commit,restored?.restoredFrom,undefined,target.head,productionProject()||project);
        await emit({stage:'publish',status:'running',message:'Uklízím nepoužívané a totožné obrázky.'});
        const cleaned=await cleanupPublication(project,input.commit,target.head);
        if(cleaned.commit!==input.commit){mapCleanupHistory(config,events,cleaned.mapping);input.commit=cleaned.commit;target.head=cleaned.head;tests=cleaned.tests!;historyCache=null;await save('config.json',config);await eventWrites;await save('events.json',events);}
        job={...job,tests,cleanup:{removed:cleaned.cleanup.removed,duplicates:cleaned.cleanup.duplicates}};
        if(cleaned.cleanup.retainedForDynamicReferences)await emit({stage:'publish',status:'warning',warnings:['Obrázky s nejasnými dynamickými odkazy byly zachovány.']});
        // Compatibility with the independent publisher: controller authorization is now technical, not an AI verdict.
        config.approvedCommit=input.commit;config.technicalApproval={commit:input.commit,head:target.head,checkedAt:new Date().toISOString(),tests};await save('config.json',config);
        await emit({stage:'publish',status:'running',message:'Technické kontroly prošly. Nasazuji vybranou verzi.'});
        config.pendingRelease=publicationIntent(config.releases,config.pendingRelease||null,input.commit,input.description?.trim(),publicationSummary(config.requests.filter((r:any)=>r.sequence<=target.through)),input.createSubversion===true);config.pendingRelease.through=target.through;await save('config.json',config);
        const result=await fetch(process.env.SITETILLER_PUBLISH_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.SITETILLER_PUBLISH_TOKEN},body:JSON.stringify({commit:input.commit}),signal:AbortSignal.timeout(180000)});
        if(!result.ok){const failure:any=await result.json().catch(()=>({}));throw new Error(failure.error||'Publikační služba nepotvrdila nasazení.');}
        const confirmation:any=await result.json();if(confirmation.ok!==true||confirmation.commit!==input.commit)throw new Error('Publikační služba potvrdila jinou verzi.');
        let completed:any;if(config.separatedHistories){if(!confirmation.release||confirmation.release.sourceCommit!==input.commit)throw Error('Chybí potvrzení publikované verze.');const rebuilt=await rebaseWorkspace(project,productionProject()!,confirmation.release.commit,input.commit,config.requests.filter(r=>r.sequence>target.through&&['ready','legacy'].includes(r.status)).map(r=>r.commit));mapCleanupHistory(config,events,rebuilt.mapping);await syncProduction(config);completed={release:confirmation.release,releases:config.releases};input.commit=confirmation.release.commit;config.approvedCommit=null;config.technicalApproval=null;config.reviewedCommits=[];historyCache=null;}else completed=await completePublication(project,config.releases,config.pendingRelease);
        config.releases=completed.releases;config.pendingRelease=null;config.publishedCommit=input.commit;config.draftBaseCommit=input.commit;config.reviewedThrough=target.through;config.lastReviewCommit=input.commit;config.publishedThrough=config.reviewedThrough;const closed=closePublishedHistory(config,events);events=closed.events;await eventWrites;await save('events.json',events);await save('config.json',config);await emit({stage:'published',message:'Verze '+completed.release.number+(completed.release.minor!==undefined?'.'+completed.release.minor:'')+' byla publikována.',commit:input.commit,release:completed.release,kind:'publish'});job={...job,status:'ready',commit:input.commit};await save('last-job.json',job);return response(res,200,{ok:true,release:completed.release});
      }catch(e:any){config.approvedCommit=null;config.technicalApproval=null;await save('config.json',config);job={...job,status:'failed',error:e.name==='TimeoutError'?'Publikování vypršelo. Git mohl být aktualizován; ověř stav a opakuj publikování.':e.message};await save('last-job.json',job);await emit({stage:'failed',message:job.error});throw Error(job.error);}finally{busy=false;}
    }
    if(path==='/api/logout'&&req.method==='POST'){res.setHeader('Set-Cookie','sitetiller=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');const token=req.headers.cookie?.match(/sitetiller=([a-f0-9]+)/)?.[1];if(token){sessions.delete(token);}return response(res,200,{ok:true});}
    return response(res,404,{error:'Nenalezeno.'});
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return response(res,405,{error:'Nepovolená metoda.'});
  const asset=path==='/'?'index.html':path.slice(1);if(!['index.html','app.js','theme.js','i18n.js','translations.js','presentation.js','messages.js','style.css'].includes(asset))return response(res,404,{error:'Nenalezeno.'});
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self' https:; img-src 'self' blob: data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Robots-Tag','noindex, nofollow');res.writeHead(200,{'Content-Type':mime[extname(asset)],'Cache-Control':'no-store'});const assetBody=await readFile(join(root,'public',asset));res.end(asset==='index.html'?assetBody.toString().replace('<html lang="cs">','<html lang="'+(process.env.SITETILLER_UI_LANGUAGE==='en'?'en':'cs')+'">'):assetBody);
}catch(e:any){response(res,400,{error:e.message||'Požadavek nelze dokončit.'});}});
server.listen(PORT,HOST,()=>console.log(`SiteTiller listening on ${HOST}:${PORT}`));

