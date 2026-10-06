import test from 'node:test';import assert from 'node:assert/strict';import {withRules,projectRules} from '../src/instructions.ts';import {editImage} from '../src/image-editor.ts';
test('every capability receives only its own bounded instructions',()=>{
 for(const role of Object.keys(projectRules.roles) as (keyof typeof projectRules.roles)[]){const prompt=withRules(role,'Original task');assert.ok(prompt.startsWith('Original task'));const rules=JSON.parse(prompt.split('\n').at(-1)!);assert.deepEqual(rules.common,projectRules.common);assert.deepEqual(rules.capabilities,projectRules.capabilities);assert.deepEqual(Object.keys(rules.roles),[role]);}
});
test('explicit PNG output requests PNG encoding and omits incompatible lossy compression',async()=>{
 const source='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';const result='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
 const image=await editImage('fake','gpt-image-1.5',{data:source,mime:'image/png'},'Retouch',async(_url:any,options:any)=>{assert.equal(options.body.get('output_format'),'png');assert.equal(options.body.has('output_compression'),false);assert.ok(options.body.get('prompt').includes('Authoritative project and role rules'));return new Response(JSON.stringify({data:[{b64_json:result}]}));},{format:'png'});assert.equal(image.mime,'image/png');
});
