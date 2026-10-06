import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Project} from '../src/project.ts';
test('restore preserves history and exact bytes, removes newer assets, rejects stale/invalid targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aiwe-restore-'));
 try{
  const project=new Project(join(root,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));
  const base=await project.head(),original=await readFile(join(project.root,'site/style.css'),'utf8');
  await project.write({'site/style.css':original+'\n/* change */','site/new.txt':'new asset'});
  const changed=await project.commit('Change and add asset');
  await assert.rejects(project.restore(base,base));await assert.rejects(project.restore('HEAD~1',changed));
  const restored=await project.restore(base,changed);
  assert.notEqual(restored.commit,base);assert.notEqual(restored.commit,changed);
  assert.equal(await project.git(['rev-parse','HEAD^']),changed);
  assert.equal(await readFile(join(project.root,'site/style.css'),'utf8'),original);
  await assert.rejects(readFile(join(project.root,'site/new.txt')));
  assert.equal(restored.tests.passed,true);
  await project.restore(changed,restored.commit);assert.equal(await readFile(join(project.root,'site/new.txt'),'utf8'),'new asset');
  const head=await project.head();await assert.rejects(project.restore(head,head));assert.equal(await project.head(),head);
 }finally{await rm(root,{recursive:true,force:true});}
});
