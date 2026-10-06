import {deploySite} from '../deploy/site-release.mjs';
import {hostingPolicyProblems} from './site-policy.ts';
import {staticChecks} from './checks.ts';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from './project.ts';
import {raster} from './images.ts';
const exec=promisify(execFile),project=new Project((process.env.AIWE_DATA_DIR||'/data')+'/project');
const remote=process.env.AIWE_PRODUCTION_GIT;
if(!remote||!process.env.AIWE_PUBLISH_TOKEN)throw new Error('Publisher requires a fixed Git target and token.');
let busy=false,stage='';
http.createServer(async(req,res)=>{const json=(status:number,value:any)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};try{
  const received=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+process.env.AIWE_PUBLISH_TOKEN);
  if(received.length!==expected.length||!timingSafeEqual(received,expected))return json(401,{error:'Unauthorized'});
  if(req.method!=='POST'||req.url!=='/publish')return json(404,{error:'Not found'});
  if(busy)return json(409,{error:'Publish running'});
  let text='';for await(const chunk of req){text+=chunk;if(text.length>1000)return json(413,{error:'Too large'});}
  const {commit}=JSON.parse(text);
  if(typeof commit!=='string'||!/^[a-f0-9]{40}$/.test(commit))return json(409,{error:'Invalid snapshot'});const head=await project.head();
  // Approval is stored by the controller, never written by model tools.
  const {readFile}=await import('node:fs/promises');
  const config=JSON.parse(await readFile((process.env.AIWE_DATA_DIR||'/data')+'/config.json','utf8'));
  if(commit!==config.approvedCommit)return json(409,{error:'Commit not reviewed'});if(head!==(config.technicalApproval?.head||commit))return json(409,{error:'Draft changed'});try{await project.git(['merge-base','--is-ancestor',commit,head]);}catch{return json(409,{error:'Snapshot is not in draft history'});}
  const test=staticChecks(await project.committedFiles(commit));if(!test.passed)return json(409,{error:'Tests failed'});
  busy=true;const temp=await mkdtemp(join(tmpdir(),'aiwe-publish-'));
  try{
    await exec('git',['-c','safe.directory='+project.root,'-c','safe.directory='+project.root+'/.git','clone','--no-hardlinks',project.root,temp],{timeout:30000});
    const run=async(args:string[])=>exec('git',['-c','safe.directory='+temp,...args],{cwd:temp,timeout:120000,maxBuffer:1000000});
    if(process.env.AIWE_PRODUCTION_URL){stage='policy';const hosted=await fetch(process.env.AIWE_PRODUCTION_URL,{signal:AbortSignal.timeout(10000),cache:'no-store'});if(!hosted.ok)throw Error('Production hosting unavailable');const problems=hostingPolicyProblems(hosted.headers.get('content-security-policy'));if(problems.length)throw Error('Incompatible production CSP');}
    stage='git';const before=(await run(['ls-remote',remote,'refs/heads/main'])).stdout.split(/\s/)[0];
    await run(['fetch',remote,'main']);
    await run(['merge-base','--is-ancestor','FETCH_HEAD',commit]);
    // No force push. Freeze explicit SHA so later draft changes cannot be released.
    await run(['push',remote,commit+':refs/heads/main']);
    if(process.env.AIWE_PRODUCTION_DIRECTORY){stage='export';await deploySite(project,commit,process.env.AIWE_PRODUCTION_DIRECTORY);}
    // A previous push may have succeeded while its deploy hook failed. Retry the
    // existing, fixed production hook when Git already contains this exact SHA.
    if(before===commit&&process.env.AIWE_RETRY_DEPLOY_HOOK==='1'){
      stage='hook';await new Promise<void>((resolve,reject)=>{const child=execFile('php',[join(remote,'hooks/post-receive')],{timeout:45000,maxBuffer:100000},error=>error?reject(Error('Deployment hook failed')):resolve());child.stdin!.end(commit+' '+commit+' refs/heads/main\n');});
    }
    const {stdout}=await run(['ls-remote',remote,'refs/heads/main']);if(!stdout.startsWith(commit))throw new Error('Remote commit mismatch');
    if(process.env.AIWE_PRODUCTION_URL){
      stage='verify';const expectedFiles=await project.committedFiles(commit);let verified=false;const deadline=Date.now()+90000;
      while(Date.now()<deadline){
        try {
          const checks=await Promise.all(Object.entries(expectedFiles).map(async([name,content])=>{
            const url=new URL(name==='site/index.html'?'./':name.slice(5),process.env.AIWE_PRODUCTION_URL);
            url.searchParams.set('aiwe',commit);
            const response=await fetch(url,{signal:AbortSignal.timeout(10000),cache:'no-store'});
            return response.ok&&(raster(name)?Buffer.from(await response.arrayBuffer()).equals(await project.binary(commit,name)):(await response.text()).trim()===content.trim());
          }));
          if(checks.every(Boolean)){verified=true;break;}
        } catch { /* Deployment can briefly restart while the hook builds it. */ }
        await new Promise(r=>setTimeout(r,3000));
      }
      if(!verified)throw new Error('Git updated; production deployment not verified');
    }
    return json(200,{ok:true,commit});
  }finally{busy=false;await rm(temp,{recursive:true,force:true});}
}catch(e:any){console.error('AIWE publication failed at '+stage+' ('+(e.code||e.name||'error')+')');json(502,{error:stage==='policy'?'Publikování zastaveno: bezpečnostní pravidla produkčního hostingu neodpovídají náhledu. Je nutné opravit CSP domény.':stage==='verify'?'Git je aktualizovaný, ale veřejný web zatím neodpovídá této verzi. Opakuj publikování pro nové spuštění nasazení.':stage==='hook'?'Git je aktualizovaný, ale spuštění nasazení ve VPS Centru selhalo.':stage==='git'?'Zápis do produkčního Gitu selhal. Zkontroluj publikační službu.':'Publikování selhalo před ověřením webu.'});}}).listen(Number(process.env.PORT||8080),'0.0.0.0');
