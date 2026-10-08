import {languages,normalizeLocale,translate,translateMessage} from './locales.js';
export {normalizeLocale} from './locales.js';
let saved;try{saved=globalThis.localStorage?.getItem('sitetiller-language');}catch{}
export const locale=normalizeLocale(saved||globalThis.document?.documentElement.lang);
export const dateLocale=languages[locale].dateLocale||locale;
export function t(key,params={},language=locale){return translate(key,language,params);}
export function tm(value,language=locale){return translateMessage(value,language);}
export function populateLanguagePicker(select){select.replaceChildren();for(const [code,language] of Object.entries(languages)){const option=document.createElement('option');option.value=code;option.textContent=language.name;select.append(option);}select.value=locale;}
export function translateDocument(){
 if(!globalThis.document)return;document.documentElement.lang=locale;
 for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=t(el.dataset.i18n);
 for(const attr of ['title','aria-label','placeholder'])for(const el of document.querySelectorAll('[data-i18n-'+attr+']'))el.setAttribute(attr,t(el.getAttribute('data-i18n-'+attr)));
}

if(globalThis.window)window.sitetillerTranslate=t;
