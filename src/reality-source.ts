import {importWebsite,publicUrl} from './web-import.ts';import {safeSitePath} from './core.ts';import {raster} from './images.ts';
export async function realitySnapshot(url:string,publishUrl:string|undefined,token:string|undefined,fetcher=fetch,importer=importWebsite){
 if(!publishUrl||!token)return importer(url);
 const endpoint=new URL(publishUrl);if(!endpoint.pathname.endsWith('/publish'))throw Error('Neplatné připojení k hostingu.');endpoint.pathname=endpoint.pathname.slice(0,-8)+'/snapshot';endpoint.search='';endpoint.hash='';
 const response=await fetcher(endpoint,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(110000),cache:'no-store'});
 if(response.status===501||response.status===404)return importer(url);
 if(!response.ok){const failure:any=await response.json().catch(()=>({}));throw Error(failure.error||'Načtení skutečného webu z hostingu selhalo.');}
 let size=0;const chunks:Uint8Array[]=[];if(!response.body)throw Error('Hosting nevrátil žádný obsah.');for await(const chunk of response.body){size+=chunk.length;if(size>35*1024*1024)throw Error('Web překročil povolenou velikost.');chunks.push(chunk);}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const identity=(address:string)=>{const parsed=publicUrl(address);parsed.pathname=parsed.pathname.replace(/\/index\.html$/,'/');return parsed.href;};
 if(identity(value.evidence?.url)!==identity(url))return importer(url);
 if(!value.files||typeof value.files!=='object'||!value.binary||!Array.isArray(value.evidence.resources)||Object.keys(value.files).length>200)throw Error('Hosting nevrátil platný snímek webu.');
 const binary:Record<string,Buffer>={};let total=0;
 for(const [path,content] of Object.entries(value.files)){safeSitePath('/project',path);if(typeof content!=='string')throw Error('Neplatný obsah souboru webu.');if(raster(path)){const encoded=value.binary[path];if(typeof encoded!=='string'||encoded.length>7000000||! /^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('Neplatný obrázek webu.');binary[path]=Buffer.from(encoded,'base64');total+=binary[path].length;}else{if(Buffer.byteLength(content)>300000)throw Error('Textový soubor webu překročil limit 300 kB.');total+=Buffer.byteLength(content);}if(total>20*1024*1024)throw Error('Web překročil povolenou velikost.');}
 for(const resource of value.evidence.resources){safeSitePath('/project',resource.path);publicUrl(resource.url);if(!Object.hasOwn(value.files,resource.path))throw Error('Neplatná cesta snímku webu.');}
 return {...value,binary};
}
