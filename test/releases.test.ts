import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Project} from '../src/project.ts';
import {groupHistory,initialReleases,publicationIntent,completePublication} from '../src/releases.ts';
const entry=(commit:string)=>({commit,message:commit,date:'2026-10-04'});
test('release buckets include each commit exactly once with all unpublished changes above the last release',()=>{
 const history=['e','d','c','b','a'].map(entry),releases:any[]=[{id:'first',number:1,commit:'b'},{id:'second',number:2,commit:'d'}];
 const groups=groupHistory(history,releases);assert.equal(groups[0].title,'Nepublikované změny');assert.deepEqual(groups.map(g=>g.changes.map((c:any)=>c.commit)),[['e'],['d','c'],['b','a']]);assert.deepEqual(groups.flatMap(g=>g.changes.map((c:any)=>c.commit)),history.map(c=>c.commit));
 const repeated=groupHistory(history,[...releases,{id:'third',number:3,commit:'d'} as any]);assert.equal(repeated[1].changes.length,0);assert.equal(repeated.flatMap(g=>g.changes).length,history.length);
 assert.equal(groupHistory(history,[])[0].changes.length,5);
});
test('existing publication is imported honestly without inventing past version numbers or dates',()=>{
 const migrated=initialReleases('a',[]);assert.equal(migrated[0].legacy,true);assert.equal(migrated[0].number,0);assert.equal(migrated[0].publishedAt,null);assert.equal(initialReleases(null,[]).length,0);
 const intent=publicationIntent(migrated,null,'b');assert.equal(intent.number,1);assert.equal(intent.previousCommit,'a');assert.equal(publicationIntent(migrated,intent,'b'),intent);
});
test('verified publication creates an immutable local Git release tag; retry is safe and mismatching tags are rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aiwe-release-'));try{
  const project=new Project(join(root,'project'));await project.init(fileURLToPath(new URL('../seed',import.meta.url)));const base=await project.head();
  const intent=publicationIntent([],null,base),completed=await completePublication(project,[],intent);assert.equal(completed.release.number,1);assert.ok(completed.release.publishedAt);assert.equal(await project.git(['rev-parse','refs/tags/aiwe/published/v1']),base);
  assert.equal((await completePublication(project,[],intent)).release.commit,base);
  const files=await project.files();await project.write({'site/style.css':files['site/style.css']+'\n/* next */'});const next=await project.commit('Next');await assert.rejects(completePublication(project,[],{...intent,commit:next}));assert.equal(await project.git(['rev-parse','refs/tags/aiwe/published/v1']),base);
  const second=await completePublication(project,completed.releases,publicationIntent(completed.releases,null,next));assert.equal(second.release.number,2);assert.equal(second.release.previousCommit,base);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('subversions append publications and keep original release tags',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aiwe-republish-'));try{const p=new Project(join(root,'project'));await p.init(fileURLToPath(new URL('../seed',import.meta.url)));const base=await p.head(),first=await completePublication(p,[],publicationIntent([],null,base,'Original'));await p.write({'site/patch.txt':'Revision'});const next=await p.commit('Detail');const intent=publicationIntent(first.releases,null,next,'Detail','Changed detail',true);assert.equal(intent.number,1);assert.equal(intent.id,'release-1.1');const result=await completePublication(p,first.releases,intent);assert.equal(result.releases.length,2);assert.equal(result.release.commit,next);assert.equal(result.release.description,'Detail');assert.equal(await p.git(['rev-parse','refs/tags/aiwe/published/v1']),base);assert.equal(await p.git(['rev-parse','refs/tags/aiwe/published/v1-s1']),next);assert.equal(publicationIntent(result.releases,null,base).number,2);const secondMinor=publicationIntent(result.releases,null,base,'Next',undefined,true);assert.equal(secondMinor.minor,2);const final=await completePublication(p,result.releases,secondMinor);assert.equal(final.releases.length,3);assert.equal(final.release.number,1);assert.throws(()=>publicationIntent([],null,next,undefined,undefined,true));await assert.rejects(completePublication(p,result.releases,intent));}finally{await rm(root,{recursive:true,force:true});}
});

