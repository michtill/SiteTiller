import test from 'node:test';import assert from 'node:assert/strict';import {assessCriteria} from '../src/criteria.ts';
const acceptance=[{id:'logo',category:'required',description:'Remove logo',basis:'Explicit user request'},{id:'webp',category:'preference',description:'Use WebP',basis:'Project preference'}];
function result(status='passed',category='required'){return {passed:false,criteria:[{id:'logo',category,status,summary:'Logo assessment'},{id:'webp',category:'preference',status:'failed',summary:'Used PNG'}],findings:[]};}
test('preference deviation does not block a completed user request',()=>{const r=assessCriteria(acceptance,result());assert.equal(r.passed,true);assert.equal(r.warnings.length,1);});
test('demonstrated required failure blocks',()=>assert.equal(assessCriteria(acceptance,result('failed')).passed,false));
test('unverified remains disclosed and does not become a fake failure',()=>{const r=assessCriteria(acceptance,result('unverified'));assert.equal(r.passed,true);assert.equal(r.warnings.length,2);});
test('test model cannot downgrade required criteria or omit checks',()=>{assert.equal(assessCriteria(acceptance,result('failed','preference')).passed,false);assert.equal(assessCriteria(acceptance,{criteria:[],findings:[]}).passed,false);});
test('independent functional defect blocks even when criteria pass',()=>{const r=result();r.findings=[{category:'required',status:'failed',summary:'Broken image reference'}];assert.equal(assessCriteria(acceptance,r).passed,false);});
test('legacy checks remain strict and malformed structured checks fail closed',()=>{assert.equal(assessCriteria(['Legacy'],{passed:false}).passed,false);assert.equal(assessCriteria(acceptance,{criteria:[],findings:[{}]}).passed,false);});
