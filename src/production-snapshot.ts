import type {Project} from './project.ts';import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {safeSitePath} from './core.ts';import {raster} from './images.ts';
// Only selected blobs are exported. A source identifier in a message is NOT a parent.
export async function productionSnapshot(target:Project,source:string,production:string|null,workspace:Project){
 if(!/^[a-f0-9]{40}$/.test(source)||production!==null&&!/^[a-f0-9]{40}$/.test(production))throw Error('Invalid publication snapshot');
 const sourceTree=await workspace.git(['rev-parse',source+':site']),marker='SiteTiller-Source: '+source;
 if(production){const tree=await target.git(['rev-parse',production+':site']),message=await target.git(['show','-s','--format=%B',production]);if(tree===sourceTree&&message.split('\n').includes(marker))return production;}
 await target.git(['config','core.autocrlf','false']);await target.git(['config','user.name','SiteTiller Publisher']);await target.git(['config','user.email','publisher@sitetiller.local']);
 await target.git(production?['read-tree',production]:['read-tree','--empty']);await target.git(['rm','-r','-f','--cached','--ignore-unmatch','--','site']);
 const entries=(await workspace.git(['ls-tree','-r',source,'--','site'])).split('\n').filter(Boolean);
 for(const entry of entries){const match=entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);if(!match)throw Error('Unsupported source file mode');const [,mode,,name]=match,path=safeSitePath(target.root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,await workspace.binary(source,name));const blob=await target.git(['hash-object','-w','--',name]);await target.git(['update-index','--add','--cacheinfo',mode,blob,name]);}
 const tree=await target.git(['write-tree']);if(await target.git(['rev-parse',tree+':site'])!==sourceTree)throw Error('Exported snapshot does not match approved source');
 return target.git(['commit-tree',tree,...(production?['-p',production]:[]),'-m','Publish SiteTiller snapshot\n\n'+marker]);
}
