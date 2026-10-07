import {Project} from './project.ts';import {existsSync} from 'node:fs';import {join} from 'node:path';
export function productionProject(){const root=process.env.SITETILLER_PRODUCTION_HISTORY_DIR;return root&&existsSync(join(root,'HEAD'))?new Project(root):null;}
export async function productionReleases(project:Project){
 const rows=(await project.git(['for-each-ref','--format=%(refname)%00%(*objectname)%00%(contents:subject)','refs/tags/sitetiller/published/'])).split('\n').filter(Boolean),releases:any[]=[];
 for(const row of rows){const [ref,commit,message]=row.split('\0');if(!/^refs\/tags\/sitetiller\/published\/v\d+(?:-s\d+)?$/.test(ref)||!commit)continue;const r=JSON.parse(message);if(r.commit!==commit||!Number.isInteger(r.number)||r.number<0||r.tag!==ref.slice(10))throw Error('Neplatný záznam publikované verze.');releases.push(r);}
 return releases.sort((a,b)=>String(a.publishedAt).localeCompare(String(b.publishedAt))||a.number-b.number||(a.minor||0)-(b.minor||0));
}
export async function storeProductionRelease(project:Project,intent:any,commit:string,source:string){
 const tag='sitetiller/published/v'+intent.number+(intent.minor!==undefined?'-s'+intent.minor:'');if(!/^[a-f0-9]{40}$/.test(commit)||!Number.isInteger(intent.number)||intent.number<0||intent.number>999999||intent.minor!==undefined&&(!Number.isInteger(intent.minor)||intent.minor<0||intent.minor>999999)||typeof intent.description!=='string'||intent.description.length>2000)throw Error('Neplatná publikovaná verze.');
 const existing=(await productionReleases(project)).find(r=>r.tag===tag);if(existing){if(existing.commit!==commit||existing.sourceCommit!==source)throw Error('Číslo verze již existuje.');return existing;}
 const record={id:'release-'+intent.number+(intent.minor!==undefined?'.'+intent.minor:''),number:intent.number,...(intent.minor!==undefined?{minor:intent.minor}:{}),description:intent.description,previousCommit:intent.previousCommit||null,...(intent.imported?{imported:true}:{}),tag,commit,sourceCommit:source,publishedAt:new Date().toISOString()};
 await project.git(['-c','user.name=SiteTiller Publisher','-c','user.email=publisher@sitetiller.local','tag','-a',tag,commit,'-m',JSON.stringify(record)]);return record;
}
export async function syncProduction(config:any){const project=productionProject();if(!project){if(config.separatedHistories&&process.env.SITETILLER_PRODUCTION_HISTORY_DIR)throw Error('Historie publikování není dostupná.');return null;}const releases=await productionReleases(project);config.separatedHistories=true;config.releases=releases;const current=releases.at(-1);config.publishedCommit=current?.commit||null;config.publishedTree=current?await project.git(['rev-parse',current.commit+':site']):null;return project;}
