import {english} from './translations.js';
import {czech} from './translations.cs.js';

// Shared registry: add a snake_case dictionary and one language entry here.
export const defaultLocale='en';
export const languages={
  en:{name:'English',dateLocale:'en-GB',messages:english},
  cs:{name:'Čeština',dateLocale:'cs-CZ',messages:czech}
};
export function normalizeLocale(value){return Object.hasOwn(languages,value)?value:defaultLocale;}
export function translate(key,language=defaultLocale,params={}){
  const code=String(key??''),messages=languages[normalizeLocale(language)].messages||{};
  const template=Object.hasOwn(messages,code)?messages[code]:Object.hasOwn(english,code)?english[code]:code;
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g,(token,name)=>Object.hasOwn(params,name)?String(params[name]):token);
}

// Compatibility for system messages stored by earlier versions and the server.
// New interface code always uses technical keys; AI/user text bypasses this adapter.
const legacyKeys=new Map(Object.entries(czech).map(([key,text])=>[text,key]));
const legacyPatterns=[
  [/^Verze (\d+(?:\.\d+)?) byla publikována\.$/,'version_published',['version']],
  [/^Verze (\d+(?:\.\d+)?) publikována$/,'version_published_short',['version']],
  [/^Poskytovatel ([\w-]+) vrátil HTTP (\d+)\. Ověř klíč, model a kredit\.$/,'provider_http_error',['provider','status']]
];
export function translateMessage(value,language=defaultLocale){
  const text=String(value??'');
  if(Object.hasOwn(english,text))return translate(text,language);
  const key=legacyKeys.get(text);if(key)return translate(key,language);
  const trimmed=text.trim(),trimmedKey=legacyKeys.get(trimmed);
  if(trimmedKey)return text.replace(trimmed,()=>translate(trimmedKey,language));
  for(const [pattern,key,names] of legacyPatterns){const match=text.match(pattern);if(match)return translate(key,language,Object.fromEntries(names.map((name,index)=>[name,match[index+1]])));}
  return text;
}
