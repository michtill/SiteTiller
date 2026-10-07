import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {browserChecks,staticChecks} from '../src/checks.ts';
import {importWebsite,fetchPublic,publicAddress,publicUrl,requestedUrl} from '../src/web-import.ts';
import {Project} from '../src/project.ts';import {workflow} from '../src/workflow.ts';import {defaults} from '../src/core.ts';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=','base64');
const source:Record<string,[string,string|Buffer]>={
 'https://example.org/':['text/html','<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Real site</title><link rel="stylesheet" href="/style.css"></head><body><h1>Real site</h1><img src="/photo.png"><a href="/about/">About</a><script src="/app.js"></script></body></html>'],
 'https://example.org/style.css':['text/css','body{color:#123;background-image:url("/photo.png")}'],
 'https://example.org/photo.png':['image/png',image],
 'https://example.org/app.js':['application/javascript','document.body.dataset.loaded="yes";'],
 'https://example.org/about/':['text/html','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>About</title></head><body><h1>About</h1><a href="/">Home</a></body></html>']
};
const fixture:any=async(url:string)=>{const item=source[url];if(!item)throw Error('Missing fixture');return {url,mime:item[0],bytes:Buffer.from(item[1])};};
test('public import copies linked pages, CSS, JS and exact image bytes with working local references',async()=>{
 const result=await importWebsite('https://example.org/',fixture);
 assert.equal(result.evidence.pages,2);assert.equal(result.evidence.files,5);
 assert.ok(result.files['site/about/index.html'].includes('href="../index.html"'));
 assert.match(result.files['site/index.html'],/href="about\/index.html"/);
 const [path]=Object.keys(result.binary);assert.deepEqual(result.binary[path],image);
 const css=Object.entries(result.files).find(([p])=>p.endsWith('.css'))![1];assert.ok(css.includes(path.split('/').at(-1)!));
 assert.equal(result.evidence.warnings.length,0);
});
test('web fetch rejects private, reserved and metadata addresses and requires a user-named host',async()=>{
 for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 for(const url of ['file:///etc/passwd','https://user:secret@example.org/','http://example.org:8080/','http://localhost/'])assert.throws(()=>publicUrl(url));
 await assert.rejects(()=>fetchPublic('http://127.0.0.1/'),/interní/);
 assert.equal(requestedUrl('https://www.example.org/','Načti web example.org.'),'https://www.example.org/');
 assert.throws(()=>requestedUrl('https://evil.org/','Načti example.org.'),/uživatel/);
 assert.throws(()=>requestedUrl('https://example.org/','Načti badexample.org.'),/uživatel/);
});
test('import remains an isolated candidate until checks pass and preserves originals in version history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-import-'));
 try{
  const p=new Project(join(root,'project'));await p.init(null);const before=await p.head(),original=await p.files();let calls=0;
  const model:any=async(_client:any,_instruction:any,input:any)=>{calls++;if(calls===1){assert.equal(input.capabilities.publicWebsiteImport,true);return {value:{action:'web',url:'https://example.org/',scope:'create'}};}
   if(calls===2){assert.equal(await p.head(),before);assert.match((await p.files())['site/index.html'],/Nový web/);assert.equal(input.webImport.pages,2);return {value:{action:'implement',scope:'create',files:[],summary:'Web byl načten.',acceptance:[{id:'copy',category:'required',description:'Copy public frontend',basis:'User request'}]}};}
   return {value:{status:'PASS',requiredFixes:[]}};};
  const check:any=async(path:string,files:any)=>{const [imagePath]=Object.keys(files).filter(p=>p.endsWith('.png'));assert.deepEqual(await readFile(join(path,imagePath)),image);return {passed:true,errors:[],screenshots:[],checks:[]};};
  const result=await workflow(p,[{provider:'openai',key:'fixture',...defaults.openai}],'Načti web example.org a zkopíruj ho.',join(root,'drafts'),()=>{},model,undefined,[],{check,webImport:async(url)=>importWebsite(url,fixture)});
  assert.notEqual(result.commit,before);assert.equal(result.webImport.pages,2);assert.equal(calls,3);
  assert.equal((await p.committedFiles(before))['site/index.html'],original['site/index.html']);
  assert.match((await p.files())['site/index.html'],/Real site/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unavailable source never changes the draft or publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-import-failure-'));
 try{const p=new Project(join(root,'project'));await p.init(null);const before=await p.head();
  await assert.rejects(()=>workflow(p,[{provider:'openai',key:'fixture',...defaults.openai}],'Načti example.org.',join(root,'drafts'),()=>{},async()=>({value:{action:'web',url:'https://example.org/'}}) as any,undefined,[],{webImport:async()=>{throw Error('Source unavailable');}}),/Source unavailable/);
  assert.equal(await p.head(),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('copied frontend loads real local assets and navigation in the browser',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-import-browser-'));
 try{const imported=await importWebsite('https://example.org/',fixture);
  for(const [path,text] of Object.entries(imported.files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),imported.binary[path]||text);}
  assert.equal(staticChecks(imported.files).passed,true);
  const result=await browserChecks(root,imported.files,[{name:'Imported navigation and JavaScript',path:'site/index.html',steps:[{action:'expectAttribute',selector:'body',attribute:'data-loaded',value:'yes'},{action:'expectVisible',selector:'img',visible:true},{action:'click',selector:'a'},{action:'expectText',selector:'h1',equals:'About'}]}]);
  assert.equal(result.passed,true,result.errors.join('; '));
 }finally{await rm(root,{recursive:true,force:true});}
});
