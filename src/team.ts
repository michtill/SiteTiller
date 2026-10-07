import type {Slot,Provider} from './core.ts';
export const roleNames={primary:'Web Lead',ui:'UI / Code Specialist',verify:'Verifier',escalation:'Escalation'};
export type Role=keyof typeof roleNames;
export type Choice={provider:Provider;model:string;reasoningEffort?:'auto'|'low'|'medium'|'high'};
export type Team=Record<Role,Choice>;
export const capabilityDefaults={
 PRIMARY:'gpt-6.1-sol',PRIMARY_FALLBACK:'gpt-6-sol',UI_SPECIALIST:'claude-sonnet-5-5',VERIFY:'gpt-6-luna',
 IMAGE_FAST:'gpt-image-2.5-flare',IMAGE_PRECISE:'gpt-image-2.5-sunburst',ESCALATION:'gpt-6-astra'
} as const;
export type ImageChoices={fast:string;precise:string};
export const initialImages=():ImageChoices=>({fast:capabilityDefaults.IMAGE_FAST,precise:capabilityDefaults.IMAGE_PRECISE});
export function initialTeam(_slots:Slot[]=[]):Team {return {
 primary:{provider:'openai',model:capabilityDefaults.PRIMARY,reasoningEffort:'auto'},
 ui:{provider:'anthropic',model:capabilityDefaults.UI_SPECIALIST,reasoningEffort:'auto'},
 verify:{provider:'openai',model:capabilityDefaults.VERIFY,reasoningEffort:'auto'},
 escalation:{provider:'openai',model:capabilityDefaults.ESCALATION,reasoningEffort:'high'}
};}
export function clientFor(team:Team,keys:Record<Provider,string>,role:Role){
 const choice=team[role];if(!choice||!keys[choice.provider])throw Error(roleNames[role]+': chybí API klíč poskytovatele.');
 return {...choice,reasoningEffort:choice.reasoningEffort==='auto'?'medium':choice.reasoningEffort,key:keys[choice.provider],highModel:choice.model,lowModel:choice.model};
}
export function validChoice(value:any):value is Choice {return !!value&&['openai','anthropic'].includes(value.provider)&&typeof value.model==='string'&&/^[a-zA-Z0-9:._-]{1,160}$/.test(value.model)&&(!value.reasoningEffort||['auto','low','medium','high'].includes(value.reasoningEffort));}
export function validTeam(value:any):value is Team {return !!value&&Object.keys(roleNames).every(role=>validChoice(value[role]))&&value.escalation.reasoningEffort!=='auto';}
export function validImages(value:any):value is ImageChoices {return !!value&&['fast','precise'].every(key=>typeof value[key]==='string'&&/^(none|gpt-image-[a-zA-Z0-9.-]+)$/.test(value[key]));}
export function migrateAgentConfig(config:any){
 if(config.agentArchitecture===3){if(config.imageModels?.cheap!==undefined){delete config.imageModels.cheap;return true;}return false;}
 config.legacyAgentSettings={roles:config.roles||null,orchestrator:config.orchestrator||null,imageModel:config.imageModel||null};
 config.roles=initialTeam();config.imageModels=initialImages();config.agentArchitecture=3;
 delete config.orchestrator;delete config.imageModel;return true;
}
export function resolvePrimary(team:Team,models:{provider:string;id:string;usable:boolean}[]):Team {
 if(team.primary.provider==='openai'&&team.primary.model===capabilityDefaults.PRIMARY&&!models.some(m=>m.provider==='openai'&&m.id===capabilityDefaults.PRIMARY&&m.usable)&&models.some(m=>m.provider==='openai'&&m.id===capabilityDefaults.PRIMARY_FALLBACK&&m.usable))return {...team,primary:{...team.primary,model:capabilityDefaults.PRIMARY_FALLBACK}};
 return team;
}
