import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import {Project} from '../src/project.ts';
const exec=promisify(execFile);
test('snapshot publisher preserves independent hosting history and deployment files, and retries reuse the deployment',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-hosting-snapshot-'));let child:any;
 try{
  const hosting=new Project(join(root,'hosting'));await hosting.init(null);await writeFile(join(hosting.root,'Dockerfile'),'HOSTING CONFIGURATION');await hosting.git(['add','Dockerfile']);await hosting.git(['commit','-m','Hosting infrastructure']);const productionHead=await hosting.head();
  const remote=join(root,'production.git');await exec('git',['clone','--bare',hosting.root,remote]);
  const source=new Project(join(root,'project'));await source.init(null);await source.write({'site/index.html':(await source.files())['site/index.html'].replace('Nový web','New source website')});const commit=await source.commit('Unrelated editor content');await writeFile(join(root,'config.json'),JSON.stringify({approvedCommit:commit,technicalApproval:{head:commit}}));
  const port=23200+Math.floor(Math.random()*100),url='http://127.0.0.1:'+port+'/publish';child=spawn(process.execPath,[fileURLToPath(new URL('../src/publisher.ts',import.meta.url))],{env:{...process.env,PORT:String(port),SITETILLER_DATA_DIR:root,SITETILLER_PRODUCTION_GIT:remote,SITETILLER_PRODUCTION_SNAPSHOT:'1',SITETILLER_PUBLISH_TOKEN:'fixture-token',SITETILLER_PRODUCTION_URL:''},stdio:'ignore'});
  for(let i=0;i<80;i++){try{if((await fetch(url)).status===401)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const publish=()=>fetch(url,{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:JSON.stringify({commit})});
  const response=await publish();assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).commit,commit);
  const git=async(...args:string[])=>(await exec('git',['--git-dir='+remote,...args])).stdout.trim();const deployed=await git('rev-parse','main');assert.notEqual(deployed,commit);assert.equal(await git('show','main:Dockerfile'),'HOSTING CONFIGURATION');assert.equal(await git('rev-parse','main:site'),await source.git(['rev-parse',commit+':site']));await git('merge-base','--is-ancestor',productionHead,deployed);await assert.rejects(git('cat-file','-e',commit+'^{commit}'));assert.equal((await git('rev-list','--parents','-1',deployed)).split(' ').length,2);assert.equal(await source.head(),commit);
  assert.equal((await publish()).status,200);assert.equal(await git('rev-parse','main'),deployed);assert.equal(await readFile(join(hosting.root,'Dockerfile'),'utf8'),'HOSTING CONFIGURATION');
 }finally{if(child?.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
