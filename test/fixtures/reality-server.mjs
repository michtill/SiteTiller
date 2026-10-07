import {mock} from 'node:test';import {readFile} from 'node:fs/promises';
import * as web from '../../src/web-import.ts';
mock.module('../../src/web-import.ts',{namedExports:{...web,importWebsite:async()=>{
 let text='Live website';try{text=(await readFile(process.env.SITETILLER_REALITY_FIXTURE_DIR+'/live.txt','utf8')).trim();}catch{}
 return web.importWebsite('https://fixture.example/',async url=>({url,mime:'text/html',bytes:Buffer.from('<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>'+text+'</h1></body></html>')}));
}}});
await import('./provider-server.mjs');
