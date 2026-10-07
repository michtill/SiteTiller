process.env.OPENAI_API_KEY=process.env.OPENAI_API_KEY||'fixture-openai';
process.env.ANTHROPIC_API_KEY=process.env.ANTHROPIC_API_KEY||'fixture-anthropic';
// Test-only provider transport. The application has no test transport or endpoint override.
import {writeFile,appendFile} from 'node:fs/promises';
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 const address=String(url);
 if(!address.startsWith('https://api.openai.com/')&&!address.startsWith('https://api.anthropic.com/'))return realFetch(url,options);
 if(address.includes('/models'))return new Response(JSON.stringify({data:address.includes('openai.com')?[{id:'gpt-design'},{id:'gpt-test'},{id:'gpt-image-1.5'},{id:'gpt-6.1-sol'},{id:'gpt-6-sol'},{id:'gpt-6-luna'},{id:'gpt-6-astra'},{id:'gpt-image-2.5-sunburst'},{id:'gpt-image-2.5-flare'},{id:'gpt-image-2'}]:[{id:'claude-build'},{id:'claude-review'},{id:'claude-sonnet-5-5'}],has_more:false}),{status:200});
 const body=JSON.parse(options.body),instruction=body.instructions||body.system,content=body.input||body.messages[0].content,input=JSON.parse(typeof content==='string'?content:body.input?content[0].content.find(c=>c.type==='input_text').text:content.find(c=>c.type==='text').text);
 let value;
 if(process.env.SITETILLER_TEST_TRACE)await appendFile(process.env.SITETILLER_TEST_TRACE,JSON.stringify({model:body.model,reasoningEffort:body.reasoning?.effort||body.output_config?.effort,input})+'\n');
 if(instruction.includes('Act as WEB LEAD')){
  if(input.request==='Co znamená tato chyba?'){value={action:'answer',summary:'Chyba označuje neplatný odkaz na obrázek; web se nezměnil.'};}else if(input.scope==='create'){
   value={action:'implement',scope:'create',resolvedRequest:input.request,summary:'Nový web kavárny je připravený.',acceptance:[{id:'new-site',category:'required',description:'Create the complete new cafe website',basis:'User request'}],files:[
    {path:'site/index.html',content:'<!doctype html><html><head><title>Cafe</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css?v=1"></head><body><h1>Cafe</h1><a class="button" href="/contact">Contact</a></body></html>'},
    {path:'site/style.css',content:'body{margin:0;color:#222}.button{background:#666;color:white}'},
    {path:'site/contact/index.html',content:'<!doctype html><html><head><title>Contact Cafe</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Contact Cafe</h1><a href="/">Home</a></body></html>'}
   ]};
  }else if(input.request==='Darken the button'||input.request==='Ještě trochu'){
   const followup=input.request==='Ještě trochu',previous=input.recentConversation?.turns.at(-1);
   if(followup&&previous?.request!=='Darken the button')throw Error('Missing conversation context in test transport');
   const colour=followup?'#333':'#444';
   value={action:'implement',resolvedRequest:'Darken .button background to '+colour+'.',summary:'Tlačítko je tmavší.',files:[{path:'site/style.css',content:input.files['site/style.css'].replace(/(\.button\{background:)[^;}]+/,'$1'+colour)}]};
  }else value={action:'implement',summary:'Úprava provedena.',files:[{path:'site/style.css',content:input.files['site/style.css']+'\n/* '+input.request+' */'}]};
 }
 else if(instruction.includes('Verify only necessary'))value={status:'PASS',requiredFixes:[]};
 else{await writeFile(process.env.SITETILLER_TEST_CAPTURE,JSON.stringify(input));value={status:'PASS',requiredFixes:[]};}
 return new Response(JSON.stringify(address.includes('openai.com')?{output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]}:{content:[{type:'text',text:JSON.stringify(value)}]}),{status:200});
};
await import('../../src/server.ts');

