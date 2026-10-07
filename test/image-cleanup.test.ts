import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {cleanImages,cleanupPublication,mapCleanupHistory} from '../src/image-cleanup.ts';import {Project} from '../src/project.ts';import {workflow} from '../src/workflow.ts';import {defaults} from '../src/core.ts';
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=','base64');
const checked:any=async()=>({passed:true,errors:[],checks:[],screenshots:[]});
test('cleanup handles HTML srcset, CSS, query fragments and linked pages, and deduplicates only exact bytes',async()=>{
 const files={'site/index.html':'<img src="assets/b.png?size=1#hero" srcset="assets/b.png 1x, assets/c.png 2x">','site/other.html':'<img src="assets/a.png">','site/style.css':'body{background:url(assets/b.png)}','site/assets/a.png':'binary','site/assets/b.png':'binary','site/assets/c.png':'binary','site/assets/unused.png':'binary'};
 const r=await cleanImages(files,async p=>p.endsWith('c.png')?Buffer.from('different'):pixel);
 assert.deepEqual(r.removed,['site/assets/unused.png']);assert.deepEqual(r.duplicates,[{path:'site/assets/b.png',canonical:'site/assets/a.png'}]);assert.match(r.files['site/index.html'],/assets\/a.png\?size=1#hero/);assert.match(r.files['site/index.html'],/assets\/c.png 2x/);assert.match(r.files['site/style.css'],/url\(assets\/a.png\)/);
});
test('uncertain dynamic script references prevent unsafe deletion or renaming',async()=>{
 const r=await cleanImages({'site/index.html':'<script>const path="assets/"+name+".png"</script>','site/assets/one.png':'binary','site/assets/two.png':'binary'},async()=>pixel);
 assert.equal(r.retainedForDynamicReferences,true);assert.equal(r.removed.length,0);assert.equal(r.duplicates.length,0);
});
test('runtime source assignment without literal filenames preserves image assets',async()=>{
 const r=await cleanImages({'site/index.html':'<script>element.src = configuration.selected;</script>','site/assets/one.png':'binary'},async()=>pixel);
 assert.equal(r.retainedForDynamicReferences,true);assert.equal(r.removed.length,0);
});
async function fixture(run:any){const root=await mkdtemp(join(tmpdir(),'sitetiller-cleanup-test-'));try{const p=new Project(join(root,'project'));await p.init(fileURLToPath(new URL('../seed',import.meta.url)));await mkdir(join(p.root,'site/assets'),{recursive:true});await writeFile(join(p.root,'site/assets/unused.png'),pixel);await p.commit('Unused image');await run(p,root);}finally{await rm(root,{recursive:true,force:true});}}
test('publication cleanup preserves newer snapshots, original binaries, and remaps previewable steps',async()=>fixture(async(p:Project)=>{
 const chosen=await p.head();await p.write({'site/style.css':(await p.files())['site/style.css']+'\n/* newer */'});const head=await p.commit('Newer step'),tree=await p.git(['rev-parse',head+':site']);
 const r=await cleanupPublication(p,chosen,head,checked);assert.notEqual(r.commit,chosen);assert.notEqual(r.head,head);assert.equal(await p.git(['rev-parse',r.head+':site']),tree);await p.git(['merge-base','--is-ancestor',r.commit,r.head]);
 assert.equal(Object.hasOwn(await p.committedFiles(r.commit),'site/assets/unused.png'),false);assert.deepEqual(await p.binary(chosen,'site/assets/unused.png'),pixel);
 const config={requests:[{commit:chosen,status:'ready'},{commit:head,baseCommit:chosen,status:'ready'}]},events=[{commit:chosen},{commit:head}];mapCleanupHistory(config,events,r.mapping);assert.equal(config.requests[0].commit,r.commit);assert.equal(config.requests[1].commit,r.head);assert.equal(events[1].commit,r.head);
}));
test('a failed post-cleanup browser check leaves the working branch and image bytes untouched',async()=>fixture(async(p:Project)=>{
 const head=await p.head();await assert.rejects(cleanupPublication(p,head,head,async()=>({...await checked(),passed:false,errors:['Broken image']})),/Broken image/);assert.equal(await p.head(),head);assert.deepEqual(await p.binary(head,'site/assets/unused.png'),pixel);
}));
test('chat cleanup uses a host capability and produces a reversible preview without modifying private uploads',async()=>fixture(async(p:Project,root:string)=>{
 const original=await p.head();const result=await workflow(p,[{provider:'openai',key:'fake',...defaults.openai}],'Smaž nepoužité obrázky',join(root,'drafts'),()=>{},(async()=>({value:{action:'cleanup',summary:'Nepoužité obrázky byly odstraněny.'}})) as any,undefined,[],{check:checked});
 assert.notEqual(result.commit,original);assert.equal(Object.hasOwn(await p.files(),'site/assets/unused.png'),false);assert.deepEqual(await p.binary(original,'site/assets/unused.png'),pixel);
}));

test('ordinary script arithmetic does not prevent unused image cleanup',async()=>{const r=await cleanImages({'site/index.html':'<img src="assets/used.png"><script>const total=1+2;</script>','site/assets/used.png':'binary','site/assets/unused.png':'binary'},async()=>pixel);assert.deepEqual(r.removed,['site/assets/unused.png']);});
