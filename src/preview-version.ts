import type {Project} from './project.ts';
import {readFile} from 'node:fs/promises';import {join} from 'node:path';
export async function previewVersion(project:Project,url:URL,studio=false){
 const route=url.pathname.replace(/^\/preview\/?/,'').replace(/^\//,'');
 const match=route.match(/^versions\/([a-f0-9]{40})\/(.*)$/),head=await project.head();
 if(match){
  try{const config=JSON.parse(await readFile(join(project.root,'..','config.json'),'utf8'));if(Array.isArray(config.requests)){const allowed=new Set([head,...(config.releases||[]).map((r:any)=>r.commit),...config.requests.filter((r:any)=>r.status==='ready'||r.status==='legacy').map((r:any)=>r.commit)]);if(!allowed.has(match[1]))return null;}}
  catch(e:any){if(e.code!=='ENOENT')throw e;}
  try{await project.git(['merge-base','--is-ancestor',match[1],head]);}catch{return null;}
 }
 return {commit:match?.[1]||head,relative:decodeURIComponent(match?.[2]??route),prefix:(studio?'/preview/':'/')+(match?'versions/'+match[1]+'/':'')};
}
export function versionReferences(content:string,prefix:string){
 return content.replace(/((?:src|href|action)=["'])\/(?!\/)([^"']*)/gi,(_,lead,path)=>lead+prefix+path).replace(/url\(\s*(["']?)\/(?!\/)([^)]*?)\1\s*\)/gi,(_,quote,path)=>'url('+quote+prefix+path+quote+')');
}
