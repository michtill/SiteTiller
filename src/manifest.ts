import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {safeSitePath} from './core.ts';
import {raster} from './images.ts';
import type {Project} from './project.ts';
export async function projectManifest(project:Project,files:Record<string,string>){
 const signature=createHash('sha256').update(JSON.stringify(files)).digest('hex'),path=join(project.root,'project-manifest.json');
 try{const cached=JSON.parse(await readFile(path,'utf8'));if(cached.signature===signature)return cached;}catch(e:any){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 const manifest={version:1,signature,framework:'Static HTML / CSS / JavaScript',entry:'site/index.html',
  files:Object.entries(files).map(([path,text])=>({path,type:raster(path)?'image':path.split('.').at(-1),bytes:Buffer.byteLength(text),description:raster(path)?'Immutable raster asset':text.match(/<title>(.*?)<\/title>/s)?.[1]||'Project '+path.split('.').at(-1)+' file'})),
  designSystem:Object.entries(files).filter(([p])=>p.endsWith('.css')).flatMap(([path,text])=>[...text.matchAll(/--[\w-]+\s*:\s*[^;}]+/g)].slice(0,40).map(m=>({path,token:m[0]}))),
  checks:{static:'HTML structure, local references, JavaScript syntax',browser:'desktop/mobile load, local HTTP responses, console errors, overflow'},
  constraints:['No server, credential or infrastructure changes by agents','Small edits preserve unrelated content; explicit redesign/new-site scope permits structural rewrites','Original versions remain available in Git history']};
 await writeFile(path,JSON.stringify(manifest));return manifest;
}
export function selectContext(files:Record<string,string>,paths:string[]=['site/index.html']){
 if(!Array.isArray(paths)||paths.length>30)throw Error('Neplatný výběr kontextu.');
 const selected:Record<string,string>={};let bytes=0;
 for(const path of paths){safeSitePath('/project',path);if(!(path in files))throw Error('Soubor kontextu neexistuje: '+path);bytes+=Buffer.byteLength(files[path]);if(bytes>500000)throw Error('Kontext překročil limit; vyber méně souborů.');selected[path]=files[path];}
 return selected;
}
export function initialContext(files:Record<string,string>){
 if(!files['site/index.html'])return {};
 const paths=['site/index.html'];const entry=files[paths[0]]||'';
 for(const path of Object.keys(files))if(/\.(css|js)$/.test(path)&&entry.includes(path.slice(5))&&paths.length<8)paths.push(path);
 return selectContext(files,paths);
}
