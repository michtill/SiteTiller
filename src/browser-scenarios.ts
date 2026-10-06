import {safeSitePath} from './core.ts';
const actions=['click','fill','select','focus','press','expectText','expectValue','expectCount','expectVisible','expectAttribute','expectFocused'];
export const browserTestContract='browserTests?:[{name:string,path:"site/<page>.html",steps:[{action:"click"|"fill"|"select"|"focus"|"press"|"expectText"|"expectValue"|"expectCount"|"expectVisible"|"expectAttribute"|"expectFocused",selector:string,value?:string,key?:string,equals?:string,contains?:string,count?:number,visible?:boolean,attribute?:string}]}]. fill/select/expectValue require value:string. expectText requires equals:string OR contains:string. expectAttribute requires attribute:string and either value:string|null for an exact match OR contains:string for a substring match. Example image check: {action:"expectAttribute",selector:".hero img",attribute:"src",contains:"assets/"}. expectCount requires count:integer; expectVisible requires visible:boolean. Max 4 scenarios and 32 total steps. Use exact CSS selectors. Each scenario starts from a fresh page and must assert actual required behavior. press allows Tab, Shift+Tab, Enter, Space, arrows, Home, End, Escape, Backspace, Control+A. Include keyboard focus/activation evidence when required. Never click final real purchase, send an external form or invent evidence. Host executes these actions in an isolated browser with external requests blocked. For missing interaction evidence, return implement with files:[] and browserTests targeting the unchanged candidate; do not modify correct source just to claim tests ran.';
export function validateBrowserTests(value:any,files:Record<string,string>){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>4||value.reduce((n,t)=>n+(Array.isArray(t?.steps)?t.steps.length:100),0)>32)throw Error('Neplatný rozsah testů prohlížeče.');
 for(const test of value){
  if(!test||typeof test.name!=='string'||!test.name.trim()||test.name.length>160||typeof test.path!=='string')throw Error('Neplatný scénář prohlížeče.');
  safeSitePath('/project',test.path);if(!test.path.endsWith('.html')||!Object.hasOwn(files,test.path)||!Array.isArray(test.steps)||!test.steps.length||!test.steps.some((s:any)=>s?.action?.startsWith('expect')))throw Error('Scénář musí mít existující stránku a ověření výsledku.');
  for(const s of test.steps){
   if(!s||!actions.includes(s.action)||typeof s.selector!=='string'||!s.selector.trim()||s.selector.length>400)throw Error('Neplatný krok prohlížeče.');
   if(['expectValue','expectAttribute'].includes(s.action)&&s.value===undefined&&s.equals!==undefined)s.value=s.equals;
   if(['fill','select','expectValue','expectAttribute'].includes(s.action)&&typeof s.value==='number'&&Number.isFinite(s.value))s.value=String(s.value);
   if(s.action==='expectText'&&typeof s.equals==='number'&&Number.isFinite(s.equals))s.equals=String(s.equals);
   if(['fill','select','expectValue'].includes(s.action)&&(typeof s.value!=='string'||s.value.length>1000))throw Error('Krok '+s.action+' vyžaduje textovou hodnotu value.');
   if(s.action==='expectAttribute'&&!(s.value===null||typeof s.value==='string'&&s.value.length<=1000||typeof s.contains==='string'&&s.contains.length>0&&s.contains.length<=1000))throw Error('Ověření atributu vyžaduje hodnotu value nebo text contains.');
   if(s.action==='press'&&!/^(Tab|Shift\+Tab|Enter|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|Escape|Backspace|Control\+A)$/.test(s.key||''))throw Error('Nepodporovaná klávesa testu.');
   if(s.action==='expectText'&&!(typeof s.equals==='string'&&s.equals.length<=1000||typeof s.contains==='string'&&s.contains.length>0&&s.contains.length<=1000))throw Error('Chybí očekávaný text.');
   if(s.action==='expectCount'&&(!Number.isInteger(s.count)||s.count<0||s.count>100))throw Error('Neplatný očekávaný počet.');
   if(s.action==='expectVisible'&&typeof s.visible!=='boolean')throw Error('Neplatná očekávaná viditelnost.');
   if(s.action==='expectAttribute'&&(typeof s.attribute!=='string'||!/^[-\w]{1,80}$/.test(s.attribute)))throw Error('Neplatný atribut testu.');
  }
 }
 return value;
}
export async function runBrowserScenario(page:any,test:any,budgetMs=30000){
 const budgetDeadline=Date.now()+budgetMs;
 const steps:any[]=[];let error:string|undefined;
 for(const s of test.steps){
  const step:any={...s,passed:false};steps.push(step);const loc=page.locator(s.selector);
  try{
   if(Date.now()>=budgetDeadline)throw Error('Interaction test budget exhausted');
   if(s.action==='click')await loc.click({timeout:1800});
   else if(s.action==='fill')await loc.fill(s.value,{timeout:1800});
   else if(s.action==='select')await loc.selectOption(s.value,{timeout:1800});
   else if(s.action==='focus')await loc.focus({timeout:1800});
   else if(s.action==='press')await loc.press(s.key,{timeout:1800});
   else{
    const deadline=Date.now()+1800;let matched=false;
    do{
     if(s.action==='expectText'){step.actual=(await loc.textContent({timeout:500})||'').trim();matched=s.equals!==undefined?step.actual===s.equals:step.actual.includes(s.contains);}
     else if(s.action==='expectValue'){step.actual=await loc.inputValue({timeout:500});matched=step.actual===s.value;}
     else if(s.action==='expectCount'){step.actual=await loc.count();matched=step.actual===s.count;}
     else if(s.action==='expectVisible'){step.actual=await loc.isVisible();matched=step.actual===s.visible;}
     else if(s.action==='expectAttribute'){step.actual=await loc.getAttribute(s.attribute,{timeout:500});matched=s.contains!==undefined?typeof step.actual==='string'&&step.actual.includes(s.contains):step.actual===s.value;}
     else if(s.action==='expectFocused'){step.actual=await loc.evaluate((n:Element)=>n===document.activeElement,{},{timeout:500});matched=step.actual===true;}
     if(matched)break;await page.waitForTimeout(60);
    }while(Date.now()<deadline);
    if(!matched)throw Error('Expected '+s.action+' did not match actual '+JSON.stringify(step.actual));
   }
   step.passed=true;
  }catch(e:any){step.error=String(e.message).slice(0,500);error=step.error;break;}
 }
 return {name:test.name,path:test.path,passed:!error,steps,...(error?{error}:{})};
}
