import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {Project} from '../src/project.ts';
test('dedicated preview resolves directory pages, redirects correctly and serves query-string assets',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-preview-'));let child:any,browser:any;
 try{
  const project=new Project(join(data,'project'));await project.init(null);
  await project.write({'site/contact/index.html':'<!doctype html><html><head><title>Contact</title><meta name="viewport"></head><body><h1>Contact</h1></body></html>','site/style.css':'body{color:#222}','site/storage.html':'<!doctype html><html><head><title>Storage</title></head><body><script>localStorage.setItem("preview-test","ok");document.body.dataset.storage=localStorage.getItem("preview-test")</script></body></html>'});await project.commit('Nested page');
  const port=19600+Math.floor(Math.random()*200),origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[fileURLToPath(new URL('../src/preview.ts',import.meta.url))],{env:{...process.env,SITETILLER_DATA_DIR:data,PORT:String(port)},stdio:'ignore'});
  let ready=false;for(let i=0;i<200;i++){try{if((await fetch(origin+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const redirect=await fetch(origin+'/contact',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/contact/');
  const page=await fetch(origin+'/contact/?embedded=1');assert.equal(page.status,200);assert.ok((await page.text()).includes('<h1>Contact</h1>'));
  assert.equal((await fetch(origin+'/preview/contact/?embedded=1')).status,200);
  assert.equal((await fetch(origin+'/style.css?version=1')).status,200);
  assert.equal((await fetch(origin+'/.env')).status,404);
  await project.write({'site/index.html':'<!doctype html><html><head><title>Home</title></head><body><a href="contact/">Contact</a></body></html>','site/contact/index.html':'<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1><a href="/">Home</a></body></html>'});await project.commit('Navigation');
  const {chromium}=await import('playwright');browser=await chromium.launch({...(process.env.SITETILLER_BROWSER_EXECUTABLE?{executablePath:process.env.SITETILLER_BROWSER_EXECUTABLE}:{}),headless:true});const tab=await browser.newPage();
  await tab.setContent('<iframe src="'+origin+'/?embedded=1"></iframe>');const frame=tab.frameLocator('iframe');await frame.getByRole('link',{name:'Contact'}).click();await frame.locator('h1').waitFor();assert.equal(await frame.locator('[data-sitetiller-preview-banner]').count(),0);
  await frame.getByRole('link',{name:'Home',exact:true}).click();await frame.getByRole('link',{name:'Contact'}).waitFor();assert.equal(await frame.locator('[data-sitetiller-preview-banner]').count(),0);
  await tab.goto(origin+'/contact/');assert.equal(await tab.locator('[data-sitetiller-preview-banner]').count(),1);
  await tab.getByRole('button',{name:'Skrýt upozornění na testovací verzi'}).click();assert.equal(await tab.locator('[data-sitetiller-preview-banner]').count(),0);
  await tab.getByRole('link',{name:'Home',exact:true}).click();await tab.getByRole('link',{name:'Contact'}).waitFor();assert.equal(await tab.locator('[data-sitetiller-preview-banner]').count(),0);
  await tab.reload();assert.equal(await tab.locator('[data-sitetiller-preview-banner]').count(),0);
  await tab.goto(origin+'/storage.html');assert.equal(await tab.locator('body').getAttribute('data-storage'),'ok');
  const fresh=await browser.newPage();await fresh.goto(origin);assert.equal(await fresh.locator('[data-sitetiller-preview-banner]').count(),1);
  const old=await project.head();await project.write({'site/index.html':'<!doctype html><html><head><title>Latest</title></head><body><h1>Latest</h1></body></html>'});const head=await project.commit('Latest');
  await fresh.goto(origin+'/versions/'+old+'/');await fresh.getByRole('link',{name:'Contact'}).click();await fresh.locator('h1').waitFor();assert.ok(fresh.url().includes('/versions/'+old+'/contact/'));assert.equal(await project.head(),head);
  assert.equal((await fetch(origin+'/versions/'+ 'a'.repeat(40)+'/')).status,404);
 }finally{await browser?.close();if(child){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
