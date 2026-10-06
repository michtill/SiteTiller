import {attachmentPaths} from './attachment-paths.ts';
import {validateBrowserTests,browserTestContract} from './browser-scenarios.ts';
import {withRules} from './instructions.ts';
import {routeTask,editContract} from './orchestrator.ts';
import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {safeSitePath,type Slot} from './core.ts';
import {clientFor,initialTeam,initialImages,type Team,type Role,type ImageChoices} from './team.ts';
import {callModel} from './providers.ts';
import {Project} from './project.ts';
import {editImage,generateImage,websiteImages,capabilityImage} from './image-editor.ts';
import {raster} from './images.ts';
import {projectManifest,initialContext,selectContext} from './manifest.ts';
import {staticChecks,browserChecks} from './checks.ts';
import {changeMemory} from './memory.ts';
export type ReturnTypeClient=ReturnType<typeof clientFor>;
export type Scope='edit'|'redesign'|'create';
type Options={cleanup?:(path:string)=>Promise<void>;reasoningEffort?:'auto'|'low'|'medium'|'high';mode?:Scope;conversation?:any;history?:(query:any)=>Promise<any>|any;publication?:()=>{publishedCommit:string|null};model?:string|null;call?:typeof editImage;generate?:typeof generateImage;imageModels?:ImageChoices;availableModels?:{provider:string;id:string;usable:boolean}[];check?:typeof browserChecks};
const specialistInstruction=withRules('ui','Implement the bounded UI/CODE task. Do not add a planning round or re-analyze the project. In edit scope preserve existing behavior and unrelated content; respect its design system. In create scope build from the new brief without inheriting old content or design; obsolete text files have already been removed from the candidate. In redesign scope replace the requested design and structure. Request exact missing paths only when necessary. Return changed files and concrete required checks. '+editContract);
const escalationInstruction=withRules('escalation','Fix the supplied repeated failure with a minimal implementation. Use only the request, acceptance, relevant files and concrete errors. No new roles or scope expansion. '+editContract);
const verifierInstruction=withRules('verify','Verify only necessary requirements against the original request, acceptance, changed files and deterministic test/screenshot evidence. No edits or optional improvements. Browser interactions are actual executed open/close tests, including aria-expanded and visibility. testResults.publication is trusted runtime evidence: this isolated workflow cannot invoke publishing, and the captured published commit must remain unchanged. Accept this evidence for draft-only requirements; do not request content edits to prove an operation controlled by the host. Return only JSON {status:"PASS"|"FAIL",requiredFixes:string[]}. PASS requires adequate supplied evidence for each required criterion. FAIL must contain concrete necessary corrections, including missing evidence when a requirement cannot be checked.');
function acceptance(value:any){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>40||value.some(c=>!c||typeof c.id!=='string'||!c.id||!['required','preference'].includes(c.category)||typeof c.description!=='string'||typeof c.basis!=='string'||!c.basis.trim())||new Set(value.map(c=>c.id)).size!==value.length)throw Error('Neplatná akceptační kritéria.');
 return value;
}
function assertAvailable(team:Team,role:Role,options:Options){
 const choice=team[role];
 if(options.availableModels&&!options.availableModels.some(m=>m.provider===choice.provider&&m.id===choice.model&&m.usable))throw Error(role+': nakonfigurovaný model není dostupný.');
}
export async function workflow(project:Project,slots:Slot[],prompt:string,draftRoot:string,emit:(event:any)=>void,modelCall=callModel,team:Team=initialTeam(slots),images:any[]=[],options:Options={}){
 images=images.map(i=>i.use==='auto'?{...i,use:'website',automaticUse:true}:i);
 const keys={openai:slots.find(s=>s.provider==='openai'&&s.key)?.key||'',anthropic:slots.find(s=>s.provider==='anthropic'&&s.key)?.key||''};
 const original=await project.files(),baseCommit=await project.head(),manifest=await projectManifest(project,original);
 const initialPublication=options.publication?.();
 const requestedEffort=options.reasoningEffort==='auto'?undefined:options.reasoningEffort;
 if(options.reasoningEffort&&!['auto','low','medium','high'].includes(options.reasoningEffort))throw Error('Neplatná míra uvažování.');
 let scope:Scope=options.mode||'edit';if(!['edit','redesign','create'].includes(scope))throw Error('Neplatný rozsah změny.');
 let files=scope==='create'?Object.fromEntries(Object.entries(original).filter(([path])=>raster(path))):{...original},context=scope==='create'?{}:initialContext(original),role:Role='primary',feedback:any=null,task=prompt,resolvedRequest=prompt,effort:'low'|'medium'|'high'=requestedEffort||(team.primary.reasoningEffort==='auto'?'low':team.primary.reasoningEffort)||'low';
 let needsVerification=scope!=='edit',failures=0,readRounds=0,historyRounds=0,escalationCalls=0,protocolRepairs=0,staged=false,finalSummary='',plan:any={summary:'',steps:[],acceptance:[]};
 const observed=new Set(Object.keys(context)),historyResults:any[]=[];
 let browserTests:any[]=[];let delegations=0,scenarioRepairs=0,pathRepairs=0;
 const generated:any[]=[],imageResults:any[]=[],seenImages=new Set<string>();
 const attachmentInfo=images.map(({data,...item})=>({...item,...(item.use==='website'?{path:'site/assets/'+item.id,publicUrl:'assets/'+item.id,immutable:true}:{})}));
 const attachmentPath=attachmentPaths(images);
 const existingImages=images.length?await websiteImages(project,baseCommit,original):[];
 let vision:any[]=[...images,...existingImages];
 for(const image of images.filter(i=>i.use==='website'))files['site/assets/'+image.id]='[Binary image asset]';
 const imageChoices=options.imageModels||initialImages();
 const imageAvailable=(capability:keyof ImageChoices)=>!!keys.openai&&options.model!==null&&(options.model?(!options.availableModels||options.availableModels.some(m=>m.provider==='openai'&&m.id===options.model)):imageChoices[capability]!=='none'&&(!options.availableModels||options.availableModels.some(m=>m.provider==='openai'&&m.id===imageChoices[capability])));
 for(let round=0;round<12;round++){
  for(const image of images.filter(i=>i.automaticUse))files['site/assets/'+image.id]='[Binary image asset]';
  assertAvailable(team,role,options);
  const client={...clientFor(team,keys,role),reasoningEffort:role==='escalation'?(team.escalation.reasoningEffort==='auto'? 'high':team.escalation.reasoningEffort||'high'):requestedEffort||(role==='primary'?effort:team[role].reasoningEffort==='auto'?effort:team[role].reasoningEffort)};
  const input={originalRequest:prompt,request:role==='primary'?prompt:resolvedRequest,resolvedRequest,task,scope,reasoningPreference:options.reasoningEffort||'auto',
   ...(role==='primary'?{recentConversation:options.conversation||{currentHead:baseCommit,turns:[]},historyResults}:{}),
   manifest:scope==='create'?{...manifest,newWebsite:true,designSystem:[],files:Object.keys(files).map(path=>({path,type:raster(path)?'image':path.split('.').at(-1)}))}:manifest,
   files:context,acceptance:plan.acceptance,feedback,browserTests,imageResults,attachments:attachmentInfo,
   capabilities:{interactionTests:browserTestContract,imageEditing:imageAvailable('precise')||imageAvailable('cheap'),imageGeneration:imageAvailable('fast')||imageAvailable('cheap'),images:{precise:imageAvailable('precise'),fast:imageAvailable('fast'),cheap:imageAvailable('cheap')},editableFiles:'static site text files',browser:'isolated local smoke tests; external services blocked'},_images:vision};
  let result:any;
  if(role==='primary')result=await routeTask(client,input,emit,modelCall);
  else{
   if(role==='escalation'&&++escalationCalls>2)throw Error('Úloha překročila limit eskalace.');
   emit({stage:role==='ui'?'design':'escalation',status:'running',message:role==='ui'?'Provádím větší úpravu webu.':'Řeším opakovanou chybu.',provider:client.provider,model:client.model});
   result=await modelCall(client,role==='ui'?specialistInstruction:escalationInstruction,input);
  }
  const value=result?.value;if(!value||!['implement','stage','read','history','delegate','escalate','image','blocked'].includes(value.action))throw Error('Agent nevrátil platnou akci.');
  if(Array.isArray(value.paths))value.paths=value.paths.map(attachmentPath);
  if(Array.isArray(value.imageEdits))for(const item of value.imageEdits)if(item?.source)item.source=attachmentPath(item.source);
  const proposedPaths=[...(Array.isArray(value.paths)?value.paths:[]),...(Array.isArray(value.files)?value.files.map((f:any)=>f?.path):[]),...(Array.isArray(value.deleteFiles)?value.deleteFiles:[]),...(Array.isArray(value.imageEdits)?value.imageEdits.flatMap((i:any)=>[i?.source,i?.target].filter(p=>p!==undefined)):[])];
  try{for(const path of proposedPaths)safeSitePath(project.root,path);}
  catch(e:any){
   if(++pathRepairs>2)throw Error('Nepodařilo se opravit cestu k souboru: '+e.message);
   feedback={requiredFixes:[e.message],proposedPaths,availablePaths:Object.keys(files),instruction:'Correct only the invalid file paths. All project paths begin with site/. Website attachments already exist at attachment.path; use attachment.publicUrl in HTML/CSS. Preserve the uploaded original; do not call image generation for simply placing it.'};emit({stage:'build',status:'running',message:'Opravuji odkaz na soubor.'});continue;
  }
  if(role==='primary'&&['delegate','escalate'].includes(value.action)&&value.scope===undefined){
   if(++protocolRepairs>1)throw Error('Web Lead neurčil rozsah před předáním úlohy.');
   feedback={requiredFixes:[...(feedback?.requiredFixes||[]),'Before delegation return explicit scope edit/redesign/create and a self-contained resolvedRequest. A request to replace the whole website requires create. No implementation has been applied.']};continue;
  }
  if(role==='primary'&&value.scope!==undefined){
   if(!['edit','redesign','create'].includes(value.scope)||staged&&value.scope!==scope||options.mode&&options.mode!=='edit'&&value.scope!==options.mode)throw Error('Agent změnil explicitní nebo již rozpracovaný rozsah.');
   if(value.scope==='create'&&scope!=='create'){files=Object.fromEntries(Object.entries(files).filter(([path])=>raster(path)));context={};}
   scope=value.scope;if(scope!=='edit')needsVerification=true;
  }
  if(role==='primary'&&value.resolvedRequest!==undefined){if(typeof value.resolvedRequest!=='string'||!value.resolvedRequest.trim()||value.resolvedRequest.length>6000)throw Error('Neplatné upřesnění navazujícího požadavku.');resolvedRequest=value.resolvedRequest;task=resolvedRequest;}
  if(role==='primary'&&value.acceptance!==undefined)plan.acceptance=acceptance(value.acceptance);
  if(value.needsVerification===true)needsVerification=true;
  if(value.summary)finalSummary=String(value.summary).slice(0,2000);
  if(value.action==='blocked'){const blocked=new Error(value.blockedReason||'Požadavek vyžaduje nepodporovanou funkci.');(blocked as any).agentResponse=!!value.blockedReason;throw blocked;}
  if(value.action==='history'){
   if(role!=='primary'||!options.history||++historyRounds>2)throw Error('Historie pro tuto úlohu není dostupná nebo překročila limit dotazů.');
   historyResults.push(await options.history(value.historyQuery));continue;
  }
  if(!requestedEffort&&team.primary.reasoningEffort==='auto'&&role==='primary'&&['medium','high'].includes(value.effort))effort=value.effort;
  if(value.action==='read'){
   if(++readRounds>3)throw Error('Agent překročil limit načítání kontextu.');
   const readable=scope==='create'?{...original,...files}:files;let loaded:Record<string,string>;
   try{loaded=selectContext(readable,value.paths);context=selectContext(readable,[...new Set([...Object.keys(context),...Object.keys(loaded)])]);}
   catch(e:any){feedback={requiredFixes:[e.message],availablePaths:Object.keys(readable),instruction:'Correct the requested file paths. Website attachments already exist at their exact attachment.path and publicUrl. Use the provided original bytes; do not regenerate or edit an uploaded image when the user only asks to place it.'};emit({stage:'build',status:'running',message:'Upřesňuji cestu k souboru.'});continue;}
   for(const path of Object.keys(loaded))observed.add(path);
   const requestedImages=Object.keys(loaded).filter(raster);
   for(const path of requestedImages){if(!vision.some(i=>i.path===path)&&original[path])vision.push({path,mime:(await import('./images.ts')).imageMime(path),data:(await project.binary(baseCommit,path)).toString('base64')});}
   continue;
  }
  if(value.action==='delegate'||value.action==='escalate'){
   if(role!=='primary'||failures>1||escalationCalls||++delegations>1||typeof value.task!=='string'||!value.task.trim()||value.task.length>10000)throw Error('Neplatné předání úlohy specialistovi.');
   if(value.action==='escalate'&&(typeof value.difficultyReason!=='string'||!value.difficultyReason.trim()))throw Error('Eskalační úloha potřebuje konkrétní důvod obtížnosti.');
   if(!plan.acceptance.length)throw Error('Specialista potřebuje akceptační kritéria.');
   const paths=value.paths||Object.keys(context);if(scope==='create')for(const path of paths)safeSitePath(project.root,path);context=selectContext(files,scope==='create'?paths.filter((path:string)=>Object.hasOwn(files,path)||!Object.hasOwn(original,path)):paths);for(const path of Object.keys(context))observed.add(path);task=value.task;role=value.action==='escalate'?'escalation':'ui';needsVerification=true;continue;
  }
  if(value.action==='image'){
   if(role!=='primary')throw Error('Obrazový nástroj může volat pouze Web Lead.');
   if(!Array.isArray(value.imageEdits)||!value.imageEdits.length||imageResults.length+value.imageEdits.length>2)throw Error('V jednom požadavku lze vytvořit nejvýše dva obrázky.');
   // Validate the whole batch before spending on any image.
   const tasks=value.imageEdits.map((image:any)=>{
    if(typeof image.prompt!=='string'||!image.prompt.trim()||image.prompt.length>10000)throw Error('Neplatné zadání obrázku.');
    if(image.source){safeSitePath(project.root,image.source);if(!raster(image.source)||seenImages.has(image.source))throw Error('Neplatný zdroj obrázku.');seenImages.add(image.source);
     if(!original[image.source]&&!images.some(i=>i.use==='website'&&'site/assets/'+i.id===image.source))throw Error('Zdrojový obrázek není součástí webu ani webovou přílohou.');}
    const capability=image.capability||(image.source?'precise':'fast');if(!['precise','fast','cheap'].includes(capability))throw Error('Neplatná obrazová capability.');
    const model=options.model===null?null:options.model||capabilityImage(capability,imageChoices,options.availableModels);
    if(!keys.openai||!model)throw Error('Obrázky potřebují dostupný obrazový model a OpenAI API klíč.');
    const format=image.format||(image.target?.endsWith('.png')?'png':/\.jpe?g$/.test(image.target||'')?'jpeg':'webp');
    if(!['png','webp','jpeg'].includes(format))throw Error('Neplatný formát obrázku.');
    if(image.target){safeSitePath(project.root,image.target);if(!/^site\/assets\/[a-zA-Z0-9_-]+\.(png|webp|jpe?g)$/.test(image.target)||files[image.target])throw Error('Cílový obrázek musí mít novou bezpečnou cestu.');const ext=image.target.split('.').at(-1);if(format==='jpeg'?!['jpg','jpeg'].includes(ext):format!==ext)throw Error('Název obrázku neodpovídá formátu.');}
    return {...image,model,format};
   });
   if(new Set(tasks.filter(t=>t.target).map(t=>t.target)).size!==tasks.filter(t=>t.target).length)throw Error('Cílové cesty obrázků se opakují.');
   for(const image of tasks){
    emit({stage:'image',status:'running',message:'Připravuji obrázek.',model:image.model,provider:'openai'});
    const uploaded=images.find(i=>i.use==='website'&&'site/assets/'+i.id===image.source);
    const source=image.source?uploaded||{data:(await project.binary(baseCommit,image.source)).toString('base64'),mime:(await import('./images.ts')).imageMime(image.source)}:null;
    const edited=source?await(options.call||editImage)(keys.openai,image.model,source,image.prompt,undefined,{format:image.format}):await(options.generate||generateImage)(keys.openai,image.model,image.prompt,undefined,{format:image.format});
    const path=image.target||'site/assets/'+edited.id;if(files[path])throw Error('Obrázek nevytvořil samostatnou novou verzi.');
    generated.push({...edited,id:path.slice('site/assets/'.length),path,use:'website'});files[path]='[Binary image asset]';
    imageResults.push({source:image.source||null,path,format:edited.mime,prompt:image.prompt});
    if(source&&!vision.some(i=>i.path===image.source))vision.push({...source,path:image.source});
    vision.push({...edited,path});context[path]='[Binary image asset]';
    emit({stage:'image',status:'completed',message:'Obrázek je připraven.',model:image.model,provider:'openai',usage:edited.usage});
   }
   needsVerification=true;feedback={imageResults,instruction:'Integrate the exact returned asset paths. Originals are preserved.'};continue;
  }
  const deletes=value.deleteFiles||[];
  if(!Array.isArray(value.files)||value.files.length>60||!Array.isArray(deletes)||deletes.length>120||deletes.some((path:any)=>typeof path!=='string')||new Set(deletes).size!==deletes.length||new Set(value.files.map((item:any)=>item.path)).size!==value.files.length)throw Error('Neplatná změna souborů.');
  const hasCandidateChange=[...new Set([...Object.keys(original),...Object.keys(files)])].some(path=>original[path]!==files[path]);
  if(!value.files.length&&!deletes.length&&!generated.length&&!staged&&!hasCandidateChange)throw Error('Agent neprovedl žádnou změnu.');
  for(const path of deletes){
   safeSitePath(project.root,path);if(raster(path)||(!Object.hasOwn(files,path)&&!(scope==='create'&&Object.hasOwn(original,path)))||scope!=='create'&&!observed.has(path)||value.files.some((item:any)=>item.path===path))throw Error('Agent nesmí odstranit nenačtený nebo chráněný soubor: '+path);
  }
  for(const item of value.files){
   safeSitePath(project.root,item.path);if(raster(item.path)||typeof item.content!=='string'||Buffer.byteLength(item.content)>300000)throw Error('Neplatný textový soubor.');
   if(original[item.path]&&scope!=='create'&&!observed.has(item.path))throw Error('Agent nesmí měnit soubor, který nenačetl: '+item.path);
  }
  for(const path of deletes){delete files[path];delete context[path];}
  for(const item of value.files){
   files[item.path]=item.content;context[item.path]=item.content;
   observed.add(item.path);
  }
  if(Object.keys(files).length>200)throw Error('Web překročil limit 200 souborů.');
  if(value.action==='stage'){
   staged=true;needsVerification=true;feedback={stagedPaths:value.files.map((item:any)=>item.path),removedPaths:deletes,instruction:'These changes exist only in the isolated candidate. Finish the remaining website; use implement when complete.'};
   emit({stage:'build',status:'running',message:'Připravuji další část webu.',provider:client.provider,model:client.model});continue;
  }
  if(value.browserTests!==undefined){
   try{browserTests=validateBrowserTests(value.browserTests,files);needsVerification=true;}
   catch(e:any){
    if(++scenarioRepairs>2)throw Error('Nepodařilo se připravit test prohlížeče: '+e.message);
    feedback={requiredFixes:[e.message],invalidBrowserTests:value.browserTests,contract:browserTestContract,instruction:'Repair only the browser test schema. The candidate files and generated image assets are already preserved. Return implement with files:[] and corrected browserTests; do not regenerate images or claim tests ran.'};
    emit({stage:'test',status:'rejected',message:'Opravuji zadání testu prohlížeče.',errors:[e.message]});continue;
   }
  }
  if(scope!=='edit'&&!plan.acceptance.length)throw Error('Nový web nebo předělávka potřebuje akceptační kritéria.');
  const changed=[...new Set([...Object.keys(original),...Object.keys(files)])].filter(path=>files[path]!==original[path]);
  const functional=(text:string)=>[...text.matchAll(/<(?:form|script|iframe)\b[\s\S]*?<\/(?:form|script|iframe)>|\bon[a-z]+\s*=\s*["'][^"']*["']/gi)].map(m=>m[0]).join('\n');
  if(changed.some(p=>p.endsWith('.js'))||value.files.some((f:any)=>/\.html$/.test(f.path)&&functional(f.content)!==functional(original[f.path]||'')))needsVerification=true;
  for(const image of images.filter(i=>i.automaticUse)){const path='site/assets/'+image.id;if(!original[path]&&!Object.entries(files).some(([p,t])=>!raster(p)&&t.includes(path.slice(5)))&&!imageResults.some(i=>i.source===path)){delete files[path];delete context[path];}}
  const tests=staticChecks(files);
  for(const image of imageResults)if(!Object.entries(files).some(([p,t])=>!raster(p)&&t.includes(image.path.slice(5))))tests.errors.push('Nový obrázek není použitý na webu: '+image.path);
  tests.passed=tests.errors.length===0;
  emit({stage:'test',status:'running',message:'Ověřuji soubory a zobrazení webu.'});
  let browser:any={passed:false,errors:[],checks:[],screenshots:[]},verified:any=null,completion:any=null;
  await mkdir(draftRoot,{recursive:true});const path=join(draftRoot,'job-'+Date.now());
  try{
   if(tests.passed){
    await cp(project.root,path,{recursive:true});const draft=new Project(path);await draft.writeSnapshot(files);
    for(const image of [...images.filter(i=>i.use==='website'),...generated].filter(i=>Object.hasOwn(files,'site/assets/'+i.id))){await mkdir(join(path,'site/assets'),{recursive:true});await writeFile(join(path,'site/assets',image.id),Buffer.from(image.data,'base64'));}
    browser=await(options.check||browserChecks)(path,files,browserTests);
    const currentPublication=options.publication?.(),publication={mode:'isolated-unpublished-draft',publishInvoked:false,baselinePublishedCommit:initialPublication?.publishedCommit??null,publishedCommit:currentPublication?.publishedCommit??null,unchanged:initialPublication?.publishedCommit===currentPublication?.publishedCommit,source:'AIWE host workflow and captured application publication state; publication endpoint is separate and locked while the edit runs'};
    if(browser.passed&&needsVerification){
     assertAvailable(team,'verify',options);const verifier={...clientFor(team,keys,'verify'),...(requestedEffort?{reasoningEffort:requestedEffort}:team.verify.reasoningEffort==='auto'?{reasoningEffort:effort}:{})};
     emit({stage:'verify',status:'running',message:'Ověřuji splnění zadání.',model:verifier.model,provider:verifier.provider});
     const diff=changed.map(path=>({path,before:original[path]||null,after:files[path]||null}));
     const response=await modelCall(verifier,verifierInstruction,{originalRequest:prompt,request:prompt,resolvedRequest,scope,acceptance:plan.acceptance,diff,imageResults,testResults:{static:tests,browser:{...browser,screenshots:undefined},publication},_images:[...vision,...browser.screenshots]});
     verified=response.value;
     if(!verified||!['PASS','FAIL'].includes(verified.status)||!Array.isArray(verified.requiredFixes)||verified.requiredFixes.some((x:any)=>typeof x!=='string')||verified.status==='FAIL'&&!verified.requiredFixes.length||verified.status==='PASS'&&verified.requiredFixes.length)throw Error('Verifier nevrátil platný PASS/FAIL.');
     emit({stage:'verify',status:verified.status==='PASS'?'completed':'rejected',message:verified.status==='PASS'?'Zadání prošlo kontrolou.':'Kontrola našla nutné opravy.',issues:verified.requiredFixes,model:verifier.model,provider:verifier.provider,usage:response.usage});
    }
    if(browser.passed&&(!needsVerification||verified?.status==='PASS')){
     if(await project.head()!==baseCommit)throw Error('Projekt se mezitím změnil.');
     const commit=await draft.commit('AIWE: '+prompt.replace(/\s+/g,' ').slice(0,110));
     if(await project.head()!==baseCommit)throw Error('Projekt se mezitím změnil.');
     await project.git(['fetch',path,'main']);await project.git(['merge','--ff-only','FETCH_HEAD']);
     plan.summary=finalSummary;
     emit({stage:'test',status:'completed',message:'Automatické kontroly prošly.'});
     emit({stage:'build',status:'completed',message:finalSummary||'Úprava webu dokončena.',agentResponse:!!finalSummary,model:client.model,provider:client.provider,usage:result.usage});
     emit({stage:'ready',message:'Návrh je připravený. Můžeš jej publikovat.',commit,baseCommit});
     completion={commit,baseCommit,scope,resolvedRequest,memory:changeMemory(original,files,finalSummary),plan,imageResults,review:null,tests:{passed:true,errors:[],browserTests,static:tests,browser:{...browser,screenshots:undefined},publication,analysis:verified}};return completion;
    }
   }
  }finally{
   try{await(options.cleanup?options.cleanup(path):rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:200}));}
   catch{
    const warning='Úklid dočasné pracovní kopie se nepodařil. Výsledek kontrol ani uložený návrh to nemění.';
    if(completion){completion.tests.warnings=[warning];emit({stage:'ready',message:'Návrh je připravený. Můžeš jej publikovat.',commit:completion.commit,baseCommit,warnings:[warning]});}
    else emit({stage:'test',status:'warning',warnings:[warning]});
   }
  }
  feedback={requiredFixes:[...tests.errors,...browser.errors,...(verified?.requiredFixes||[])]};
  emit({stage:'test',status:'rejected',message:'Kontrola našla nutné opravy.',errors:feedback.requiredFixes});
  failures++;if(failures>=3||role==='escalation'&&escalationCalls>=2)throw Error('Změna neprošla kontrolou ani po eskalaci. Původní náhled zůstal zachován.');
  if(failures===2){role='escalation';needsVerification=true;}
  // Keep the same implementer for the first repair; escalation is resolved from configuration.
  if(!requestedEffort&&team.primary.reasoningEffort==='auto'&&role==='primary'&&failures&&effort==='low')effort='medium';
 }
 throw Error('Úloha překročila limit modelových volání. Původní náhled zůstal zachován.');
}

