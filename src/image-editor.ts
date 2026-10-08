import {decodeImage,imageMime,raster} from './images.ts';
import {diagnosticFetch} from './diagnostics.ts';
import {Project} from './project.ts';
import {withRules} from './instructions.ts';
import {initialImages,type ImageChoices} from './team.ts';

export function capabilityImage(capability:keyof ImageChoices,choices:ImageChoices=initialImages(),models?:{provider:string;id:string}[]){
 const model=choices[capability];if(!model||model==='none'||(models&&!models.some(m=>m.provider==='openai'&&m.id===model)))throw Error('Obrázky · '+capability+': nakonfigurovaný model není dostupný.');
 return model;
}
export async function generateImage(key:string,model:string,prompt:string,fetcher=fetch,options:{format?:'png'|'webp'|'jpeg';background?:'auto'|'opaque'|'transparent'}={}){
 if(!key||!/^gpt-image-[a-zA-Z0-9.-]+$/.test(model))throw Error('Generování obrázku potřebuje dostupný model a OpenAI API klíč.');
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw Error('Neplatné zadání obrázku.');
 const format=options.format||'webp',background=options.background||'auto';if(!['auto','opaque','transparent'].includes(background)||background==='transparent'&&format==='jpeg')throw Error('Průhledné pozadí vyžaduje PNG nebo WebP.');if(!['png','webp','jpeg'].includes(format))throw Error('Neplatný formát obrázku.');
 const response=await diagnosticFetch(fetcher,'https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,prompt:withRules('image',prompt),size:'auto',quality:'medium',output_format:format,background,...(format==='png'?{}:{output_compression:85})}),signal:AbortSignal.timeout(300000)});
 if(!response.ok)throw Error('Generování obrázku: OpenAI vrátil HTTP '+response.status+'.');
 const result:any=await response.json(),image=decodeImage({data:result.data?.[0]?.b64_json});
 if(image.mime!=='image/'+format)throw Error('Obrazový nástroj nevrátil požadovaný formát.');
 return {...image,data:image.bytes.toString('base64'),usage:result.usage||{}};
}

export function imageModel(models:{provider:string;id:string}[]){
  return ['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2','gpt-image-1.5','gpt-image-1'].find(id=>models.some(m=>m.provider==='openai'&&m.id===id))||null;
}
export function imageIssues(selected:string,models:{provider:string;id:string}[]){return !['auto','none'].includes(selected)&&!models.some(m=>m.provider==='openai'&&m.id===selected&&/^gpt-image-/.test(m.id))?['Obrázky · '+selected+': model není dostupný.']:[];}

// Only local, committed website assets are read. Never fetch model-supplied URLs.
export async function websiteImages(project:Project,commit:string,files:Record<string,string>){
  const text=Object.entries(files).filter(([path])=>!raster(path)).map(([,value])=>value).join('\n');
  const images:any[]=[];let total=0;
  for(const path of Object.keys(files).filter(path=>raster(path)&&text.includes(path.slice(5)))){
    if(images.length===4)break;
    const bytes=await project.binary(commit,path);
    if(bytes.length>5*1024*1024||total+bytes.length>8*1024*1024)continue;
    total+=bytes.length;images.push({path,name:path,mime:imageMime(path),data:bytes.toString('base64'),use:'website'});
  }
  return images;
}

export async function editImage(key:string,model:string,source:{data:string;mime:string},prompt:string,fetcher=fetch,options:{format?:'png'|'webp'|'jpeg';background?:'auto'|'opaque'|'transparent'}={}){
  if(!key)throw Error('Úprava obrázků potřebuje OpenAI API klíč.');
  if(!/^gpt-image-[a-zA-Z0-9.-]+$/.test(model))throw Error('Neplatný model pro obrázky.');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw Error('Neplatné zadání úpravy obrázku.');
  const input=decodeImage({data:source.data});
  const format=options.format||'webp',background=options.background||'auto';if(!['auto','opaque','transparent'].includes(background)||background==='transparent'&&format==='jpeg')throw Error('Průhledné pozadí vyžaduje PNG nebo WebP.');if(!['png','webp','jpeg'].includes(format))throw Error('Neplatný výstupní formát obrázku.');
  const body=new FormData();body.set('model',model);body.set('prompt',withRules('image','Edit the supplied image according to the following request. Preserve the subject, identity, composition and aspect ratio except where the request explicitly asks to change them. Do not add text, logos or watermarks.\n'+prompt));
  body.append('image[]',new Blob([input.bytes],{type:input.mime}),input.id);
  body.set('size','auto');body.set('quality','medium');body.set('output_format',format);body.set('background',background);if(format!=='png')body.set('output_compression','85');
  if(/^gpt-image-1(?:\.5)?$/.test(model))body.set('input_fidelity','high');
 const response=await diagnosticFetch(fetcher,'https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:'Bearer '+key},body,signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw Error('Úprava obrázku: OpenAI vrátil HTTP '+response.status+'. Ověř klíč, dostupnost obrazového modelu a kredit. Původní obrázek i náhled zůstaly zachované.');
  const result:any=await response.json(),image=decodeImage({data:result.data?.[0]?.b64_json,name:'Upravený obrázek'});
  if(image.bytes.equals(input.bytes))throw Error('Obrazový model vrátil nezměněný obrázek.');
  if(options.format&&image.mime!=='image/'+format)throw Error('Obrazový nástroj nevrátil požadovaný formát '+format+'.');
  return {...image,data:image.bytes.toString('base64'),usage:result.usage||{}};
}
