import {english} from './translations.js';

// Register each language here; the server and language picker share this list.
// Dictionary keys are the Czech source strings, including dynamic templates.
export const defaultLocale='en';
export const languages={
  en:{name:'English',dateLocale:'en-GB',messages:english},
  cs:{name:'Čeština',dateLocale:'cs-CZ',messages:null}
};
export function normalizeLocale(value){return Object.hasOwn(languages,value)?value:defaultLocale;}
export const dynamicMessages=[
  [/^Verze (\d+(?:\.\d+)?) byla publikována\.$/,'Verze $1 byla publikována.'],
  [/^Verze (\d+(?:\.\d+)?) publikována$/,'Verze $1 publikována'],
  [/^Poskytovatel ([\w-]+) vrátil HTTP (\d+)\. Ověř klíč, model a kredit\.$/,'Poskytovatel $1 vrátil HTTP $2. Ověř klíč, model a kredit.']
];
export function translate(value,language=defaultLocale){
  const text=String(value??''),selected=normalizeLocale(language);
  if(selected==='cs')return text;
  const messages=languages[selected].messages||{},fallback=languages[defaultLocale].messages;
  const lookup=key=>Object.hasOwn(messages,key)?messages[key]:Object.hasOwn(fallback,key)?fallback[key]:undefined;
  const exact=lookup(text);if(exact!==undefined)return exact;
  const trimmed=lookup(text.trim());if(trimmed!==undefined)return text.replace(text.trim(),()=>trimmed);
  for(const [pattern,template] of dynamicMessages)if(pattern.test(text))return text.replace(pattern,lookup(template)??template);
  return text;
}
