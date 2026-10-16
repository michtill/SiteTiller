import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/providers.ts';
const slot = {
  provider: 'anthropic',
  key: 'fixture',
  model: 'claude-sonnet-5-5',
  highModel: 'fixture',
  lowModel: 'fixture',
};
test('AI-24: XML/invoke including a JSON action wrapper repairs once and never interprets wrapper as action', async () => {
  for (const invalid of [
    '<invoke name="edit">{"action":"implement","files":[]}</invoke>',
    'I will invoke <invoke>{"action":"implement"}</invoke>',
    '<function_calls>not JSON</function_calls>',
  ]) {
    const bodies = [];
    const result = await callModel(slot, 'Return JSON', { manifest: {} }, async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: bodies.length === 1 ? invalid : '{"action":"read","paths":["site/index.html"]}' },
        ],
      });
    });
    assert.equal(result.value.action, 'read');
    assert.equal(bodies.length, 2);
    assert.match(bodies[0].system, /12000.*NOT.*file size/);
    assert.match(bodies[0].system, /300000 bytes/);
    assert.match(bodies[1].system, /XML.*invoke.*JSON action protocol/);
  }
});
test('AI-24: two invalid wrapper responses terminate without actions', async () => {
  let calls = 0;
  await assert.rejects(
    callModel(slot, 'JSON', {}, async () => {
      calls++;
      return Response.json({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<invoke>{"action":"implement"}</invoke>' }],
      });
    }),
    /platný JSON/,
  );
  assert.equal(calls, 2);
});
test('AI-24: valid JSON containing XML as document data remains valid', async () => {
  const value = {
    action: 'implement',
    files: [{ path: 'site/docs.txt', content: '<invoke>document example</invoke>' }],
  };
  const result = await callModel(slot, 'JSON', {}, async () =>
    Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] }),
  );
  assert.deepEqual(result.value, value);
});
