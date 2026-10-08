import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {withDiagnostics,recordDiagnostic,diagnosticFetch} from '../src/diagnostics.ts';import {callModel} from '../src/providers.ts';
const lines=async(data:string,id:string)=>(await readFile(join(data,'diagnostics',id+'.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));

test('a failed job keeps complete provider exchanges and tool events privately, without credentials or reasoning',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-diagnostic-')),id='a'.repeat(16),key='fixture-private-provider-key';
 try{
  await assert.rejects(withDiagnostics(data,{id,kind:'edit',prompt:'Import this website'},[key],async()=>{
   await callModel({provider:'openai',model:'fixture-lead',key} as any,'Lead instructions',{originalRequest:'Import this website',files:{'site/index.html':'Complete website context'}},async()=>new Response(JSON.stringify({output:[{type:'reasoning',summary:[{text:'private reasoning must never be recorded'}]},{content:[{type:'output_text',text:'{"action":"delegate","task":"Implement the website"}'}]}],usage:{input_tokens:12}})));
   await recordDiagnostic('event',{event:{stage:'build',tool:'import',url:'https://example.com'}});
   await callModel({provider:'anthropic',model:'fixture-specialist',key} as any,'Specialist instructions',{task:'Implement the website'},async()=>new Response(JSON.stringify({error:{type:'rate_limit_error',message:'Account limit; echoed '+key}}),{status:429,headers:{'request-id':'fixture-request'}}));
  }),/HTTP 429/);
  const records=await lines(data,id),text=JSON.stringify(records),requests=records.filter(r=>r.type==='provider_request'),responses=records.filter(r=>r.type==='provider_response');
  assert.equal(requests.length,2);assert.equal(responses.length,2);assert.match(requests[0].body.instructions,/Lead instructions/);
  assert.equal(JSON.parse(requests[0].body.input).files['site/index.html'],'Complete website context');
  assert.equal(JSON.parse(responses[0].body.output[1].content[0].text).action,'delegate');
  assert.equal(responses[1].status,429);assert.equal(responses[1].requestId,'fixture-request');
  assert.ok(records.some(r=>r.type==='event'&&r.event.tool==='import'));assert.equal(records.at(-1).type,'job_error');
  assert.ok(!text.includes(key));assert.ok(!text.includes('private reasoning must never be recorded'));
  assert.deepEqual(records.map(r=>r.sequence),records.map((_,index)=>index+1));
 }finally{await rm(data,{recursive:true,force:true});}
});
test('invalid JSON retries are kept and successful jobs discard temporary transcripts',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-diagnostic-')),id='b'.repeat(16);let calls=0;
 try{
  await assert.rejects(withDiagnostics(data,{id,kind:'edit'},[],()=>callModel({provider:'openai',model:'fixture',key:'fake'} as any,'Instructions',{request:'Test'},async()=>{calls++;return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:'invalid JSON answer '+calls}]}]}));})),/JSON/);
  const records=await lines(data,id);assert.equal(calls,2);assert.equal(records.filter(r=>r.type==='provider_response').length,2);assert.match(records.filter(r=>r.type==='provider_request')[1].body.instructions,/previous response was invalid JSON/);
  await withDiagnostics(data,{id:'c'.repeat(16),kind:'edit'},[],async()=>{await recordDiagnostic('event',{event:{stage:'ready'}});return {ok:true};});
  assert.deepEqual(await readdir(join(data,'diagnostics')),[id+'.jsonl']);
 }finally{await rm(data,{recursive:true,force:true});}
});
test('multipart image inputs remain reconstructable and rejected reviews retain their exchanges',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-diagnostic-')),id='d'.repeat(16),bytes=Buffer.from('image bytes');
 try{
  await withDiagnostics(data,{id,kind:'review'},[],async()=>{
   const body=new FormData();body.set('prompt','Edit the supplied image');body.append('image[]',new Blob([bytes],{type:'image/png'}),'original.png');
   await diagnosticFetch(async()=>new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]})),'https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:'Bearer hidden'},body});
   return {review:{approved:false}};
  });
  const records=await lines(data,id),request=records.find(r=>r.type==='provider_request');assert.equal(request.body.multipart[0].value,'Edit the supplied image');assert.deepEqual(Buffer.from(request.body.multipart[1].value.base64,'base64'),bytes);assert.equal(records.at(-1).status,'rejected');assert.ok(!JSON.stringify(records).includes('Bearer hidden'));
 }finally{await rm(data,{recursive:true,force:true});}
});
test('retention keeps the latest twenty failed job files and does not remove other data',async()=>{
 const data=await mkdtemp(join(tmpdir(),'sitetiller-diagnostic-'));
 try{
  for(let index=0;index<21;index++)await assert.rejects(withDiagnostics(data,{id:index.toString(16).padStart(16,'0'),kind:'edit'},[],async()=>{throw Error('Failure');}));
  assert.equal((await readdir(join(data,'diagnostics'))).length,20);
 }finally{await rm(data,{recursive:true,force:true});}
});
