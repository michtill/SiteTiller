import {createHash} from 'node:crypto';
import {posix,join} from 'node:path';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Project} from './project.ts';
import {checkPublication} from './publication-check.ts';
const image=(path:string)=>/\.(png|jpe?g|webp|svg)$/i.test(path);
// Treat all text files as potential users, including scripts, JSON and hidden pages.
export async function cleanImages(source:Record<string,string>,bytes:(path:string)=>Promise<Buffer>){
 const files={...source},images=Object.keys(files).filter(image).sort();
 const texts=Object.entries(files).filter(([path])=>!image(path)||path.endsWith('.svg'));
 const runtimeImage=texts.some(([,text])=>/\.(?:src|srcset|backgroundImage)\s*=\s*[^\s'"`]/.test(text));
 const dynamic=runtimeImage||texts.some(([path,text])=>(path.endsWith('.js')||/<script\b/i.test(text))&&/(assets|images|\.png|\.webp|\.jpe?g|\.svg)/i.test(text)&&(/['"`][^'"`\s]+\/['"`]/.test(text)||/\+\s*['"`]\.(?:png|webp|jpe?g|svg)['"`]/i.test(text)||/['"`][^'"`]*(?:assets\/|images\/)[^'"`]*\$\{/.test(text)));
 const used=(path:string,entries=texts)=>entries.some(([,text])=>text.includes(posix.basename(path))||text.includes(encodeURIComponent(posix.basename(path))));
 const removed:string[]=[],duplicates:any[]=[],hashes=new Map<string,string>();
 for(const path of images){
  if(!dynamic&&!used(path)){delete files[path];removed.push(path);continue;}
  if(dynamic)continue;
  const hash=createHash('sha256').update(await bytes(path)).digest('hex'),canonical=hashes.get(hash);
  if(!canonical){hashes.set(hash,path);continue;}
  const rewritten={...files};let replacements=0;
  for(const [name,text] of texts){
   if(!Object.hasOwn(files,name))continue;
   rewritten[name]=files[name].replace(/[^\s"'`()<>;,]+/g,(token:string)=>{
    if(/^(?:[a-z]+:|\/\/|#)/i.test(token))return token;
    try{const url=new URL(token,'https://cleanup.invalid/'+name.slice(5));if('site'+decodeURIComponent(url.pathname)!==path)return token;
     const relative=token.startsWith('/')?'/'+canonical.slice(5):posix.relative(posix.dirname(name),canonical);replacements++;return relative+url.search+url.hash;
    }catch{return token;}
   });
  }
  // Unknown references (escaped JSON, dynamic names, unusual syntax) keep the file.
  if(!replacements||used(path,Object.entries(rewritten).filter(([name])=>!image(name)||name.endsWith('.svg'))))continue;
  Object.assign(files,rewritten);delete files[path];duplicates.push({path,canonical});
 }
 return {files,removed,duplicates,retainedForDynamicReferences:dynamic};
}
export async function cleanupPublication(project:Project,commit:string,head:string,browserCheck?:any){
 const files=await project.committedFiles(commit),cleanup=await cleanImages(files,path=>project.binary(commit,path));
 if(!cleanup.removed.length&&!cleanup.duplicates.length)return {commit,head,mapping:{},cleanup};
 const root=await mkdtemp(join(tmpdir(),'sitetiller-image-cleanup-'));
 try{
  await cp(project.root,root,{recursive:true});const draft=new Project(root);await draft.git(['checkout','--detach',commit]);await draft.writeSnapshot(cleanup.files);
  const cleaned=await draft.commit('SiteTiller: cleanup unused and identical images');const mapping:Record<string,string>={[commit]:cleaned};let tip=cleaned;
  // Preserve every newer snapshot byte-for-byte while attaching it to the cleaned release.
  const newer=(await project.git(['rev-list','--first-parent','--reverse',commit+'..'+head])).split('\n').filter(Boolean);
  for(const original of newer){const tree=await project.git(['rev-parse',original+'^{tree}']),message=await project.git(['show','-s','--format=%s',original]);tip=await draft.git(['commit-tree',tree,'-p',tip,'-m',message]);mapping[original]=tip;}
  await draft.git(['checkout','-B','main',tip]);
  const tests=await checkPublication(draft,cleaned,undefined,browserCheck,tip);
  if(await project.head()!==head||await project.git(['status','--porcelain','--untracked-files=no'])||await project.git(['status','--porcelain','--','site']))throw Error('Návrh se během úklidu změnil.');
  await project.git(['fetch',root,'main']);
  await project.git(['update-ref','refs/sitetiller/pre-cleanup/'+Date.now(),head]);
  await project.git(['update-ref','refs/heads/main',tip,head]);await project.git(['reset','--hard',tip]);
  return {commit:cleaned,head:tip,mapping,cleanup,tests};
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
export function mapCleanupHistory(config:any,events:any[],mapping:Record<string,string>){
 const mapped=(commit:string)=>mapping[commit]||commit;
 const selected=Object.keys(mapping)[0];
 for(const request of config.requests||[]){const prior=request.commit;request.commit=mapped(prior);if(prior===selected&&request.restoredFrom){request.cleanupOriginalCommit=prior;delete request.restoredFrom;}request.baseCommit=mapped(request.baseCommit);for(const event of request.progress||[]){if(event.commit)event.commit=mapped(event.commit);if(event.baseCommit)event.baseCommit=mapped(event.baseCommit);}}
 for(const event of events){if(event.commit)event.commit=mapped(event.commit);if(event.baseCommit)event.baseCommit=mapped(event.baseCommit);}
 for(const key of ['lastReviewCommit','draftBaseCommit'])if(config[key])config[key]=mapped(config[key]);
 if(config.reviewedCommits)config.reviewedCommits=config.reviewedCommits.map(mapped);
}
