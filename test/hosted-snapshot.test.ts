import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Project} from '../src/project.ts';import {hostedSnapshot} from '../src/hosted-snapshot.ts';import {realitySnapshot} from '../src/reality-source.ts';import {compareReality,loadReality} from '../src/reality.ts';import {importWebsite} from '../src/web-import.ts';
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=','base64');
async function fixture(run:any){const root=await mkdtemp(join(tmpdir(),'sitetiller-hosted-snapshot-'));try{const p=new Project(join(root,'project'));await p.init(null);await mkdir(join(p.root,'site/assets'));await writeFile(join(p.root,'site/assets/original.png'),pixel);await p.write({'site/unlinked.html':(await p.files())['site/index.html'].replace('Nový web','Unlinked page')});await p.commit('Hosted source');await run(p,root);}finally{await rm(root,{recursive:true,force:true});}}
test('hosting lists unlinked files, preserves original paths and reads actual changed HTTP bytes instead of Git bytes',async()=>fixture(async(p:Project)=>{
 const head=await p.head(),content=await p.committedFiles(head);let modified=false;const fetcher:any=async(address:URL)=>{const path=address.pathname==='/'?'site/index.html':'site'+address.pathname;return new Response(path.endsWith('.png')?pixel:content[path].replace('Unlinked page',modified?'Actual external change':'Unlinked page'));};
 const original=await hostedSnapshot(p,'https://example.org/',fetcher);assert.equal(original.evidence.catalogVerified,true);assert.ok(original.files['site/unlinked.html']);assert.deepEqual(original.binary['site/assets/original.png'],pixel);assert.equal((await compareReality(p,{publishedCommit:head},head,original)).equal,true);
 modified=true;const live=await hostedSnapshot(p,'https://example.org/',fetcher);assert.equal(live.evidence.catalogVerified,false);assert.match(live.files['site/unlinked.html'],/Actual external change/);const comparison=await compareReality(p,{publishedCommit:head},head,live);assert.equal(comparison.equal,false);assert.equal(comparison.changes[0].liveChanged,true);assert.equal(comparison.changes[0].draftChanged,false);assert.equal(await p.head(),head);
}));
test('the cached hosting snapshot is both comparable and loadable with exact original image bytes',async()=>fixture(async(p:Project)=>{
 const head=await p.head(),content=await p.committedFiles(head);const snapshot=await hostedSnapshot(p,'https://example.org/',(async(address:URL)=>new Response(address.pathname.endsWith('.png')?pixel:content[address.pathname==='/'?'site/index.html':'site'+address.pathname])) as any);
 const wire={...snapshot,binary:Object.fromEntries(Object.entries(snapshot.binary).map(([path,bytes])=>[path,bytes.toString('base64')]))};
 const decoded=await realitySnapshot('https://example.org/','http://publisher/publish','fixture-token',(async(address:URL,options:any)=>{assert.equal(address.href,'http://publisher/snapshot');assert.equal(options.headers.Authorization,'Bearer fixture-token');return new Response(JSON.stringify(wire));}) as any);
 assert.equal((await compareReality(p,{},head,decoded)).equal,true);assert.equal(await p.head(),head);
 const config:any={requests:[],releases:[]};const result=await loadReality(p,config,decoded,head,false,async()=>({passed:true,errors:[],screenshots:[],checks:[]}));assert.notEqual(result.commit,head);assert.equal(config.requests.length,1);assert.deepEqual(await p.binary(result.commit,'site/assets/original.png'),pixel);
}));
test('unconnected sites and legacy publishers fall back to HTTP import; connector failures remain explicit',async()=>{
 let calls=0;const fallback:any=async()=>{calls++;return {source:'fallback'};};assert.equal((await realitySnapshot('https://example.org/',undefined,undefined,fetch,fallback)).source,'fallback');
 assert.equal((await realitySnapshot('https://example.org/','http://publisher/publish','token',(async()=>new Response('',{status:501})) as any,fallback)).source,'fallback');assert.equal(calls,2);
 await assert.rejects(realitySnapshot('https://example.org/','http://publisher/publish','token',(async()=>new Response(JSON.stringify({error:'Actual source unavailable'}),{status:502})) as any,fallback),/Actual source unavailable/);assert.equal(calls,2);
});
test('hosting snapshot decoder rejects paths outside the site',async()=>{
 const wire={files:{'site/../private.json':'private'},binary:{},evidence:{url:'https://example.org/',resources:[]}};
 await assert.rejects(realitySnapshot('https://example.org/','http://publisher/publish','token',(async()=>new Response(JSON.stringify(wire))) as any),/cesta/);
});
test('HTTP import merges equivalent root and index aliases and preserves genuinely different colliding pages',async()=>{
 const html='<html><a href="/index.html">Home</a></html>';
 const aliases=await importWebsite('https://example.org/',(async(url:string)=>({url,mime:'text/html',bytes:Buffer.from(html)})) as any);assert.equal(aliases.evidence.pages,1);assert.deepEqual(Object.keys(aliases.files),['site/index.html']);
 const different=await importWebsite('https://example.org/',(async(url:string)=>({url,mime:'text/html',bytes:Buffer.from(url.endsWith('index.html')?'<html>Different page</html>':html)})) as any);assert.equal(different.evidence.pages,2);assert.equal(Object.keys(different.files).length,2);assert.match(different.files['site/index.html'],/href="assets\/web-/);
});
