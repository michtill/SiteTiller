import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import http from 'node:http';import https from 'node:https';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {safeSitePath} from './core.ts';
const types:Record<string,string>={'text/html':'html','text/css':'css','application/javascript':'js','text/javascript':'js','image/svg+xml':'svg','image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
export function publicAddress(address:string){
 if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a>=224);}
 if(isIP(address)!==6)return false;const prefix=address.split(':').slice(0,2).map(word=>parseInt(word||'0',16));
 return (prefix[0]&0xe000)===0x2000&&prefix[0]!==0x2002&&!(prefix[0]===0x2001&&(prefix[1]<0x200||prefix[1]===0xdb8));
}
export function publicUrl(value:string){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)||url.hostname==='localhost'||url.hostname.endsWith('.localhost'))throw Error('Načítat lze pouze veřejné HTTP/HTTPS adresy bez přihlašovacích údajů.');url.hash='';return url;}
export function requestedUrl(value:string,prompt:string){
 const url=publicUrl(value),text=prompt.toLowerCase();let allowed=false;
 for(const hostname of new Set([url.hostname,url.hostname.replace(/^www\./,'')])){
  let offset=0,index;while((index=text.indexOf(hostname,offset))!==-1){offset=index+hostname.length;let start=index;
   if(text.slice(Math.max(0,index-4),index)==='www.')start=index-4;
   const before=text[start-1]||'',after=text[offset]||'',following=text[offset+1]||'';
   if((!before||!/[a-z0-9._-]/i.test(before))&&(!after||!/[a-z0-9._-]/i.test(after)||after==='.'&&(!following||/\s/.test(following)))){allowed=true;break;}
  }
 }
 if(!allowed)throw Error('Adresu webu musí uvést uživatel v zadání.');return url.href;
}
type Resource={url:string;mime:string;bytes:Buffer};
export async function fetchPublic(value:string,deadline=Date.now()+45000):Promise<Resource>{
 let url=publicUrl(value);
 for(let redirect=0;redirect<6;redirect++){
  if(Date.now()>=deadline)throw Error('Načítání webu překročilo časový limit.');
  let timer:any;let addresses;
  try{addresses=await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Web neodpověděl v časovém limitu.')),Math.min(10000,Math.max(1,deadline-Date.now())));})]);}catch{throw Error('Adresu veřejného webu se nepodařilo ověřit.');}finally{clearTimeout(timer);}
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('Soukromé a interní síťové adresy nelze načítat.');
  const pinned=addresses[0];
  const result:any=await new Promise((resolve,reject)=>{
   const request=(url.protocol==='https:'?https:http).get(url,{headers:{'User-Agent':'SiteTiller/0.21 website importer','Accept-Encoding':'identity'},lookup:((_host:any,options:any,callback:any)=>options.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)) as any},res=>{
    if(res.statusCode&&[301,302,303,307,308].includes(res.statusCode)){res.resume();resolve({redirect:res.headers.location});return;}
    if(res.statusCode!==200){res.resume();reject(Error('Web vrátil HTTP '+res.statusCode+'.'));return;}
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.resume();reject(Error('Web vrátil nepodporované kódování přenosu.'));return;}
    const chunks:Buffer[]=[];let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024){request.destroy(Error('Soubor webu překročil limit 5 MB.'));return;}chunks.push(chunk);});
    res.on('end',()=>resolve({url:url.href,mime:String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase(),bytes:Buffer.concat(chunks)}));res.on('error',reject);
   });
   request.setTimeout(Math.min(15000,Math.max(1,deadline-Date.now())),()=>request.destroy(Error('Web neodpověděl v časovém limitu.')));request.on('error',reject);
   const absolute=setTimeout(()=>request.destroy(Error('Načítání webu překročilo časový limit.')),Math.max(1,deadline-Date.now()));request.on('close',()=>clearTimeout(absolute));
  });
  if(result.redirect){url=publicUrl(new URL(result.redirect,url).href);continue;}return result;
 }
 throw Error('Web má příliš mnoho přesměrování.');
}
export async function importWebsite(value:string,fetcher=fetchPublic){
 const deadline=Date.now()+45000,first=await fetcher(publicUrl(value).href,deadline);if(first.mime!=='text/html')throw Error('Adresa nevrátila HTML stránku.');
 const origin=new URL(first.url).origin;
 const resources=new Map<string,{resource:Resource;path:string;text?:string}>(),aliases=new Map<string,string>(),warnings:string[]=[];
 const queue:{url:string;page:boolean}[]=[{url:first.url,page:true}],queued=new Set([first.url]);let pages=0,total=0;
 function discover(raw:string,base:string,page=false){
  if(!raw||/^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(raw))return;
  try{const url=publicUrl(new URL(raw.replace(/&amp;/g,'&'),base).href);if(page&&(url.origin!==origin||url.search))return;
   if(queued.has(url.href))return;if(queued.size>=100||page&&pages>=12){warnings.push('Část odkazů nebyla načtena kvůli limitu velikosti webu.');return;}
   const extension=url.pathname.split('.').at(-1)?.toLowerCase();if(!page&&!['css','js','svg','png','jpg','jpeg','webp'].includes(extension||'')){warnings.push('Některé externí nebo nepodporované zdroje zůstávají odkazy na původní web.');return;}
   queued.add(url.href);queue.push({url:url.href,page});
  }catch{warnings.push('Některý odkaz nelze načíst jako veřejný zdroj.');}
 }
 while(queue.length){
  const item=queue.shift()!;if(Date.now()>deadline)throw Error('Načítání webu překročilo časový limit.');
  let resource:Resource;try{resource=item.url===first.url?first:await fetcher(item.url,deadline);}catch(e:any){if(item.url===first.url)throw e;warnings.push('Nepodařilo se načíst '+new URL(item.url).pathname+': '+e.message);continue;}
  aliases.set(item.url,resource.url);if(resources.has(resource.url))continue;
  const ext=types[resource.mime];if(!ext){warnings.push('Nepodporovaný zdroj zůstává na původním webu: '+new URL(item.url).pathname);continue;}
  total+=resource.bytes.length;if(total>20*1024*1024)throw Error('Web překročil limit 20 MB.');
  let path='site/assets/web-'+createHash('sha256').update(resource.url).digest('hex').slice(0,16)+'.'+ext;
  if(ext==='html'){if(++pages>12){warnings.push('Načteno nejvýše 12 stránek.');continue;}const parsed=new URL(resource.url),route=parsed.pathname.replace(/[^a-zA-Z0-9_./-]/g,'_').replace(/(^|\/)\.+(?=\/|$)/g,'$1_');path=resource.url===first.url?'site/index.html':'site'+(route.endsWith('/')?route+'index.html':route.endsWith('.html')?route:route+'/index.html');}
  safeSitePath('/project',path);if([...resources.values()].some(item=>item.path===path))throw Error('Stránky webu mají kolidující cesty.');
  const text=['html','css','js','svg'].includes(ext)?resource.bytes.toString('utf8'):undefined;
  if(text&&Buffer.byteLength(text)>300000)throw Error('Textový soubor webu překročil limit 300 kB.');
  resources.set(resource.url,{resource,path,text});
  if(text&&ext==='html'){
   for(const m of text.matchAll(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi)){const page=m[1].toLowerCase()==='href'&&!/\.(?:css|js|svg|png|jpe?g|webp)(?:\?|$)/i.test(m[3]);discover(m[3],resource.url,page);}
   for(const m of text.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/gi))for(const entry of m[2].split(','))discover(entry.trim().split(/\s+/)[0],resource.url);
  }
  if(text)for(const m of text.matchAll(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)|@import\s+["']([^"']+)["']/gi))discover(m[2]||m[3],resource.url);
  if(text&&ext==='js')for(const m of text.matchAll(/\b(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g))discover(m[1]||m[2],resource.url);
 }
 function rewrite(raw:string,base:string,path:string){if(!raw||/^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(raw))return raw;try{const url=new URL(raw.replace(/&amp;/g,'&'),base),hash=url.hash;url.hash='';const target=resources.get(aliases.get(url.href)||url.href);return target?posix.relative(posix.dirname(path),target.path)+hash:url.href+hash;}catch{return raw;}}
 const files:Record<string,string>={},binary:Record<string,Buffer>={};
 for(const {resource,path,text} of resources.values()){
  if(text===undefined){files[path]='[Binary image asset]';binary[path]=resource.bytes;continue;}
  let changed=text;
  if(path.endsWith('.html')){changed=changed.replace(/<base\b[^>]*>/gi,'').replace(/\b(src|href|poster|action)\s*=\s*(["'])(.*?)\2/gi,(_,attr,q,url)=>attr+'='+q+rewrite(url,resource.url,path)+q).replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi,(_,q,list)=>'srcset='+q+list.split(',').map((entry:string)=>{const [url,...rest]=entry.trim().split(/\s+/);return rewrite(url,resource.url,path)+(rest.length?' '+rest.join(' '):'');}).join(', ')+q);}
  changed=changed.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi,(_,q,url)=>'url('+q+rewrite(url,resource.url,path)+q+')').replace(/(@import\s+)(["'])([^"']+)\2/gi,(_,lead,q,url)=>lead+q+rewrite(url,resource.url,path)+q);
  if(path.endsWith('.js'))changed=changed.replace(/((?:\bfrom|\bimport)\s*)(["'])([^"']+)\2/g,(_,lead,q,url)=>lead+q+(rewrite(url,resource.url,path).startsWith('http')?rewrite(url,resource.url,path):'./'+rewrite(url,resource.url,path))+q);
  files[path]=changed;
 }
 return {files,binary,evidence:{url:first.url,pages,files:Object.keys(files).length,bytes:total,resources:[...resources.values()].map(({resource,path})=>({url:resource.url,path,sha256:createHash('sha256').update(resource.bytes).digest('hex'),originalBinaryPreserved:!!binary[path]})),warnings:[...new Set(warnings)].slice(0,20),limitations:'Public static frontend only. Backend, private data, payments and API services are not copied. External resources may remain external.'}};
}
