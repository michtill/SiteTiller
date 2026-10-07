import test from 'node:test';import assert from 'node:assert/strict';import {compactProgress} from '../public/presentation.js';
test('last publication starts the draft conversation even when a retained newer editing step was created before publication',()=>{
 const groups=compactProgress([{jobId:'publication',kind:'publish',stage:'published',commit:'baseline',at:'2026-10-07T10:00:00Z',release:{number:1}}],null,false,{},[{id:'step',sequence:2,createdAt:'2026-10-07T09:00:00Z',prompt:'Retained draft',commit:'later',status:'ready'}]);
 assert.equal(groups[0].kind,'publish');assert.equal(groups[0].commit,'baseline');assert.equal(groups[1].request.id,'step');
});
