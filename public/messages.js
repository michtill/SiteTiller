export function humanError(message){
 const text=String(message||'');
 if(/photo search or retrieval is not available/i.test(text)&&/photograph/i.test(text))return 'Pro tento požadavek potřebuji skutečnou fotografii. Nahrajte prosím vlastní fotku. Vyhledávání fotografií není dostupné a vygenerovaný obrázek ji nenahradí.';
 return text;
}

export function displayMessage(event,translate=value=>value){if(!event)return '';const fromAgent=event.agentResponse!==undefined?event.agentResponse:event.stage==='build'&&event.status==='completed'&&!!event.model;return fromAgent?String(event.message||''):translate(event.stage==='failed'?humanError(event.message):event.message||'');}
