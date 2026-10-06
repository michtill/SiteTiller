import {websitePolicy} from './site-policy.ts';
import {validateBrowserTests,runBrowserScenario} from './browser-scenarios.ts';
import {Script} from 'node:vm';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {validateFiles,safeSitePath,resolveSiteFile} from './core.ts';
import {raster,imageMime} from './images.ts';
export function staticChecks(files:Record<string,string>){
 const errors=validateFiles(files);
 for(const [path,text] of Object.entries(files)){
  const scripts=path.endsWith('.js')?[text]:path.endsWith('.html')?[...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>!m[1].includes('src=')&&!/type\s*=\s*["'](?:application\/ld\+json|module)["']/i.test(m[1])).map(m=>m[2]):[];
  for(const script of scripts)try{if(!/^\s*(?:import|export)\s/m.test(script))new Script(script,{filename:path});}catch{errors.push('JavaScript syntax error: '+path);}
 }
 return {passed:errors.length===0,errors,checks:['HTML structure','local references','classic JavaScript syntax'],limitations:['Module JavaScript is validated during browser loading.']};
}
// Ephemeral isolated preview. Never exposes the studio, credentials or project metadata.
export async function browserChecks(root:string,files:Record<string,string>,browserTests:any[]=[]){
 validateBrowserTests(browserTests,files);const scenarios:any[]=[];let scenarioTime=0;
 const {chromium}=await import('playwright');
 const errors:string[]=[],warnings:string[]=[],screenshots:any[]=[],checks:any[]=[],interactions:any[]=[];
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url||'/','http://127.0.0.1'),name=resolveSiteFile(decodeURIComponent(url.pathname),files);
   safeSitePath(root,name);if(!(name in files)){res.writeHead(404);return res.end();}
   if(!url.pathname.endsWith('/')&&!Object.hasOwn(files,'site/'+decodeURIComponent(url.pathname).slice(1))){res.writeHead(302,{Location:url.pathname+'/'+url.search});return res.end();}
   const mime:any={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.json':'application/json'};
   res.writeHead(200,{'Content-Type':raster(name)?imageMime(name):mime[extname(name)]||'text/plain','Content-Security-Policy':websitePolicy});
   res.end(raster(name)?await readFile(join(root,name)):files[name]);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let browser:any;
 try{
  browser=await chromium.launch({headless:true,...(process.env.AIWE_BROWSER_EXECUTABLE?{executablePath:process.env.AIWE_BROWSER_EXECUTABLE}:{})});
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  const pages=Object.keys(files).filter(p=>p.endsWith('.html'));
  if(pages.length>20)throw Error('Browser check supports at most 20 pages per request.');
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
   const context=await browser.newContext({viewport});
   await context.route('**/*',async(route:any)=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    return route.continue();
   });
   for(const path of pages){
    const page=await context.newPage(),label=path+' @ '+viewport.width;
    page.on('pageerror',(e:any)=>errors.push(label+': '+e.message.slice(0,300)));
    page.on('response',(r:any)=>{if(r.url().startsWith(origin)&&r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(label+': HTTP '+r.status()+' '+new URL(r.url()).pathname);});
    // External resources are blocked to prevent preview scripts contacting real services.
    page.on('console',(msg:any)=>{if(msg.type()==='error'&&!/ERR_FAILED|ERR_BLOCKED|Content Security Policy|violates.*directive/i.test(msg.text()))errors.push(label+': '+msg.text().slice(0,300));});
    const response=await page.goto(origin+'/'+path.slice(5),{waitUntil:'load',timeout:15000});
    if(response?.status()!==200)errors.push(label+': page did not load');
    const dom=await page.evaluate(()=>({body:!!document.body,overflow:document.documentElement.scrollWidth>window.innerWidth+2}));
    if(!dom.body)errors.push(label+': missing body');if(dom.overflow)errors.push(label+': horizontal overflow');
    checks.push({path,viewport:viewport.width,status:response?.status(),body:dom.body,overflow:dom.overflow});
    if(viewport.width===390){
     const toggles=page.locator('button[aria-controls][aria-expanded]');
     for(let index=0;index<Math.min(await toggles.count(),8);index++){
      const toggle=toggles.nth(index);if(!await toggle.isVisible())continue;
      const targetId=(await toggle.getAttribute('aria-controls')||'').trim().split(/\s+/)[0],target=page.locator('[id='+JSON.stringify(targetId)+']');
      if(await target.count()!==1){errors.push(label+': toggle references a missing or ambiguous controlled element '+targetId);continue;}
      const initiallyOpen=await toggle.getAttribute('aria-expanded')==='true';
      const visibility=async()=>await target.evaluate((element:HTMLElement)=>{
       const rect=element.getBoundingClientRect();let node:HTMLElement|null=element;
       while(node){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||node.hidden)return false;node=node.parentElement;}
       return rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight;
      });
      const states:any[]=[];
      for(let click=0;click<2;click++){await toggle.click({timeout:5000});await page.waitForTimeout(300);states.push({expanded:await toggle.getAttribute('aria-expanded')==='true',visible:await visibility()});}
      const opened=initiallyOpen?states[1]:states[0],closed=initiallyOpen?states[0]:states[1];
      const passed=opened.expanded&&opened.visible&&!closed.expanded&&!closed.visible;
      interactions.push({path,viewport:viewport.width,type:'mobile-disclosure',targetId,initiallyOpen,opened,closed,restoredInitialState:states[1].expanded===initiallyOpen,passed});
      if(!passed)errors.push(label+': mobile toggle must open and close '+targetId+' and update aria-expanded correctly');
     }
    }
    if(path==='site/index.html')screenshots.push({name:label,mime:'image/png',data:(await page.screenshot()).toString('base64')});
    await page.close();
   }
   for(const test of browserTests){
    const start=Date.now();if(scenarioTime>30000){errors.push('Browser interaction scenarios exceeded the 30 second budget');break;}
    const page=await context.newPage();let execution:any;
    try{page.on('pageerror',(e:any)=>errors.push(test.name+': '+e.message.slice(0,300)));const response=await page.goto(origin+'/'+test.path.slice(5),{waitUntil:'load',timeout:10000});if(response?.status()!==200)throw Error('Scenario page did not load');execution=await runBrowserScenario(page,test,Math.max(0,30000-scenarioTime-(Date.now()-start)));}
    catch(e:any){execution={name:test.name,path:test.path,passed:false,error:String(e.message).slice(0,500),steps:[]};}
    finally{await page.close();scenarioTime+=Date.now()-start;}
    scenarios.push({...execution,viewport:viewport.width});if(!execution.passed)errors.push(test.name+' @ '+viewport.width+': '+execution.error);
   }
   await context.close();
  }
  warnings.push('External services are blocked during smoke tests; real Spotify/Mailchimp requests are not tested.');
  return {passed:errors.length===0,errors:[...new Set(errors)],warnings,checks,interactions,scenarios,screenshots};
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
