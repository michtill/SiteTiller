import test from 'node:test';import assert from 'node:assert/strict';
import {callModel} from '../src/providers.ts';import {withRules} from '../src/instructions.ts';
import {t,tm} from '../public/i18n.js';import {displayMessage} from '../public/messages.js';
import {languages,normalizeLocale,translate,translateMessage} from '../public/locales.js';
import {readFile} from 'node:fs/promises';
import {english} from '../public/translations.js';import {czech} from '../public/translations.cs.js';

test('dictionaries share English snake_case keys and matching parameters',()=>{
 assert.deepEqual(Object.keys(czech).sort(),Object.keys(english).sort());
 for(const [key,text] of Object.entries(english)){
  assert.match(key,/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  const tokens=value=>Array.from(value.matchAll(/\{([a-z][a-z0-9_]*)\}/g),m=>m[1]).sort();
  assert.deepEqual(tokens(czech[key]),tokens(text),key);
 }
});
test('technical keys translate labels and parameterized messages',()=>{
 assert.equal(t('current_draft',{},'en'),'Current draft');assert.equal(t('current_draft',{},'cs'),'Aktuální návrh');
 assert.equal(t('incorrect_password',{},'en'),'Incorrect password.');
 assert.equal(t('version_published',{version:'12.2'},'en'),'Version 12.2 was published.');
 assert.equal(t('version_published',{version:'12.2'},'cs'),'Verze 12.2 byla publikována.');
 assert.equal(t('provider_http_error',{provider:'openai',status:429},'en'),'Provider openai returned HTTP 429. Check the key, model, and credits.');
 assert.equal(t('unregistered_key',{},'en'),'unregistered_key');
});
test('older system messages remain readable without becoming dictionary keys',()=>{
 assert.equal(translateMessage('Nesprávné heslo.','en'),'Incorrect password.');
 assert.equal(translateMessage('Verze 12.2 byla publikována.','en'),'Version 12.2 was published.');
 assert.equal(translateMessage('Verze 12.2 byla publikována.','cs'),'Verze 12.2 byla publikována.');
 assert.equal(translateMessage('  Aktuální návrh  ','en'),'  Current draft  ');
 assert.equal(translateMessage('Make the hero darker','en'),'Make the hero darker');
});
test('provider preserves the original request as the language authority',async()=>{
 let sent;await callModel({provider:'openai',model:'fixture',key:'fake'},withRules('ui','Implement the task'),{originalRequest:'Ztmav pozadí.',task:'Make the background darker'},async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:'{"summary":"Hotovo"}'}]}]}));});
 assert.match(sent.instructions,/language of originalRequest/);assert.doesNotMatch(sent.instructions,/MUST be Czech|text in Czech/);assert.equal(JSON.parse(sent.input).originalRequest,'Ztmav pozadí.');
});
test('English is the default for missing and unsupported locales',()=>{
 assert.equal(normalizeLocale(undefined),'en');assert.equal(normalizeLocale('unknown'),'en');
 assert.equal(normalizeLocale('cs'),'cs');assert.equal(translate('current_draft'),'Current draft');
 assert.equal(translate('incorrect_password','unknown'),'Incorrect password.');
});
test('English works when Czech is not registered',()=>{
 const previous=languages.cs;delete languages.cs;
 try{assert.equal(normalizeLocale('cs'),'en');assert.equal(translate('current_draft'),'Current draft');assert.equal(translate('version_published','en',{version:'12.2'}),'Version 12.2 was published.');}finally{languages.cs=previous;}
});
test('a registered dictionary supports parameters and English fallback',()=>{
 languages.de={name:'Deutsch',dateLocale:'de-DE',messages:{current_draft:'Aktueller Entwurf',version_published:'Version {version} wurde veröffentlicht.'}};
 try{assert.equal(normalizeLocale('de'),'de');assert.equal(translate('current_draft','de'),'Aktueller Entwurf');assert.equal(translate('version_published','de',{version:'12.2'}),'Version 12.2 wurde veröffentlicht.');assert.equal(translate('incorrect_password','de'),'Incorrect password.');}finally{delete languages.de;}
});
test('interface language never translates model replies or blocking explanations',()=>{
 assert.equal(displayMessage({stage:'build',status:'completed',model:'fixture',message:'Upravuji web.'},v=>tm(v,'en')),'Upravuji web.');
 assert.equal(displayMessage({stage:'build',status:'running',message:'Upravuji web.'},v=>tm(v,'en')),'Editing the website.');
 const explanation='No real photograph was supplied, and photo search or retrieval is not available.';
 assert.equal(displayMessage({stage:'failed',agentResponse:true,message:explanation},v=>tm(v,'cs')),explanation);
});

test('interface calls and marked HTML reference existing technical keys',async()=>{
 for(const file of ['app.js','presentation.js']){
  const source=await readFile(new URL('../public/'+file,import.meta.url),'utf8');
  for(const match of source.matchAll(/\bt\('([^']+)'/g))assert.ok(Object.hasOwn(english,match[1]),file+': '+match[1]);
 }
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 for(const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g))assert.ok(Object.hasOwn(english,match[1]),match[1]);
});
