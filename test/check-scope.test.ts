import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {smallStyleChange} from '../src/check-scope.ts';import {Project} from '../src/project.ts';import {workflow} from '../src/workflow.ts';import {defaults} from '../src/core.ts';
test('fast checks accept only bounded presentation changes and preserve functional checks',()=>{
 const before={'site/style.css':'.hero img{width:200px;color:red;}'};
 assert.equal(smallStyleChange(before,{'site/style.css':'.hero img{width:240px;color:blue;}'}),true);
 for(const css of ['.other img{width:240px;color:red;}','.hero img{width:200px;color:red;display:none;}','.hero img{width:calc(100vw - 10px);color:red;}','.hero img{width:200px;color:red;}@import "remote.css";'])assert.equal(smallStyleChange(before,{'site/style.css':css}),false);
 const html='<html><body><img style="width:200px" src="assets/photo.png"></body></html>';
 assert.equal(smallStyleChange({'site/index.html':html},{'site/index.html':html.replace('200px','240px')}),true);
 assert.equal(smallStyleChange({'site/index.html':html},{'site/index.html':html.replace('photo.png','missing.png')}),false);
 assert.equal(smallStyleChange({'site/a.js':'run()'},{'site/a.js':'run2()'}),false);
 assert.equal(smallStyleChange({},before),false);
});
test('small image sizing uses one model call and no browser even when agent requests verification',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sitetiller-quick-'));try{
  const project=new Project(join(root,'project'));await project.init(new URL('../seed',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'));
  const files=await project.files();files['site/style.css']+='\n.hero img{width:200px;}';await project.write(files);await project.commit('Fixture');let calls=0;
  const result=await workflow(project,[{provider:'openai',key:'fixture',...defaults.openai}],'Zvětši obrázek',join(root,'drafts'),()=>{},(async()=>{calls++;return {value:{action:'implement',needsVerification:true,files:[{path:'site/style.css',content:files['site/style.css'].replace('width:200px','width:240px')}]}};}) as any,undefined,[],{check:async()=>{throw Error('Browser must not run');}});
  assert.equal(calls,1);assert.equal(result.tests.checkLevel,'quick');assert.equal(result.tests.browser.skipped,true);assert.equal(result.tests.analysis,null);assert.ok(result.commit);assert.ok((await project.files())['site/style.css'].includes('width:240px'));
 }finally{await rm(root,{recursive:true,force:true});}
});
