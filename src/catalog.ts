import {roleNames,type Team,type Role} from './team.ts';
import type {Provider} from './core.ts';
export type ListedModel={provider:Provider;id:string;name:string;usable:boolean};
export function usableModel(provider:Provider,id:string){
  if(provider==='anthropic')return id.startsWith('claude-');
  return /^(gpt-|chatgpt-|o[1-9](?:-|$)|ft:(?:gpt-|o[1-9]))/.test(id)&&!/(audio|realtime|transcrib|tts|image|embedding|moderation|search|instruct)/i.test(id);
}
export async function catalog(keys:Record<Provider,string>,fetcher=fetch){
  const results=await Promise.all((['openai','anthropic'] as const).map(async provider=>{
    if(!keys[provider])return {provider,models:[] as ListedModel[],error:'API klíč není nastavený.'};
    try{
      const models:ListedModel[]=[];let after='';const seen=new Set<string>();
      for(let page=0;page<100;page++){
        const url=provider==='openai'?'https://api.openai.com/v1/models':'https://api.anthropic.com/v1/models?limit=1000'+(after?'&after_id='+encodeURIComponent(after):'');
        const response=await fetcher(url,{headers:provider==='openai'?{Authorization:'Bearer '+keys[provider]}:{'x-api-key':keys[provider],'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const body:any=await response.json();if(!Array.isArray(body.data))throw new Error('invalid');
        for(const item of body.data)if(typeof item.id==='string'&&!seen.has(item.id)){seen.add(item.id);models.push({provider,id:item.id,name:typeof item.display_name==='string'?item.display_name:item.id,usable:usableModel(provider,item.id)});}
        if(provider==='openai'||!body.has_more)return {provider,models,error:null};
        if(!body.last_id||after===body.last_id)throw new Error('pagination');after=body.last_id;
      }
      throw new Error('pagination');
    }catch(e:any){const status=/^HTTP \d+$/.test(e.message)?e.message:'spojení se nezdařilo';return {provider,models:[] as ListedModel[],error:(provider==='openai'?'OpenAI':'Claude / Anthropic')+': '+status+'. Nelze ověřit dostupnost modelů.'};}
  }));
  return {models:results.flatMap(r=>r.models).sort((a,b)=>a.provider.localeCompare(b.provider)||a.id.localeCompare(b.id)),providers:results.map(({provider,error,models})=>({provider,error,count:models.length})),checkedAt:new Date().toISOString()};
}
export function unavailable(team:Team,list:Awaited<ReturnType<typeof catalog>>,roles:Role[]=Object.keys(roleNames) as Role[]){
  return roles.flatMap(role=>{const selected=team[role];const provider=list.providers.find(p=>p.provider===selected.provider);if(provider?.error)return [roleNames[role]+' · '+selected.model+': '+provider.error];if(!list.models.some(m=>m.provider===selected.provider&&m.id===selected.model&&m.usable))return [roleNames[role]+' · '+selected.model+': model není dostupný pro tuto roli.'];return [];});
}
