import {createHash} from 'node:crypto';import type {Project} from './project.ts';import {raster} from './images.ts';
export async function hostedSnapshot(project:Project,url:string,fetcher=fetch,publicAddress=url){
 const base=new URL(url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Neplatná adresa nasazeného webu.');
 const publicBase=new URL(publicAddress);if(!['http:','https:'].includes(publicBase.protocol)||publicBase.username||publicBase.password)throw Error('Neplatná veřejná adresa webu.');
 const commit=await project.head(),catalog=await project.committedFiles(commit),names=Object.keys(catalog);if(names.length>200)throw Error('Web překročil limit 200 souborů.');
 const files:Record<string,string>={},binary:Record<string,Buffer>={},resources:any[]=[],warnings:string[]=[];let total=0,different=false;const deadline=Date.now()+90000;
 for(const name of names){
  const address=new URL(name==='site/index.html'?'./':name.slice(5),base);const remaining=deadline-Date.now();if(remaining<=0)throw Error('Načítání webu překročilo časový limit.');
  let response:Response;try{response=await fetcher(address,{signal:AbortSignal.timeout(Math.min(15000,remaining)),cache:'no-store',redirect:'error'});}catch(e:any){if(e.name==='TimeoutError')throw e;throw Error('Soubor skutečného webu se nepodařilo načíst: '+address.pathname+'.');}
  if([404,410].includes(response.status)){warnings.push('Některé dříve nasazené soubory již na webu nejsou dostupné.');continue;}
  if(!response.ok)throw Error('Skutečný web vrátil HTTP '+response.status+'.');
  const chunks:Uint8Array[]=[];let size=0;if(!response.body)throw Error('Web vrátil prázdnou odpověď.');
  for await(const chunk of response.body){size+=chunk.length;total+=chunk.length;if(size>5*1024*1024||total>20*1024*1024){await response.body.cancel().catch(()=>{});throw Error('Web překročil povolenou velikost.');}chunks.push(chunk);}
  const bytes=Buffer.concat(chunks),expected=raster(name)?await project.binary(commit,name):Buffer.from(catalog[name]);if(!expected.equals(bytes))different=true;
  if(raster(name)){files[name]='[Binary image asset]';binary[name]=bytes;}else{if(bytes.length>300000)throw Error('Textový soubor webu překročil limit 300 kB.');files[name]=bytes.toString('utf8');}
  resources.push({path:name,url:new URL(name==='site/index.html'?'./':name.slice(5),publicBase).href,sha256:createHash('sha256').update(bytes).digest('hex'),originalBinaryPreserved:raster(name)});
 }
 if(!files['site/index.html'])throw Error('Úvodní stránka skutečného webu není dostupná.');if(await project.head()!==commit)throw Error('Nasazení se během porovnávání změnilo. Porovnej web znovu.');
 if(different)warnings.push('Skutečný web se liší od souborů posledního nasazení. Porovnává se jeho skutečně dostupný obsah.');
 return {files,binary,evidence:{url:publicBase.href,source:'hosting-http',hostingCommit:commit,catalogVerified:!different,files:resources.length,pages:Object.keys(files).filter(n=>n.endsWith('.html')).length,bytes:total,resources,warnings:[...new Set(warnings)],limitations:'The hosting catalog lists managed files. Actual bytes are read from the served website. Unmanaged new files, private resources and backends are not included.'}};
}
