import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Project} from '../src/project.ts';import {importWebsite} from '../src/web-import.ts';import {compareReality,loadReality} from '../src/reality.ts';import {visibleVersionHistory,closePublishedHistory} from '../src/publication-history.ts';
const html=(text:string)=>'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live</title><link href="/style.css" rel="stylesheet"></head><body><h1>'+text+'</h1></body></html>';
const fetcher:any=async(url:string)=>({url,mime:url.endsWith('.css')?'text/css':'text/html',bytes:Buffer.from(url.endsWith('.css')?'body{color:#123}':html('Live'))});
const check:any=async()=>({passed:true,errors:[],screenshots:[],checks:[]});
async function fixture(fn:any){const root=await mkdtemp(join(tmpdir(),'sitetiller-reality-'));try{const p=new Project(join(root,'project'));await p.init(null);await fn(p);}finally{await rm(root,{recursive:true,force:true});}}
test('comparison is read-only and first load creates Version 0 while retaining older editing steps',async()=>fixture(async(p:Project)=>{
 const original=await p.head(),config:any={requests:[{id:'old',sequence:1,status:'ready',commit:original,prompt:'Prior edit'}],releases:[],requestSequence:1,reviewedThrough:0};const snapshot=await importWebsite('https://example.org/',fetcher);
 const report=await compareReality(p,config,original,snapshot);assert.equal(report.equal,false);assert.equal(report.baseline,null);assert.equal(await p.head(),original);assert.equal(config.releases.length,0);
 const result=await loadReality(p,config,snapshot,original,false,check,true,0);assert.equal(result.first,true);assert.equal(config.releases[0].number,0);assert.equal(config.releases[0].imported,true);assert.equal(config.publishedCommit,result.commit);assert.equal(config.requests.length,2);
 assert.ok(visibleVersionHistory(await p.history(null),config).some((r:any)=>r.commit===original));closePublishedHistory(config,[]);assert.equal(config.requests.length,2);
 const same=await compareReality(p,config,result.commit,snapshot);assert.equal(same.equal,true);assert.equal(same.changes.length,0);
 const external=await importWebsite('https://example.org/',async(url)=>({...await fetcher(url),bytes:Buffer.from(url.endsWith('.css')?'body{color:#123}':html('External change'))}));
 const changed=await compareReality(p,config,result.commit,external);assert.equal(changed.changes[0].liveChanged,true);assert.equal(changed.changes[0].draftChanged,false);assert.equal(await p.head(),result.commit);
}));
test('clearing edits preserves Version 0 and subsequent loads do not create or overwrite saved versions',async()=>fixture(async(p:Project)=>{
 const original=await p.head(),config:any={requests:[{id:'old',sequence:1,status:'ready',commit:original}],releases:[],requestSequence:1};const snapshot=await importWebsite('https://example.org/',fetcher);
 const first=await loadReality(p,config,snapshot,original,true,check,true,0);assert.equal(config.requests.length,1);assert.equal(config.releases.length,1);const zero=structuredClone(config.releases[0]);
 const next=await loadReality(p,config,snapshot,first.commit,true,check);assert.equal(next.first,false);assert.equal(config.requests.length,1);assert.deepEqual(config.releases,[zero]);assert.notEqual(next.commit,first.commit);
 await assert.rejects(()=>loadReality(p,config,snapshot,first.commit,false,check),/mezitím/);assert.equal(await p.head(),next.commit);
}));
test('failed reality checks leave the exact current draft and release metadata untouched',async()=>fixture(async(p:Project)=>{
 const original=await p.head(),config:any={requests:[],releases:[]},snapshot=await importWebsite('https://example.org/',fetcher);
 await assert.rejects(()=>loadReality(p,config,snapshot,original,false,async()=>({passed:false,errors:['Browser failed']}) as any),/Browser failed/);assert.equal(await p.head(),original);assert.deepEqual(config,{requests:[],releases:[]});
}));
test('saving is optional, offered numbers are validated, and each import always remains a previewable step',async()=>fixture(async(p:Project)=>{
 const original=await p.head(),config:any={requests:[],releases:[]},snapshot=await importWebsite('https://example.org/',fetcher);
 const unsaved=await loadReality(p,config,snapshot,original,false,check);assert.equal(config.releases.length,0);assert.equal(config.requests.length,1);assert.equal(unsaved.savedVersion,null);
 const saved=await loadReality(p,config,snapshot,unsaved.commit,false,check,true,0);assert.equal(config.requests.length,2);assert.equal(config.releases[0].number,0);
 await assert.rejects(()=>loadReality(p,config,snapshot,saved.commit,false,check,true,0),/volné/);assert.equal(await p.head(),saved.commit);
 const next=await loadReality(p,config,snapshot,saved.commit,true,check,true,1);assert.deepEqual(config.releases.map((r:any)=>r.number),[0,1]);assert.equal(config.requests.length,1);assert.equal(config.requests[0].commit,next.commit);
}));
