import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/providers.ts';
// A team role filled by Google Gemini (documentation 4.6). Invented key in Gemini's shape.
const key = 'AIzaFixtureGeminiKey0000000000000000000';
const slot = {
  provider: 'gemini' as const,
  key,
  model: 'gemini-3-pro-preview',
  reasoningEffort: 'high',
  highModel: 'gemini-3-pro-preview',
  lowModel: 'gemini-3-pro-preview',
};
const answer = (text: string, finishReason = 'STOP') =>
  Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
test('AI-34: a Gemini role calls generateContent with the key in its header and reads the JSON action', async () => {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const result = await callModel(
    slot,
    'Return JSON',
    { request: 'hello', _images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] },
    async (url, options: any) => {
      calls.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) });
      return answer('{"action":"read","paths":["site/index.html"]}');
    },
  );
  assert.deepEqual(result.value, { action: 'read', paths: ['site/index.html'] });
  assert.equal(result.provider, 'gemini');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(
    call.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
  );
  // The key only in its header, never in the address or the body.
  assert.equal(call.headers.get('x-goog-api-key'), key);
  assert.ok(!call.url.includes(key) && !JSON.stringify(call.body).includes(key));
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(call.body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.match(call.body.systemInstruction.parts[0].text, /Return only valid JSON/);
  assert.deepEqual(call.body.contents[0].parts[1], { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } });
  // An older model decides its thinking itself.
  await callModel({ ...slot, model: 'gemini-2.5-pro' }, 'JSON', {}, async (_url, options: any) => {
    assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig, undefined);
    return answer('{"action":"implement","files":[]}');
  });
});
test('AI-34: a truncated Gemini answer is asked again as a smaller step', async () => {
  const bodies: any[] = [];
  const result = await callModel(slot, 'JSON', {}, async (_url, options: any) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1 ? answer('{"action":"impl', 'MAX_TOKENS') : answer('{"action":"stage","files":[]}');
  });
  assert.equal(result.value.action, 'stage');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].systemInstruction.parts[0].text, /token limit/);
});
test('AI-34: an answer blocked by Google is an exact error without any of its content', async () => {
  for (const blocked of [
    Response.json({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'secret answer' }] } }] }),
    Response.json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
  ])
    await assert.rejects(
      callModel(slot, 'JSON', {}, async () => blocked),
      (error: any) =>
        /Google Gemini odpověď zablokoval \((SAFETY|PROHIBITED_CONTENT)\)/.test(error.message) &&
        !error.message.includes('secret answer'),
    );
});
