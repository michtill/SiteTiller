import {raster} from '../src/images.ts';
import {mkdir,writeFile,rename,symlink,lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function deploySite(project,commit,directory){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid deployment commit');const root=resolve(directory),releases=join(root,'releases'),target=join(releases,commit);await mkdir(releases,{recursive:true});
 let exists=false;try{const stat=await lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid deployment directory');exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!exists){const temporary=join(releases,'.stage-'+randomUUID());await mkdir(temporary);try{for(const [name,content]of Object.entries(await project.committedFiles(commit))){if(!name.startsWith('site/'))continue;const path=resolve(temporary,name.slice(5));if(!path.startsWith(temporary+'/')&&!path.startsWith(temporary+'\\'))throw Error('Invalid deployment path');await mkdir(join(path,'..'),{recursive:true});await writeFile(path,raster(name)?await project.binary(commit,name):content);}await rename(temporary,target);}finally{await rm(temporary,{recursive:true,force:true});}}
 const pointer=join(root,'.current-'+randomUUID());await symlink('releases/'+commit,pointer,'dir');try{await rename(pointer,join(root,'current'));}finally{await rm(pointer,{force:true});}return target;
}
