import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir,open,rm,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

type Recording={file:any;secrets:string[];sequence:number;writes:Promise<void>};
const recording=new AsyncLocalStorage<Recording>();

function privateValue(value:any,secrets:string[]):any{
 if(typeof value==='string'){for(const secret of secrets)if(secret)value=value.replaceAll(secret,'[credential redacted]');return value;}
 if(Array.isArray(value))return value.map(item=>privateValue(item,secrets));
 if(value&&typeof value==='object'){
  if(['reasoning','thinking','redacted_thinking'].includes(value.type))return {type:value.type,omitted:true};
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(authorization|x-api-key|api_?key|access_token|password)$/i.test(key)?'[credential redacted]':privateValue(item,secrets)]));
 }
 return value;
}
export function recordDiagnostic(type:string,value:any):Promise<void>{
 const context=recording.getStore();if(!context)return Promise.resolve();
 const line=JSON.stringify({sequence:++context.sequence,at:new Date().toISOString(),type,...privateValue(value,context.secrets)})+'\n';
 context.writes=context.writes.then(async()=>{await context.file.write(line);});return context.writes;
}
async function prune(directory:string){
 const files=await Promise.all((await readdir(directory)).filter(name=>/^[a-f0-9]{16}\.jsonl$/.test(name)).map(async name=>({name,time:(await stat(join(directory,name))).mtimeMs})));
 files.sort((a,b)=>b.time-a.time);for(const file of files.slice(20))await rm(join(directory,file.name));
}
export async function withDiagnostics<T>(data:string,metadata:{id:string;kind:string;[key:string]:any},secrets:string[],work:()=>Promise<T>):Promise<T>{
 if(!/^[a-f0-9]{16}$/.test(metadata.id))throw Error('Invalid diagnostic job ID');
 const directory=join(data,'diagnostics');await mkdir(directory,{recursive:true,mode:0o700});
 const path=join(directory,metadata.id+'.jsonl'),file=await open(path,'wx',0o600);
 const context:Recording={file,secrets:secrets.filter(Boolean),sequence:0,writes:Promise.resolve()};let failed=true;
 try{return await recording.run(context,async()=>{
  await recordDiagnostic('job_start',{job:metadata});
  try{
   const result=await work();failed=(result as any)?.review?.approved===false;
   await recordDiagnostic('job_end',{status:failed?'rejected':'succeeded'}).catch(()=>console.error('SiteTiller diagnostic completion could not be recorded.'));return result;
  }catch(error:any){await recordDiagnostic('job_error',{error:{name:error.name,message:error.message,stack:error.stack}}).catch(()=>console.error('SiteTiller diagnostic failure could not be recorded.'));throw error;}
 });}finally{
  await context.writes.catch(()=>{});await file.close().catch(()=>console.error('SiteTiller diagnostic file could not be closed.'));
  // Cleanup must not replace a provider error or invalidate a committed edit.
  await (failed?prune(directory):rm(path)).catch(()=>console.error('SiteTiller diagnostic cleanup failed.'));
 }
}

// Only provider transport uses this wrapper. Keys/authorization and private
// reasoning are omitted; complete prompts, tool context and returned answers stay.
export async function diagnosticFetch(fetcher:typeof fetch,url:string,options:RequestInit):Promise<Response>{
 if(!recording.getStore())return fetcher(url,options);
 const callId=randomBytes(8).toString('hex');let body:any=options.body;
 if(typeof body==='string'){try{body=JSON.parse(body);}catch{}}
 else if(body instanceof FormData){const fields:any[]=[];for(const [name,value] of body.entries())fields.push({name,value:typeof value==='string'?value:{name:value.name,type:value.type,base64:Buffer.from(await value.arrayBuffer()).toString('base64')}});body={multipart:fields};}
 const headers=new Headers(options.headers),safeHeaders=Object.fromEntries(['content-type','anthropic-version'].filter(name=>headers.has(name)).map(name=>[name,headers.get(name)]));
 await recordDiagnostic('provider_request',{callId,url,method:options.method,headers:safeHeaders,body});
 try{
  const response=await fetcher(url,options),text=await response.clone().text();let result:any=text;try{result=JSON.parse(text);}catch{}
  await recordDiagnostic('provider_response',{callId,status:response.status,requestId:response.headers.get('x-request-id')||response.headers.get('request-id'),body:result});return response;
 }catch(error:any){await recordDiagnostic('provider_error',{callId,error:{name:error.name,message:error.message}});throw error;}
}
