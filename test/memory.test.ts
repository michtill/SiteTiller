import test from 'node:test';import assert from 'node:assert/strict';
import {changeMemory,recentConversation,searchConversation} from '../src/memory.ts';
const head='current-head';
test('memory records the changed element, property and values without copying the website',()=>{
 const original={'site/style.css':'.button{background:#555;color:white}.other{background:red}'},files={'site/style.css':'.button{background:#444;color:white}.other{background:red}'};
 const memory=changeMemory(original,files,'Tlačítko je tmavší.');
 assert.ok(memory.deltas.some(d=>d.selector==='.button'&&d.property==='background'&&d.before==='#555'&&d.after==='#444'));
 assert.deepEqual(memory.changedFiles,['site/style.css']);
 const context=recentConversation([{id:'one',sequence:1,prompt:'Ztmav tlačítko.',status:'ready',commit:'one',memory}],head);
 assert.equal(context.turns[0].request,'Ztmav tlačítko.');assert.equal(context.currentHead,head);assert.equal(context.turns[0].applied,true);
});
test('recent memory is bounded; targeted older history has no keys, raw files, images or model transcripts',()=>{
 const records=Array.from({length:20},(_,i)=>({id:String(i),sequence:i+1,prompt:i===0?'Ztmav starší tlačítko.':'Request '+i,status:'ready',commit:String(i),memory:{summary:'Change '+i},providers:{key:'must-not-leak'},progress:[{raw:'internal transcript'}],attachments:[{data:'base64-must-not-leak'}]}));
 const recent=recentConversation(records,head);assert.equal(recent.turns.length,6);assert.equal(recent.olderHistoryAvailable,true);
 const older=searchConversation(records,{query:'starší tlačítko'},head);assert.equal(older.turns[0].id,'0');assert.equal(older.turns[0].active,true);assert.ok(!JSON.stringify(older).includes('must-not-leak'));assert.ok(!JSON.stringify(older).includes('internal transcript'));
 assert.throws(()=>searchConversation(records,{},head));assert.throws(()=>searchConversation(records,{ids:['0',{}]},head));
});
test('a restore removes undone requests from current context and historical search marks them inactive',()=>{
 const records=[{id:'a',commit:'a',prompt:'Darken button',status:'ready'},{id:'b',commit:'b',prompt:'Lighten button',status:'ready'},{id:'restore',commit:'r',restoredFrom:'a',prompt:'Restore a',status:'ready'}];
 assert.deepEqual(recentConversation(records,'r').turns.map(t=>t.id),['a','restore']);
 assert.equal(searchConversation(records,{ids:['b']},'r').turns[0].active,false);
 assert.equal(recentConversation([...records,{id:'c',commit:'c',prompt:'A little more',status:'ready'}],'c').turns.at(-1)?.id,'c');
});
test('new-site creation starts a new semantic context, and restoring the old site recovers the old context',()=>{
 const records=[{id:'old',commit:'old',prompt:'Old owner colour',status:'ready'},{id:'new',commit:'new',scope:'create',prompt:'Create cafe',status:'ready'},{id:'tweak',commit:'tweak',prompt:'Darken cafe',status:'ready'}];
 assert.deepEqual(recentConversation(records,'tweak').turns.map(t=>t.id),['new','tweak']);
 assert.equal(recentConversation(records,'tweak').olderHistoryAvailable,true);
 const restored=[...records,{id:'restore',commit:'r',restoredFrom:'old',prompt:'Restore old site',status:'ready'}];
 assert.deepEqual(recentConversation(restored,'r').turns.map(t=>t.id),['old','restore']);
});
test('a failed create does not reset context or pretend its changes were applied',()=>{
 const context=recentConversation([{id:'old',status:'ready',commit:'old',prompt:'Darken button'},{id:'fail',status:'failed',mode:'create',prompt:'Create cafe',error:'Provider failed'}],head);
 assert.equal(context.turns.length,2);assert.equal(context.turns[1].applied,false);assert.equal(context.turns[1].summary,'Provider failed');
});
