import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {raster} from './images.ts';
import { resolve, relative, extname } from 'node:path';

export type Provider = 'openai' | 'anthropic';
export type Slot = {provider: Provider; key: string; highModel: string; lowModel: string};
export const defaults = {
  openai: { highModel: 'gpt-6.1-sol', lowModel: 'gpt-6-luna' },
  anthropic: { highModel: 'claude-sonnet-5-5', lowModel: 'claude-sonnet-5-5' }
};
export function roleSlot(slots: Slot[], role: 'design' | 'build' | 'review') {
  const configured = slots.filter(s => s.key);
  if (!configured.length) throw new Error('Nejdřív nastav alespoň jeden API klíč.');
  const slot = role === 'build' ? (configured[1] || configured[0]) : configured[0];
  return { ...slot, model: role === 'build' ? slot.lowModel : slot.highModel };
}
export function seal(value: string, key: Buffer) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
export function unseal(value: string, key: Buffer) {
  const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export function safeSitePath(root: string, name: string) {
  if (typeof name !== 'string' || !/^site\/[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(p => p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Nepovolená cesta souboru.');
  if (!['.html', '.css', '.js', '.svg', '.txt', '.json', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(name))) throw new Error('Nepovolený typ souboru.');
  const result = resolve(root, name), rel = relative(root, result);
  if (rel.startsWith('..') || !rel) throw new Error('Soubor je mimo projekt.');
  return result;
}
export function parseJSON(text: string) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch { throw new Error('Model nevrátil platný JSON. Změny nebyly publikovány.'); }
}
export function validateFiles(files: Record<string,string>) {
  const errors: string[] = [], html = files['site/index.html'];
  if (!html) return ['Chybí site/index.html.'];
  for (const [name, text] of Object.entries(files)) {
    safeSitePath('/project', name);
    if(raster(name))continue;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 300000) errors.push(`Příliš velký soubor: ${name}`);
    if (name.endsWith('.html')){
     if (!/<!doctype html>/i.test(text) || !/<html[\s>]/i.test(text) || !/<\/html>/i.test(text)) errors.push('Neúplný HTML dokument: '+name);
     if (!/<title>.+?<\/title>/s.test(text)) errors.push('Chybí název stránky: '+name);
     if (!/name=["']viewport["']/.test(text)) errors.push('Chybí responzivní viewport: '+name);
     for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const url = match[1]; if (/^(https?:|data:|mailto:|tel:|\/\/|#|\?)/i.test(url)) continue;
      let target:string;
      try{const resolved=new URL(url,'https://site.invalid/'+name.slice(5));if(resolved.protocol!=='https:'||resolved.hostname!=='site.invalid')throw Error();target=resolveSiteFile(decodeURIComponent(resolved.pathname),files);safeSitePath('/project',target);}catch{errors.push('Neplatný místní odkaz '+url+' ('+name+').');continue;}
      if (!files[target]) errors.push(`Chybí místní soubor ${url} (${name}).`);
    }
  }
  }
  return errors;
}
export function resolveSiteFile(pathname:string,files:Record<string,string>){
 const relative=pathname.replace(/^\/+/,'');
 const name='site/'+(relative||'index.html');
 if(Object.hasOwn(files,name))return name;
 const index=name.replace(/\/$/,'')+'/index.html';
 return Object.hasOwn(files,index)?index:name;
}
