export function attachmentPaths(images:any[]){
 const aliases=new Map<string,string>();
 for(const image of images.filter(i=>i.use==='website')){
  const path='site/assets/'+image.id;
  for(const alias of [image.id,'assets/'+image.id,'/assets/'+image.id,path,'/'+path,'/api/images/'+image.id])aliases.set(alias,path);
  if(/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(image.name||'')&&images.filter(i=>i.use==='website'&&i.name===image.name).length===1){for(const alias of [image.name,'assets/'+image.name,'site/assets/'+image.name])aliases.set(alias,path);}
 }
 return (path:any)=>aliases.get(path)||path;
}
