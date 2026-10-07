import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {scryptSync} from 'node:crypto';
import {Project} from '../src/project.ts';import {initialTeam,initialImages} from '../src/team.ts';
test('conversation survives restart; new-site creation replaces only draft content and supports preview navigation and exact rollback',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-context-api-'));let child:any;
 try{
  const project=new Project(join(data,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));const base=await project.head(),original=await project.files();
  const password='fixture-password-sitetiller',salt='salt',trace=join(data,'trace.jsonl');
  await writeFile(join(data,'config.json'),JSON.stringify({password:{salt,hash:scryptSync(password,salt,64).toString('hex')},slots:[],providers:{openai:{key:''},anthropic:{key:''}},roles:initialTeam(),imageModels:initialImages(),agentArchitecture:3,requests:[],reviewedThrough:0,lastReviewCommit:base,reviewedCommits:[],approvedCommit:null,publishedCommit:base}));
  const port=19400+Math.floor(Math.random()*200),origin='http://127.0.0.1:'+port;
  let cookie='';const post=(path:string,input:any)=>fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const start=async()=>{
   child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/provider-server.mjs',import.meta.url))],{env:{...process.env,SITETILLER_DATA_DIR:data,HOST:'127.0.0.1',PORT:String(port),SITETILLER_ORIGIN:origin,OPENAI_API_KEY:'fixture-openai',ANTHROPIC_API_KEY:'fixture-claude',SITETILLER_TEST_CAPTURE:join(data,'capture.json'),SITETILLER_TEST_TRACE:trace},stdio:'ignore'});
   let ready=false;for(let i=0;i<200;i++){try{if((await fetch(origin+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
   const login=await post('login',{password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];
  };
  const stop=async()=>{const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;child=null;};
  const state=async()=>await(await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json() as any;
  const wait=async()=>{for(let i=0;i<400;i++){const s=await state();if(!s.busy)return s;await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');};
  await start();
  assert.equal((await post('run',{prompt:'Darken the button',reasoningEffort:'invalid'})).status,400);
  assert.equal((await post('run',{prompt:'Darken the button'})).status,202);let s=await wait();assert.equal(s.job.status,'ready',s.job.error);
  assert.equal(s.requests[0].reasoningEffort,'auto');assert.ok(s.requests[0].memory.deltas.some((d:any)=>d.selector==='.button'&&d.property==='background'&&d.after==='#444'));
  await stop();await start();
  assert.equal((await post('run',{prompt:'Ještě trochu',reasoningEffort:'high'})).status,202);s=await wait();assert.equal(s.job.status,'ready',s.job.error);assert.ok((await project.files())['site/style.css'].includes('.button{background:#333'));
  assert.equal(s.requests[1].resolvedRequest,'Darken .button background to #333.');assert.equal(s.publishedCommit,base);assert.equal(s.approvedCommit,null);
  assert.equal((await post('run',{prompt:'Create a cafe website',mode:'create'})).status,202);s=await wait();assert.equal(s.job.status,'ready',s.job.error);assert.equal(s.job.scope,'create');assert.equal(s.projectTitle,'Cafe');assert.equal(s.publishedCommit,base);
  assert.ok(!(await project.files())['site/favicon.svg']);assert.ok((await project.files())['site/contact/index.html']);
  const preview=await(await fetch(origin+'/preview/?embedded=1')).text();assert.ok(preview.includes('href="/preview/contact"'));assert.ok(preview.includes('href="/preview/style.css?v=1"'));
  const contact=await fetch(origin+'/preview/contact',{redirect:'manual'});assert.equal(contact.status,302);assert.equal(contact.headers.get('location'),'/preview/contact/');
  assert.equal((await fetch(origin+'/preview/contact/')).status,200);
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.find(c=>c.input.request==='Darken the button').reasoningEffort,'low');assert.equal(calls.find(c=>c.input.request==='Ještě trochu').reasoningEffort,'high');assert.equal(calls.filter(c=>c.input.request==='Darken the button').length,1);assert.equal(calls.filter(c=>c.input.request==='Ještě trochu').length,1);
  assert.equal((await post('restore',{commit:base,expectedHead:s.head})).status,200);assert.deepEqual(await project.files(),original);s=await state();assert.equal(s.publishedCommit,base);assert.equal(s.approvedCommit,null);
  const config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(config.requests.length,4);assert.equal(config.requests[2].scope,'create');assert.ok(config.requests[1].memory);
 }finally{if(child){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
