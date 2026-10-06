import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roleSlot, seal, unseal, safeSitePath, defaults, validateFiles } from '../src/core.ts';
import { callModel } from '../src/providers.ts';
import { Project } from '../src/project.ts';
import { workflow } from '../src/workflow.ts';
const openai={provider:'openai' as const,key:'key-A',...defaults.openai};
const claude={provider:'anthropic' as const,key:'key-B',...defaults.anthropic};
test('two independent keys: design and review use key one, build uses key two',()=>{
  assert.equal(roleSlot([openai,claude],'design').key,'key-A');assert.equal(roleSlot([openai,claude],'review').model,openai.highModel);assert.equal(roleSlot([openai,claude],'build').key,'key-B');assert.equal(roleSlot([openai,claude],'build').model,claude.lowModel);
});
test('single key fallback works in either slot without losing model tiers',()=>{
  for(const slots of [[openai,{...claude,key:''}],[{...openai,key:''},claude]]){
    const active=slots.find(s=>s.key)!;assert.equal(roleSlot(slots,'design').key,active.key);assert.equal(roleSlot(slots,'build').model,active.lowModel);assert.equal(roleSlot(slots,'review').model,active.highModel);
  }
  assert.throws(()=>roleSlot([{...openai,key:''}],'build'));
});
test('encrypted keys resist tampering',()=>{const key=randomBytes(32),encrypted=seal('private-api-key',key);assert.ok(!encrypted.includes('private-api-key'));assert.equal(unseal(encrypted,key),'private-api-key');assert.throws(()=>unseal(encrypted,randomBytes(32)));});
test('AI cannot write server, secret, traversal or hidden paths',()=>{for(const path of ['../.env','site/../../server.ts','site/.env','site/x.sh','src/server.ts','site/../site/a.html'])assert.throws(()=>safeSitePath('/app',path));assert.ok(safeSitePath('/app','site/style.css').endsWith('style.css'));});
test('tests catch missing local assets',()=>{const html='<!doctype html><html><head><title>X</title><meta name="viewport"><link href="missing.css"></head><body></body></html>';assert.ok(validateFiles({'site/index.html':html}).some(s=>s.includes('missing.css')));});
test('provider adapters use separate auth and reject provider errors without leaking key',async()=>{
  let captured:any;
  const fetcher:any=async(url:any,options:any)=>{captured={url,options};return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:'{"ok":true}'}]}]})};};
  assert.equal((await callModel({...openai,model:openai.highModel},'instruction',{},fetcher)).value.ok,true);assert.equal(captured.options.headers.Authorization,'Bearer key-A');assert.equal(JSON.parse(captured.options.body).store,false);
  const anthropicFetch:any=async(url:any,options:any)=>{captured={url,options};return {ok:true,json:async()=>({content:[{type:'text',text:'{"ok":true}'}]})};};
  await callModel({...claude,model:claude.lowModel},'instruction',{},anthropicFetch);assert.equal(captured.options.headers['x-api-key'],'key-B');
  await assert.rejects(callModel({...openai,model:openai.highModel},'x',{},(async()=>({ok:false,status:401,text:async()=> 'secret key-A'})) as any),e=>!String(e).includes('key-A'));
});
