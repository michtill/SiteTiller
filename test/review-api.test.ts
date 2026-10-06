import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {scryptSync} from 'node:crypto';
import {Project} from '../src/project.ts';
const roles={primary:{provider:'openai',model:'gpt-design'},ui:{provider:'anthropic',model:'claude-build'},verify:{provider:'openai',model:'gpt-test'},escalation:{provider:'anthropic',model:'claude-review'}};
test('API accumulates full requests, reviews once, persists the checkpoint and re-locks publish on next edit',async()=>{
 const data=await mkdtemp(join(tmpdir(),'aiwe-review-api-'));let child:any;
 try{
  const project=new Project(join(data,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));const base=await project.head();
  const password='test-password-for-aiwe',salt='test-salt',capture=join(data,'capture.json');
  await writeFile(join(data,'config.json'),JSON.stringify({password:{salt,hash:scryptSync(password,salt,64).toString('hex')},slots:[],providers:{openai:{key:''},anthropic:{key:''}},roles:{...roles,primary:{provider:'openai',model:'gpt-unavailable'}},agentArchitecture:3,automaticReasoningPolicy:1,imageModels:{precise:'gpt-image-2.5-sunburst',fast:'gpt-image-2.5-flare',cheap:'gpt-image-2'},requests:[],reviewedThrough:0,lastReviewCommit:base,reviewedCommits:[],approvedCommit:null,publishedCommit:base}));
  const port=18400+Math.floor(Math.random()*200),origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/provider-server.mjs',import.meta.url))],{env:{...process.env,AIWE_DATA_DIR:data,HOST:'127.0.0.1',PORT:String(port),AIWE_ORIGIN:origin,OPENAI_API_KEY:'test-openai',ANTHROPIC_API_KEY:'test-claude',AIWE_TEST_CAPTURE:capture},stdio:'ignore'});
  let ready=false;for(let i=0;i<60;i++){try{if((await fetch(origin+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  let cookie='';const post=(path:string,input:any)=>fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await post('review',{expectedHead:base})).status,401);
  const login=await post('login',{password});cookie=login.headers.get('set-cookie')!.split(';')[0];
  const state=async()=>await (await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json() as any;
  const models:any=await (await fetch(origin+'/api/models',{headers:{Cookie:cookie}})).json();assert.ok(models.issues[0].includes('gpt-unavailable'));assert.ok(!JSON.stringify(models).includes('test-openai'));
  assert.equal((await post('settings',{roles:{...roles,primary:{provider:'openai',model:'attacker'}},imageModels:{precise:'gpt-image-2.5-sunburst',fast:'gpt-image-2.5-flare',cheap:'gpt-image-2'}})).status,400);
  assert.equal((await post('settings',{roles,imageModels:{precise:'gpt-image-2.5-sunburst',fast:'gpt-image-2.5-flare',cheap:'gpt-image-2'}})).status,200);assert.equal((await state()).imageModels.precise,'gpt-image-2.5-sunburst');
  const wait=async()=>{for(let i=0;i<100;i++){const s=await state();if(!s.busy)return s;await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');};
  for(const prompt of ['first complete request','second complete request']){assert.equal((await post('run',{prompt,stopAfter:'review'})).status,202);const s=await wait();assert.equal(s.job.status,'ready');assert.equal(s.approvedCommit,null);assert.equal(s.job.review,null);}
  let s=await state();assert.equal(s.pendingCount,2);assert.equal((await post('publish',{commit:s.head})).status,400);
  assert.equal((await post('review',{expectedHead:base})).status,400);
  assert.equal((await post('review',{expectedHead:s.head})).status,202);s=await wait();assert.equal(s.approvedCommit,s.head);assert.equal(s.pendingCount,0);
  const inspected=JSON.parse(await readFile(capture,'utf8'));assert.deepEqual(inspected.requests.map((r:any)=>r.prompt),['first complete request','second complete request']);
  const persisted=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(persisted.reviewedThrough,2);assert.equal(persisted.lastReviewCommit,s.head);
  assert.equal((await post('run',{prompt:'third request'})).status,202);s=await wait();assert.equal(s.pendingCount,1);assert.equal(s.approvedCommit,null);
  assert.equal((await post('review',{expectedHead:s.head})).status,202);await wait();assert.deepEqual(JSON.parse(await readFile(capture,'utf8')).requests.map((r:any)=>r.prompt),['third request']);
 }finally{if(child){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
