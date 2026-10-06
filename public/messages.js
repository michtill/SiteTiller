export function humanError(message){
 const text=String(message||'');
 if(/photo search or retrieval is not available/i.test(text)&&/photograph/i.test(text))return 'Pro tento požadavek potřebuji skutečnou fotografii. Nahrajte prosím vlastní fotku. Vyhledávání fotografií není dostupné a vygenerovaný obrázek ji nenahradí.';
 return text;
}
