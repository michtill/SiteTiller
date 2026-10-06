import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Project} from '../src/project.ts';
import {workflow} from '../src/workflow.ts';
import {reviewChanges} from '../src/review.ts';
import {defaults} from '../src/core.ts';
import {catalog,unavailable} from '../src/catalog.ts';
import {pendingRequests} from '../src/journal.ts';
import type {Team} from '../src/team.ts';
const team:Team={primary:{provider:'openai',model:'gpt-design'},ui:{provider:'anthropic',model:'claude-build'},verify:{provider:'openai',model:'gpt-test'},escalation:{provider:'anthropic',model:'claude-review'}};
test('cumulative review includes every request and rejects missing or failed per-request checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aiwe-review-'));try{
  const project=new Project(join(root,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));const base=await project.head();
  const requests=[{id:'one',sequence:1,prompt:'Change title'},{id:'two',sequence:2,prompt:'Change colour'}];let captured:any;
  const client={provider:'anthropic' as const,key:'B',model:'claude-review',...defaults.anthropic};
  const model:any=async(_:any,__:any,input:any)=>{captured=input;return {value:{status:'FAIL',requiredFixes:['Second request unmet']}};};
  assert.equal((await reviewChanges(project,client,requests,base,()=>{},model,[],(async()=>({passed:true,errors:[],checks:[],screenshots:[]})) as any)).review.approved,false);assert.deepEqual(captured.requests.map((r:any)=>[r.id,r.prompt]),requests.map(r=>[r.id,r.prompt]));
  const complete:any=async()=>({value:{status:'PASS',requiredFixes:[]}});
  assert.equal((await reviewChanges(project,client,requests,base,()=>{},complete,[],(async()=>({passed:true,errors:[],checks:[],screenshots:[]})) as any)).review.approved,true);
  assert.equal(pendingRequests(requests,1).length,1);assert.equal(pendingRequests(requests,2).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('model catalog lists both accounts, paginates Claude and reports unavailable selections without exposing keys',async()=>{
 let pages=0;const fake:any=async(url:string,options:any)=>{if(url.includes('openai.com')){assert.equal(options.headers.Authorization,'Bearer A');return {ok:true,json:async()=>({data:[{id:'gpt-design'},{id:'gpt-test'},{id:'gpt-image-1'}]})};}assert.equal(options.headers['x-api-key'],'B');return {ok:true,json:async()=>++pages===1?{data:[{id:'claude-build'}],has_more:true,last_id:'claude-build'}:{data:[{id:'claude-review'}],has_more:false}};};
 const list=await catalog({openai:'A',anthropic:'B'},fake);assert.equal(list.models.length,5);assert.equal(list.models.find(m=>m.id==='gpt-image-1')?.usable,false);assert.deepEqual(unavailable(team,list),[]);
 assert.ok(unavailable({...team,verify:{provider:'openai',model:'gpt-missing'}},list)[0].includes('gpt-missing'));
 const failed=await catalog({openai:'secret',anthropic:''},(async()=>({ok:false,status:401})) as any);assert.ok(failed.providers[0].error?.includes('401'));assert.ok(!JSON.stringify(failed).includes('secret'));
});
