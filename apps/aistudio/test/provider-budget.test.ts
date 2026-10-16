import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/providers.ts';
const slot = {
  provider: 'anthropic',
  key: 'test',
  model: 'claude-sonnet-5-5',
  highModel: 'test',
  lowModel: 'test',
  reasoningEffort: 'high',
} as const;
test('AI-24: Truncated Claude output retries once with lower reasoning and bounded stages', async () => {
  const bodies: any[] = [];
  const fetcher = async (url: any, options: any) => {
    bodies.push(JSON.parse(options.body));
    return new Response(
      JSON.stringify(
        bodies.length === 1
          ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"action":"implement","files":[' }] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"action":"stage","files":[]}' }] },
      ),
      { status: 200 },
    );
  };
  const result = await callModel(slot, 'Return JSON', { manifest: {}, originalRequest: 'Navrhni web' }, fetcher as any);
  assert.equal(result.value.action, 'stage');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 32000);
  assert.equal(bodies[1].output_config.effort, 'low');
  assert.match(bodies[1].system, /bounded stage/);
});
test('AI-24: Repeated output exhaustion reports token limit rather than invalid JSON', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [] }), { status: 200 });
  };
  await assert.rejects(callModel(slot, 'JSON', { manifest: {} }, fetcher as any), /vyčerpal výstupní limit/);
  assert.equal(calls, 2);
});
test('AI-24: Malformed completed output still uses JSON repair', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: calls === 1 ? 'bad' : '{"action":"read"}' }],
      }),
      { status: 200 },
    );
  };
  assert.equal((await callModel(slot, 'JSON', {}, fetcher as any)).value.action, 'read');
  assert.equal(calls, 2);
});
