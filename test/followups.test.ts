import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Project} from '../src/project.ts';import {workflow} from '../src/workflow.ts';import {defaults} from '../src/core.ts';
import {recentConversation,searchConversation,hydrateRecentMemory} from '../src/memory.ts';
const slots=[{provider:'openai' as const,key:'fake',...defaults.openai},{provider:'anthropic' as const,key:'fake-claude',...defaults.anthropic}];
const criterion={id:'brief',category:'required',description:'Create the requested complete website',basis:'User request'};
const checked:any=async()=>({passed:true,errors:[],warnings:[],checks:[],screenshots:[]});
test('new-site delegation repairs a missing scope and tolerates already removed old paths',async()=>fixture(async(p,root)=>{
 await p.write({'site/menu.html':html('Old menu','Old cafe')});await p.commit('Old menu');let calls=0;
 const model:any=async(client:any,_:any,input:any)=>{
  calls++;
  if(calls===1)return {value:{action:'delegate',task:'Build the new site',paths:['site/index.html'],acceptance:[criterion]}};
  if(calls===2){assert.ok(input.feedback.requiredFixes[0].includes('scope'));return {value:{action:'delegate',scope:'create',resolvedRequest:'Build a completely new fictional studio website without photos.',task:'Build a completely new fictional studio website without photos.',paths:['site/index.html','site/menu.html'],acceptance:[criterion]}};}
  if(client.model==='claude-sonnet-5-5'){assert.deepEqual(input.files,{});assert.equal(input.scope,'create');return {value:{action:'implement',deleteFiles:['site/menu.html'],files:[{path:'site/index.html',content:html('Studio','<h1>Studio</h1>')}]}};}
  assert.equal(client.model,'gpt-6-luna');return {value:{status:'PASS',requiredFixes:[]}};
 };
 const result=await workflow(p,slots,'Smaž celý web a vytvoř úplně nový web',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});
 assert.equal(result.scope,'create');assert.equal(calls,4);assert.ok(!(await p.files())['site/menu.html']);
}));
test('retry in create scope can read historical source without inheriting old text into the new candidate',async()=>fixture(async(p,root)=>{
 await p.write({'site/menu.html':html('Old menu','Old cafe')});await p.commit('Old menu');let calls=0;
 const conversation=recentConversation([{id:'brief',status:'failed',prompt:'Create a completely new studio with three staff and no photos.',error:'Unread old menu'},{id:'retry',status:'failed',prompt:'Try again',error:'Context missing'}],await p.head());
 const model:any=async(client:any,_:any,input:any)=>{
  calls++;
  if(calls===1){assert.equal(input.recentConversation.turns[0].applied,false);return {value:{action:'read',paths:['site/index.html']}};}
  if(calls===2){assert.ok(input.files['site/index.html']);return {value:{action:'implement',scope:'create',resolvedRequest:'Create a completely new studio with three staff and no photos.',acceptance:[criterion],files:[{path:'site/index.html',content:html('Studio','<h1>Studio</h1>')}]}};}
  assert.equal(client.model,'gpt-6-luna');assert.ok(input.resolvedRequest.includes('three staff'));return {value:{status:'PASS',requiredFixes:[]}};
 };
 const result=await workflow(p,slots,'Try again',join(root,'drafts'),()=>{},model,undefined,[],{mode:'create',conversation,check:checked});assert.equal(result.scope,'create');assert.ok(!(await p.files())['site/menu.html']);
}));
const html=(title:string,body:string)=>'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title></head><body>'+body+'</body></html>';
async function fixture(run:(p:Project,root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'aiwe-followup-'));try{const p=new Project(join(root,'project'));await p.init(new URL('../seed',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'));await run(p,root);}finally{await rm(root,{recursive:true,force:true});}}
test('"Ještě trochu" follows the last applied CSS target and passes resolved intent to the verifier',async()=>fixture(async(p,root)=>{
 const first:any=async(_:any,__:any,input:any)=>({value:{action:'implement',summary:'Tlačítko je tmavší.',files:[{path:'site/style.css',content:input.files['site/style.css'].replace('.button{background:var(--acid)','.button{background:#444')}]}});
 const result=await workflow(p,slots,'Ztmav tlačítko',join(root,'drafts'),()=>{},first,undefined,[],{check:checked});
 const records=[{id:'one',sequence:1,prompt:'Ztmav tlačítko',status:'ready',...result}];
 let calls=0;const next:any=async(client:any,_:any,input:any)=>{
  calls++;
  if(client.model==='gpt-6-luna'){assert.equal(input.request,'Ještě trochu');assert.equal(input.resolvedRequest,'Further darken .button background from #444 to #333.');return {value:{status:'PASS',requiredFixes:[]}};}
  const previous=input.recentConversation.turns.at(-1);assert.equal(previous.request,'Ztmav tlačítko');assert.ok(previous.deltas.some((d:any)=>d.selector==='.button'&&d.property==='background'&&d.after==='#444'));
  return {value:{action:'implement',resolvedRequest:'Further darken .button background from #444 to #333.',needsVerification:true,files:[{path:'site/style.css',content:input.files['site/style.css'].replace('.button{background:#444','.button{background:#333')}]}};
 };
 const second=await workflow(p,slots,'Ještě trochu',join(root,'drafts'),()=>{},next,undefined,[],{check:checked,conversation:recentConversation(records,await p.head())});
 assert.equal(calls,2);assert.ok((await p.files())['site/style.css'].includes('.button{background:#333'));assert.equal(second.memory.deltas.find((d:any)=>d.selector==='.button')?.before,'#444');
}));
test('Lead retrieves a targeted older change instead of receiving the full history',async()=>fixture(async(p,root)=>{
 const records=Array.from({length:12},(_,i)=>({id:String(i),sequence:i+1,status:'ready',prompt:i===0?'Original accent was blue':'Change '+i,commit:String(i),memory:{summary:'Done'}}));
 let calls=0;const model:any=async(_:any,__:any,input:any)=>{
  if(++calls===1){assert.equal(input.recentConversation.turns.length,6);assert.equal(input.recentConversation.turns.some((t:any)=>t.id==='0'),false);return {value:{action:'history',historyQuery:{query:'accent blue'}}};}
  assert.equal(input.historyResults[0].turns[0].id,'0');return {value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* restore earlier accent */'}]}};
 };
 const head=await p.head();await workflow(p,slots,'Use the older accent',join(root,'drafts'),()=>{},model,undefined,[],{check:checked,conversation:recentConversation(records,head),history:query=>searchConversation(records,query,head)});
 assert.equal(calls,2);
}));
test('a new site replaces obsolete text files in one reversible commit and restores the exact previous tree',async()=>fixture(async(p,root)=>{
 await p.write({'site/old-page.html':html('Old owner','Old content')});const base=await p.commit('Old page'),original=await p.files();
 let calls=0;const model:any=async(client:any,_:any,input:any)=>{
  calls++;
  if(client.model==='gpt-6-luna'){assert.equal(input.scope,'create');assert.ok(input.diff.some((d:any)=>d.path==='site/old-page.html'&&d.after===null));return {value:{status:'PASS',requiredFixes:[]}};}
  assert.deepEqual(input.files,{});assert.deepEqual(input.manifest.designSystem,[]);assert.equal(input.manifest.newWebsite,true);
  return {value:{action:'implement',scope:'create',summary:'Nový web kavárny je připravený.',acceptance:[criterion],files:[
   {path:'site/index.html',content:html('Cafe','<h1>Cafe</h1><a href="about/">About</a>')},
   {path:'site/about/index.html',content:html('About Cafe','<h1>About Cafe</h1><a href="../">Home</a>')}
  ]}};
 };
 const result=await workflow(p,slots,'Vytvoř web kavárny od nuly',join(root,'drafts'),()=>{},model,undefined,[],{mode:'create'});
 assert.equal(calls,2);assert.equal(result.scope,'create');assert.ok(!(await p.files())['site/old-page.html']);await assert.rejects(readFile(join(p.root,'site/old-page.html')));
 assert.ok((await p.committedFiles(base))['site/old-page.html']);assert.ok(result.tests.browser.checks.some((c:any)=>c.path==='site/about/index.html'));
 await p.restore(base,result.commit);assert.deepEqual(await p.files(),original);assert.ok(!(await p.files())['site/about/index.html']);
}));
test('a broad redesign stages dependent file changes without publishing an incomplete intermediate site',async()=>fixture(async(p,root)=>{
 const base=await p.head();let calls=0;const model:any=async(client:any,_:any,input:any)=>{
  calls++;
  if(calls===1)return {value:{action:'delegate',scope:'redesign',task:'Replace the stylesheet and redesign the whole site.',paths:['site/index.html','site/style.css'],acceptance:[criterion]}};
  assert.equal(input.recentConversation,undefined);assert.equal(input.historyResults,undefined);
  if(calls===2){assert.equal(await p.head(),base);return {value:{action:'stage',files:[{path:'site/theme.css',content:'body{margin:0;color:#222}'}],deleteFiles:['site/style.css']}};}
  if(calls===3){assert.equal(await p.head(),base);assert.ok((await p.files())['site/style.css']);assert.ok(input.feedback.removedPaths.includes('site/style.css'));return {value:{action:'implement',summary:'Web má nový design.',files:[{path:'site/index.html',content:input.files['site/index.html'].replace(/href="\/?style.css"/,'href="/theme.css"')}]}};}
  assert.equal(client.model,'gpt-6-luna');assert.ok(input.diff.some((d:any)=>d.path==='site/style.css'&&d.after===null));return {value:{status:'PASS',requiredFixes:[]}};
 };
 const result=await workflow(p,slots,'Předělej celý web',join(root,'drafts'),()=>{},model,undefined,[],{mode:'redesign',check:checked});
 assert.equal(calls,4);assert.equal(result.scope,'redesign');assert.ok((await p.files())['site/theme.css']);assert.ok(!(await p.files())['site/style.css']);assert.equal(await p.git(['rev-parse','HEAD^']),base);
}));
test('failed new-site validation preserves the entire old website',async()=>fixture(async(p,root)=>{
 const base=await p.head(),original=await p.files();
 const broken:any=async()=>({value:{action:'implement',acceptance:[criterion],files:[{path:'site/index.html',content:'incomplete website'}]}});
 await assert.rejects(workflow(p,slots,'New site',join(root,'drafts'),()=>{},broken,undefined,[],{mode:'create',check:checked}),/eskalaci/);
 assert.equal(await p.head(),base);assert.deepEqual(await p.files(),original);
}));
test('agents cannot delete unread files, binary originals or files outside the website',async()=>fixture(async(p,root)=>{
 await p.write({'site/extra.txt':'Original'});await p.commit('Extra');const head=await p.head();
 for(const target of ['site/extra.txt','../.env','src/server.ts']){
  const model:any=async()=>({value:{action:'implement',files:[],deleteFiles:[target]}});
  await assert.rejects(workflow(p,slots,'Delete',join(root,'drafts'),()=>{},model,undefined,[],{check:checked}));assert.equal(await p.head(),head);
 }
}));
test('new project initialization needs no imported website, and repeated initialization preserves existing content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aiwe-blank-'));try{
  const p=new Project(root);await p.init(null);const original=await p.head();assert.ok((await p.files())['site/index.html'].includes('Nový web'));assert.equal((await p.test()).passed,true);
  await p.write({'site/index.html':html('My site','<h1>My site</h1>')});const changed=await p.commit('Create');await p.init(null);assert.equal(await p.head(),changed);assert.notEqual(original,changed);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy requests recover precise change memory from Git once without an extra model call',async()=>fixture(async(p,root)=>{
 const base=await p.head(),original=await p.files();
 await p.write({'site/style.css':original['site/style.css'].replace('.button{background:var(--acid)','.button{background:#222')});const commit=await p.commit('Darken');
 const request:any={id:'old',sequence:1,prompt:'Darken the button',status:'ready',baseCommit:base,commit};
 await hydrateRecentMemory(p,[request]);assert.ok(request.memory.deltas.some((d:any)=>d.selector==='.button'&&d.property==='background'&&d.after==='#222'));
 const memory=request.memory;await hydrateRecentMemory(p,[request]);assert.equal(request.memory,memory);
}));
test('verifier receives trusted draft publication proof and a retry can validate an unchanged existing candidate',async()=>fixture(async(p,root)=>{
 let edits=0,verifications=0;
 const model:any=async(client:any,_:any,input:any)=>{
  if(client.model==='gpt-6-luna'){
   assert.equal(input.testResults.publication.publishInvoked,false);assert.equal(input.testResults.publication.unchanged,true);assert.equal(input.testResults.publication.publishedCommit,'previous-production');
   return {value:++verifications===1?{status:'FAIL',requiredFixes:['Repeat deterministic evidence collection']}:{status:'PASS',requiredFixes:[]}};
  }
  if(++edits===1)return {value:{action:'implement',needsVerification:true,files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* candidate */'}]}};
  return {value:{action:'implement',files:[]}};
 };
 const result=await workflow(p,slots,'Edit in draft',join(root,'drafts'),()=>{},model,undefined,[],{check:checked,publication:()=>({publishedCommit:'previous-production'})});
 assert.equal(result.tests.passed,true);assert.equal(result.tests.publication.unchanged,true);assert.equal(edits,2);assert.equal(verifications,2);
}));
