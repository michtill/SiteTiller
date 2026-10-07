import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {scryptSync} from 'node:crypto';
import {Project} from '../src/project.ts';
test('restore API authenticates, rejects stale requests and requires a new cumulative review',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-restore-api-'));let child:any;
 try{
  const project=new Project(join(data,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));
  const base=await project.head(),files=await project.files();await project.write({'site/style.css':files['site/style.css']+'\n/* new */'});const changed=await project.commit('New version');
  const password='test-password-for-sitetiller',salt='test-salt';
  await writeFile(join(data,'config.json'),JSON.stringify({password:{salt,hash:scryptSync(password,salt,64).toString('hex')},slots:[],approvedCommit:changed,publishedCommit:base,reviewedCommits:[base]}));
  const port=18200+Math.floor(Math.random()*200),origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.ts',import.meta.url))],{env:{...process.env,SITETILLER_DATA_DIR:data,HOST:'127.0.0.1',PORT:String(port),SITETILLER_ORIGIN:origin},stdio:'ignore'});
  let ready=false;for(let i=0;i<40;i++){try{if((await fetch(origin+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const post=(path:string,input:any,cookie='',requestOrigin=origin)=>fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:requestOrigin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await post('restore',{commit:base,expectedHead:changed})).status,401);
  const login=await post('login',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post('restore',{commit:base,expectedHead:changed},cookie,'http://other.test')).status,403);
  assert.equal((await post('restore',{commit:base,expectedHead:base},cookie)).status,400);assert.equal(await project.head(),changed);
  const restore=await post('restore',{commit:base,expectedHead:changed},cookie);assert.equal(restore.status,200);const result:any=await restore.json();assert.equal(result.reviewed,false);
  const state:any=await (await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json();assert.equal(state.head,result.commit);assert.equal(state.approvedCommit,null);assert.ok(state.pendingCount>0);assert.equal(state.publishedCommit,base);assert.equal(state.events.at(-1).stage,'restored');
 }finally{if(child){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
