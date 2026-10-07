import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {scryptSync} from 'node:crypto';
import {Project} from '../src/project.ts';import {initialTeam,initialImages} from '../src/team.ts';
test('welcome, comparison and confirmed imports preserve steps or clear them while Version 0 stays fixed',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-reality-ui-'));let child:any,browser:any;
 try{
  const p=new Project(join(data,'project'));await p.init(null);const original=await p.head(),password='fixture-password-reality',salt='salt';
  await writeFile(join(data,'config.json'),JSON.stringify({password:{salt,hash:scryptSync(password,salt,64).toString('hex')},roles:initialTeam(),imageModels:initialImages(),providers:{openai:{key:''},anthropic:{key:''}},requests:[{id:'old',sequence:1,status:'ready',commit:original,prompt:'Prior edit',createdAt:new Date().toISOString(),memory:{summary:'Prior draft'}}],requestSequence:1,releases:[],agentArchitecture:3}));
  const port=21900+Math.floor(Math.random()*100),origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['--experimental-test-module-mocks',fileURLToPath(new URL('./fixtures/reality-server.mjs',import.meta.url))],{env:{...process.env,SITETILLER_DATA_DIR:data,SITETILLER_REALITY_FIXTURE_DIR:data,HOST:'127.0.0.1',PORT:String(port),SITETILLER_ORIGIN:origin,SITETILLER_SITE_URL:'https://fixture.example/',SITETILLER_UI_LANGUAGE:'cs'},stdio:'pipe'});
  let logs='';child.stderr.on('data',(b:any)=>logs+=b.toString());
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(origin+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const {chromium}=await import('playwright');browser=await chromium.launch({headless:true,...(process.env.SITETILLER_BROWSER_EXECUTABLE?{executablePath:process.env.SITETILLER_BROWSER_EXECUTABLE}:{})});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('#password').fill(password);await page.locator('#login-form button').click();await page.locator('#prompt').waitFor();
  await page.locator('.reality-welcome button').click();await page.locator('#reality-load[open]').waitFor();assert.equal(await p.head(),original);assert.equal(await page.locator('#reality-save-version').isChecked(),true);assert.equal(await page.locator('#reality-clear-option').isVisible(),true);
  await page.locator('#cancel-reality-load').click();assert.equal(await p.head(),original);
  await page.locator('.reality-welcome button').click();await page.locator('#reality-load[open]').waitFor();await page.locator('#confirm-reality-load').click();await page.locator('#reality-load').waitFor({state:'hidden',timeout:60000});
  let config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(config.releases[0].number,0);assert.equal(config.requests.length,2);const zero=config.releases[0].commit;
  await page.locator('#history-toggle').click();await page.getByText('Verze 0 – AKTUÁLNÍ',{exact:true}).waitFor();
  await page.locator('#compare-reality').click();await page.getByText('V porovnaných souborech nejsou rozdíly.',{exact:true}).waitFor();assert.equal(await p.head(),zero);assert.equal(await page.locator('#load-from-reality').isDisabled(),true);await page.locator('#close-reality').click();
  await writeFile(join(data,'live.txt'),'Changed externally');await page.locator('#compare-reality').click();await page.getByText('Změna na skutečném webu',{exact:true}).waitFor();assert.equal(await p.head(),zero);
  await page.locator('#load-from-reality').click();await page.locator('#reality-clear').check();await page.locator('#confirm-reality-load').click();await page.locator('#reality-load').waitFor({state:'hidden',timeout:60000});
  config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));assert.equal(config.releases.length,1);assert.equal(config.releases[0].commit,zero);assert.equal(config.requests.length,1);assert.match((await p.files())['site/index.html'],/Changed externally/);assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
