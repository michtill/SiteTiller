import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Project} from '../src/project.ts';import {workflow} from '../src/workflow.ts';import {initialTeam,initialImages,resolvePrimary} from '../src/team.ts';import {defaults} from '../src/core.ts';import {projectManifest} from '../src/manifest.ts';
const slots=[{provider:'openai' as const,key:'fake',...defaults.openai},{provider:'anthropic' as const,key:'fake-claude',...defaults.anthropic}];
const checked:any=async()=>({passed:true,errors:[],warnings:[],checks:[],screenshots:[]});
const criterion={id:'intent',category:'required',description:'Apply the requested change',basis:'User request'};
test('invalid browser step schema is repaired against the same candidate instead of failing the edit',async()=>fixture(async(p,root)=>{
 let calls=0;const model:any=async(client:any,_:any,input:any)=>{
  calls++;if(calls===1)return {value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* preserved */'}],browserTests:[{name:'Malformed',path:'site/index.html',steps:[{action:'expectValue',selector:'input'}]}]}};
  if(calls===2){assert.ok(input.files['site/style.css'].includes('preserved'));assert.ok(input.feedback.invalidBrowserTests);return {value:{action:'implement',files:[],browserTests:[{name:'Heading',path:'site/index.html',steps:[{action:'expectVisible',selector:'h1',visible:true}]}]}};}
  assert.equal(client.model,'gpt-6-luna');return {value:{status:'PASS',requiredFixes:[]}};
 };
 const result=await workflow(p,slots,'Change',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});assert.equal(result.tests.passed,true);assert.equal(calls,3);
}));
test('cleanup failure cannot replace the successful committed outcome or lose its evidence',async()=>fixture(async(p,root)=>{
 const events:any[]=[];const model:any=async(_:any,__:any,input:any)=>({value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* complete */'}]}});
 const result=await workflow(p,slots,'Change',join(root,'drafts'),e=>events.push(e),model,undefined,[],{check:checked,cleanup:async()=>{throw Error('ENOTEMPTY');}});
 assert.equal(await p.head(),result.commit);assert.equal(result.tests.passed,true);assert.equal(result.tests.warnings.length,1);assert.equal(events.at(-1).stage,'ready');assert.equal(events.some(e=>e.stage==='failed'),false);
}));
test('lead can delegate a missing-evidence repair after the first verifier failure',async()=>fixture(async(p,root)=>{
 let verifies=0;const seen:string[]=[];
 const model:any=async(client:any,_:any,input:any)=>{
  seen.push(client.model);
  if(client.model==='gpt-6-luna')return {value:++verifies===1?{status:'FAIL',requiredFixes:['Provide browser interaction evidence']}:{status:'PASS',requiredFixes:[]}};
  if(seen.length===1)return {value:{action:'implement',acceptance:[criterion],needsVerification:true,files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* change */'}]}};
  if(client.model==='gpt-6.1-sol'){assert.ok(input.feedback.requiredFixes[0].includes('interaction'));return {value:{action:'delegate',scope:'edit',task:'Provide browser interaction evidence using existing candidate.',paths:['site/index.html'],acceptance:[criterion]}};}
  return {value:{action:'implement',files:[],browserTests:[{name:'Actual heading',path:'site/index.html',steps:[{action:'expectVisible',selector:'h1',visible:true}]}]}};
 };
 const result=await workflow(p,slots,'Update',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});assert.equal(result.tests.browserTests.length,1);assert.deepEqual(seen,['gpt-6.1-sol','gpt-6-luna','gpt-6.1-sol','claude-sonnet-5-5','gpt-6-luna']);
}));
async function fixture(run:(p:Project,root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'sitetiller-flow-'));try{const p=new Project(join(root,'project'));await p.init(new URL('../seed',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'));await run(p,root);}finally{await rm(root,{recursive:true,force:true});}}
test('simple edit uses one Web Lead call and deterministic checks; missing optional providers do not block',async()=>fixture(async(p,root)=>{
 const before=await p.head(),calls:string[]=[];const model:any=async(client:any,_:any,input:any)=>{calls.push(client.model);assert.equal(client.reasoningEffort,'low');assert.ok(input.manifest.files.length);assert.ok(!JSON.stringify(input).includes('fake'));return {value:{action:'implement',summary:'Barva změněna.',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* simple */'}],model:'attacker',skipTests:true}};};
 const result=await workflow(p,[slots[0]],'Change button colour',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});
 assert.deepEqual(calls,['gpt-6.1-sol']);assert.notEqual(result.commit,before);assert.equal(result.tests.passed,true);assert.equal(result.tests.analysis,null);
}));
test('specialist implements directly with bounded context, followed by one read-only verifier',async()=>fixture(async(p,root)=>{
 await writeFile(join(p.root,'site/unrelated.txt'),'unrelated-secret-context');await p.commit('Extra content');
 const calls:string[]=[];const model:any=async(client:any,_:any,input:any)=>{
 calls.push(client.model);assert.ok(!Object.values(input.files||{}).includes('unrelated-secret-context'));
 if(calls.length===1)return {value:{action:'delegate',scope:'edit',task:'Redesign the hero in the existing design system.',paths:['site/index.html','site/style.css'],acceptance:[criterion]}};
 if(calls.length===2){assert.equal(input.task,'Redesign the hero in the existing design system.');return {value:{action:'implement',summary:'Design změněn.',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* redesign */'}]}};}
 assert.ok(input.diff.length);assert.equal(input.testResults.browser.passed,true);return {value:{status:'PASS',requiredFixes:[]}};
 };
 await workflow(p,slots,'Redesign hero',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});
 assert.deepEqual(calls,['gpt-6.1-sol','claude-sonnet-5-5','gpt-6-luna']);
}));
test('first failed check repairs with same agent; repeated failure escalates once',async()=>fixture(async(p,root)=>{
 const calls:string[]=[];let tests=0;const model:any=async(client:any,_:any,input:any)=>{
 calls.push(client.model);if(client.model==='gpt-6-luna')return {value:{status:'PASS',requiredFixes:[]}};
 if(calls.length>1)assert.ok(input.feedback.requiredFixes.includes('Required defect'));
 return {value:{action:'implement',summary:'Opraveno.',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* attempt */'}]}};
 };
 const check:any=async()=>({...await checked(),passed:++tests===3,errors:tests<3?['Required defect']:[]});
 await workflow(p,slots,'Fix layout',join(root,'drafts'),()=>{},model,undefined,[],{check});
 assert.deepEqual(calls,['gpt-6.1-sol','gpt-6.1-sol','gpt-6-astra','gpt-6-luna']);
}));
test('failed escalation preserves the exact project HEAD and files',async()=>fixture(async(p,root)=>{
 const head=await p.head(),files=await p.files();const model:any=async(_:any,__:any,input:any)=>({value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* fail */'}]}});
 const check:any=async()=>({...await checked(),passed:false,errors:['Required defect']});
 await assert.rejects(workflow(p,slots,'Fix layout',join(root,'drafts'),()=>{},model,undefined,[],{check}),/eskalaci/);
 assert.equal(await p.head(),head);assert.deepEqual(await p.files(),files);
}));
test('manifest is cached and refreshed after changes; lead requests files instead of receiving the repository',async()=>fixture(async(p,root)=>{
 await writeFile(join(p.root,'site/extra.txt'),'Extra section');await p.commit('Extra content');
 const first=await projectManifest(p,await p.files());assert.equal((await projectManifest(p,await p.files())).signature,first.signature);
 let round=0;const model:any=async(_:any,__:any,input:any)=>{
 if(++round===1){assert.equal(input.files['site/extra.txt'],undefined);return {value:{action:'read',paths:['site/extra.txt']}};}
 assert.equal(input.files['site/extra.txt'],'Extra section');return {value:{action:'implement',files:[{path:'site/extra.txt',content:'Updated section'}]}};
 };
 await workflow(p,slots,'Change extra section',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});
 assert.notEqual((await projectManifest(p,await p.files())).signature,first.signature);assert.equal(round,2);
}));
test('primary fallback is restricted to the configured Sol fallback',()=>{
 const team=initialTeam();const fallback=resolvePrimary(team,[{provider:'openai',id:'gpt-6-sol',usable:true}]);assert.equal(fallback.primary.model,'gpt-6-sol');assert.equal(team.primary.model,'gpt-6.1-sol');
 assert.equal(resolvePrimary(team,[]).primary.model,'gpt-6.1-sol');assert.equal(initialImages().precise,'gpt-image-2.5-sunburst');
});
test('agent cannot skip browser checks, change an unread file or choose an arbitrary model',async()=>fixture(async(p,root)=>{
 await writeFile(join(p.root,'site/extra.txt'),'Original');await p.commit('Extra content');const head=await p.head();
 const model:any=async()=>({value:{action:'implement',files:[{path:'site/extra.txt',content:'Unwanted'}]}});
 await assert.rejects(workflow(p,slots,'Edit',join(root,'drafts'),()=>{},model,undefined,[],{check:checked}),/nenačetl/);assert.equal(await p.head(),head);
}));

test('exceptionally hard task uses configured escalation with a concrete reason and independent verification',async()=>fixture(async(p,root)=>{
 const calls:string[]=[];const model:any=async(client:any,_:any,input:any)=>{
 calls.push(client.model);
 if(calls.length===1)return {value:{action:'escalate',scope:'edit',task:'Resolve interacting constraints in the existing stylesheet.',difficultyReason:'Conflicting responsive constraints require deeper debugging.',paths:['site/style.css'],acceptance:[criterion]}};
 if(client.model==='gpt-6-astra')return {value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* resolved */'}]}};
 return {value:{status:'PASS',requiredFixes:[]}};
 };
 await workflow(p,slots,'Resolve a very difficult layout issue',join(root,'drafts'),()=>{},model,undefined,[],{check:checked});
 assert.deepEqual(calls,['gpt-6.1-sol','gpt-6-astra','gpt-6-luna']);
}));
test('auto role settings adapt effort for delegated work and independent verification',async()=>fixture(async(p,root)=>{
 const team=initialTeam();team.primary.reasoningEffort='auto';team.verify.reasoningEffort='auto';let calls=0;
 const model:any=async(client:any,_:any,input:any)=>{
  calls++;if(calls===1){assert.equal(client.reasoningEffort,'low');return {value:{action:'delegate',scope:'edit',task:'Update hero',paths:['site/style.css'],acceptance:[criterion],effort:'high'}};}
  assert.equal(client.reasoningEffort,'high');if(client.model==='gpt-6-luna')return {value:{status:'PASS',requiredFixes:[]}};
  return {value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* auto effort */'}]}};
 };
 await workflow(p,slots,'Update hero',join(root,'drafts'),()=>{},model,team,[],{reasoningEffort:'auto',check:checked});assert.equal(calls,3);
}));
test('request effort reaches ordinary agents; escalation uses its separately configured effort',async()=>fixture(async(p,root)=>{
 const team=initialTeam();team.escalation.reasoningEffort='low';const seen:any[]=[];let checks=0;
 const model:any=async(client:any,_:any,input:any)=>{
  seen.push([client.model,client.reasoningEffort]);
  if(client.model==='gpt-6-luna')return {value:{status:'PASS',requiredFixes:[]}};
  if(seen.length===1)return {value:{action:'delegate',scope:'edit',resolvedRequest:'Update the hero',task:'Update the hero',paths:['site/style.css'],acceptance:[criterion],effort:'high'}};
  return {value:{action:'implement',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* effort test */'}]}};
 };
 const check:any=async()=>({...await checked(),passed:++checks===3,errors:checks<3?['Required defect']:[]});
 await workflow(p,slots,'Update hero',join(root,'drafts'),()=>{},model,team,[],{reasoningEffort:'medium',check});
 assert.deepEqual(seen,[['gpt-6.1-sol','medium'],['claude-sonnet-5-5','medium'],['claude-sonnet-5-5','medium'],['gpt-6-astra','low'],['gpt-6-luna','medium']]);
}));
