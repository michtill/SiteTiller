import {createHash} from 'node:crypto';
export const raster=(name:string)=>/\.(png|jpg|jpeg|webp)$/i.test(name);
export const imageMime=(name:string)=>name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'image/jpeg';
export function decodeImage(input:any){
 if(typeof input?.data!=='string'||input.data.length>7000000||! /^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw Error('Neplatný obrázek, limit je 5 MB.');
 const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>5*1024*1024)throw Error('Obrázek musí mít nejvýše 5 MB.');
 const ext=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':null;
 if(!ext)throw Error('Použij PNG, JPEG nebo WebP.');
 const id=createHash('sha256').update(bytes).digest('hex')+'.'+ext;
 return {id,name:String(input.name||'Obrázek').slice(0,150),mime:imageMime(id),bytes};
}
export function selectImages(input:any,stored:any[]){
 if(input===undefined)return [];if(!Array.isArray(input)||input.length>4)throw Error('Přilož nejvýše čtyři obrázky.');
 const seen=new Set();return input.map(value=>{const item=stored.find(i=>i.id===value.id);if(!item||seen.has(item.id)||!['reference','website','auto'].includes(value.use))throw Error('Neplatná příloha.');seen.add(item.id);return {...item,use:value.use,comment:typeof value.comment==='string'?value.comment.slice(0,1000):''};});
}
