import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Project} from '../src/project.ts';import {checkPublication} from '../src/publication-check.ts';
test('technical publication checks reject stale, invalid and broken candidates without an AI approval',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-pub-check-test-'));
 try{
  const p=new Project(root);await p.init(null);const initial=await p.head();let calls=0;const browser:any=async()=>{calls++;return {passed:true,errors:[],checks:[],screenshots:[]};};
  const checked=await checkPublication(p,initial,initial,browser);assert.equal(checked.restoration.identical,true);assert.equal(checked.commit,initial);
  await p.write({'site/index.html':'<!doctype html><html><head><title>Broken</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>throw new Error("broken")</script></body></html>'});const broken=await p.commit('Broken');
  await assert.rejects(checkPublication(p,initial,undefined,browser),/mezitím změnil/);await assert.rejects(checkPublication(p,broken,initial,browser),/neodpovídají/);
  await assert.rejects(checkPublication(p,broken,undefined,async()=>({passed:false,errors:['JavaScript runtime error']} as any)),/runtime error/);
  await p.write({'site/index.html':'invalid'});const invalid=await p.commit('Invalid');await assert.rejects(checkPublication(p,invalid,undefined,browser),/Publikování zastaveno/);assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
