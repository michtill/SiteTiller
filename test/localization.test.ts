import test from 'node:test';import assert from 'node:assert/strict';import {callModel} from '../src/providers.ts';import {withRules} from '../src/instructions.ts';import {t} from '../public/i18n.js';
test('English interface translates fixed strings without changing arbitrary user content',()=>{assert.equal(t('Aktuální návrh','en'),'Current draft');assert.equal(t('Nesprávné heslo.','en'),'Incorrect password.');assert.equal(t('Verze 12.2 byla publikována.','en'),'Version 12.2 was published.');assert.equal(t('Make the hero darker','en'),'Make the hero darker');assert.equal(t('Aktuální návrh','cs'),'Aktuální návrh');});
test('provider preserves the original request as the language authority even for an English specialist task',async()=>{let sent:any;await callModel({provider:'openai',model:'fixture',key:'fake'} as any,withRules('ui','Implement the task'),{originalRequest:'Ztmav pozadí.',task:'Make the background darker'},async(_url:any,options:any)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:'{"summary":"Hotovo"}'}]}]}));});assert.match(sent.instructions,/language of originalRequest/);assert.doesNotMatch(sent.instructions,/MUST be Czech|text in Czech/);assert.equal(JSON.parse(sent.input).originalRequest,'Ztmav pozadí.');});

import {displayMessage} from '../public/messages.js';
import {languages,normalizeLocale,translate} from '../public/locales.js';
test('English is the default for missing and unsupported locales',()=>{
 assert.equal(normalizeLocale(undefined),'en');assert.equal(normalizeLocale('unknown'),'en');
 assert.equal(normalizeLocale('cs'),'cs');assert.equal(translate('Aktuální návrh'),'Current draft');
 assert.equal(translate('Nesprávné heslo.','unknown'),'Incorrect password.');
});
test('English works when Czech is not registered',()=>{
 const czech=languages.cs;delete languages.cs;
 try{
  assert.equal(normalizeLocale('cs'),'en');assert.equal(normalizeLocale(undefined),'en');
  assert.equal(translate('Aktuální návrh'),'Current draft');
  assert.equal(translate('Verze 12.2 byla publikována.'),'Version 12.2 was published.');
 }finally{languages.cs=czech;}
});
test('registering a dictionary supports static and dynamic messages with English fallback',()=>{
 languages.de={name:'Deutsch',dateLocale:'de-DE',messages:{'Aktuální návrh':'Aktueller Entwurf','Verze $1 byla publikována.':'Version $1 wurde veröffentlicht.'}};
 try{
  assert.equal(normalizeLocale('de'),'de');assert.equal(translate('Aktuální návrh','de'),'Aktueller Entwurf');
  assert.equal(translate('  Aktuální návrh  ','de'),'  Aktueller Entwurf  ');
  assert.equal(translate('Verze 12.2 byla publikována.','de'),'Version 12.2 wurde veröffentlicht.');
  assert.equal(translate('Nesprávné heslo.','de'),'Incorrect password.');
  assert.equal(translate('My website text','de'),'My website text');
 }finally{delete languages.de;}
});
test('interface language never translates a model reply or blocking explanation',()=>{assert.equal(displayMessage({stage:'build',status:'completed',model:'fixture',message:'Upravuji web.'},v=>t(v,'en')),'Upravuji web.');assert.equal(displayMessage({stage:'build',status:'running',message:'Upravuji web.'},v=>t(v,'en')),'Editing the website.');const explanation='No real photograph was supplied, and photo search or retrieval is not available.';assert.equal(displayMessage({stage:'failed',agentResponse:true,message:explanation},v=>t(v,'cs')),explanation);});
