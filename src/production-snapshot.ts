import type {Project} from './project.ts';
// An existing hosting repository owns deployment files. Only replace its site tree.
export async function productionSnapshot(project:Project,source:string,production:string){
 if(!/^[a-f0-9]{40}$/.test(source)||!/^[a-f0-9]{40}$/.test(production))throw Error('Invalid publication snapshot');
 const sourceTree=await project.git(['rev-parse',source+':site']),productionTree=await project.git(['rev-parse',production+':site']);
 const marker='SiteTiller-Source: '+source,message=await project.git(['show','-s','--format=%B',production]);
 if(source===production||sourceTree===productionTree&&message.split('\n').includes(marker))return production;
 await project.git(['read-tree',production]);await project.git(['rm','-r','-f','--cached','--ignore-unmatch','--','site']);await project.git(['read-tree','--prefix=site/',source+':site']);
 const tree=await project.git(['write-tree']);await project.git(['config','user.name','SiteTiller Publisher']);await project.git(['config','user.email','publisher@sitetiller.local']);
 return project.git(['commit-tree',tree,'-p',production,'-p',source,'-m','Publish SiteTiller snapshot\n\n'+marker]);
}
