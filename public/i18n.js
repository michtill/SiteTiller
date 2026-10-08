import {languages,normalizeLocale,translate} from './locales.js';
export {normalizeLocale} from './locales.js';
let saved;try{saved=globalThis.localStorage?.getItem('sitetiller-language');}catch{}
export const locale=normalizeLocale(saved||globalThis.document?.documentElement.lang);
export const dateLocale=languages[locale].dateLocale||locale;
export function t(value,language=locale){return translate(value,language);}
export function populateLanguagePicker(select){select.replaceChildren();for(const [code,language] of Object.entries(languages)){const option=document.createElement('option');option.value=code;option.textContent=language.name;select.append(option);}select.value=locale;}
export function translateDocument(){if(!globalThis.document)return;document.documentElement.lang=locale;const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(!n.parentElement.closest('script,style'))n.textContent=t(n.textContent);}for(const el of document.querySelectorAll('[title],[aria-label],[placeholder]'))for(const attr of ['title','aria-label','placeholder'])if(el.hasAttribute(attr))el.setAttribute(attr,t(el.getAttribute(attr)));}
if(globalThis.window)window.sitetillerTranslate=t;
