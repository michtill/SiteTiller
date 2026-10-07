import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import type {Project} from './project.ts';import {staticChecks,browserChecks} from './checks.ts';import {raster} from './images.ts';
export async function checkPublication(project:Project,commit:string,restoredFrom?:string,browserCheck=browserChecks,expectedHead=commit){
 if(!/^[a-f0-9]{40}$/.test(commit)||await project.head()!==expectedHead)throw Error('Návrh se mezitím změnil. Zobraz aktuální verzi.');
 try{await project.git(['merge-base','--is-ancestor',commit,expectedHead]);}catch{throw Error('Vybraný krok není součástí aktuálního návrhu.');}
 const files=await project.committedFiles(commit),checks=staticChecks(files);
 if(!checks.passed)throw Error('Publikování zastaveno: '+checks.errors.join('; '));
 let restoration:any=null;
 if(restoredFrom){
  if(!/^[a-f0-9]{40}$/.test(restoredFrom))throw Error('Neplatná obnovená verze.');
  const actualTree=await project.git(['rev-parse',commit+':site']),expectedTree=await project.git(['rev-parse',restoredFrom+':site']);
  restoration={restoredFrom,actualTree,expectedTree,identical:actualTree===expectedTree};if(!restoration.identical)throw Error('Obnovené soubory neodpovídají vybrané verzi.');
 }
 const root=await mkdtemp(join(tmpdir(),'sitetiller-publication-check-'));
 try{
  for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),raster(path)?await project.binary(commit,path):content);}
  const browser=await browserCheck(root,files);
  if(!browser.passed)throw Error('Publikování zastaveno: '+browser.errors.join('; '));
  if(await project.head()!==expectedHead)throw Error('Návrh se během kontroly změnil.');
  return {commit,passed:true,static:checks,browser:{...browser,screenshots:undefined},restoration};
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
