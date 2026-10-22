import { parseJSON, type Slot } from './core.ts';
import { diagnosticFetch } from './diagnostics.ts';
import { throwIfStopped } from './run-control.ts';
import { providerName } from '../../../packages/providers/index.mjs';
import { translate } from '../../../packages/i18n/index.mjs';
// A refused call says who refused it and what the status means; the provider's body is never shown.
export function providerHttpError(slot: { provider: string; model: string }, status: number) {
  const key =
    status === 429
      ? 'provider_http_429'
      : status === 401 || status === 403
        ? 'provider_http_auth'
        : status === 404
          ? 'provider_http_404'
          : status >= 500
            ? 'provider_http_5xx'
            : 'provider_http_error';
  return translate(key, 'cs', { provider: providerName(slot.provider), model: slot.model, status });
}

export async function callModel(
  slot: Slot & { model: string; reasoningEffort?: string; textOnlyFinal?: boolean },
  instruction: string,
  input: unknown,
  fetcher = fetch,
  repair = false,
): Promise<any> {
  instruction +=
    '\nUse efficient structured internal communication. Preserve user content unless explicitly changed by the content task. Return no reasoning transcript.';
  const { _images: images = [], ...plain } = input as any;
  const prompt = JSON.stringify(plain);
  const openInput = images.length
    ? [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            ...images.map((i: any) => ({ type: 'input_image', image_url: 'data:' + i.mime + ';base64,' + i.data })),
          ],
        },
      ]
    : prompt;
  const geminiParts = [
    { text: prompt },
    ...images.map((i: any) => ({ inline_data: { mime_type: i.mime, data: i.data } })),
  ];
  const claudeInput = images.length
    ? [
        ...images.map((i: any) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
        { type: 'text', text: prompt },
      ]
    : prompt;
  if ((plain as any).manifest)
    instruction +=
      '\nFor large implementations return bounded action="stage" steps and prefer exact textEdits replace/extract for existing large files. 12000 characters is response sizing guidance, NOT a file size or eligibility limit; the separate text file limit is 300000 bytes. Do not repeat unchanged files; finish with implement. Keep enough output budget to close valid JSON.';
  throwIfStopped();
  const controller = AbortSignal.timeout(180000);
  const response =
    slot.provider === 'openai'
      ? await diagnosticFetch(fetcher, 'https://api.openai.com/v1/responses', {
          method: 'POST',
          signal: controller,
          headers: { Authorization: `Bearer ${slot.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: slot.model,
            ...(/^gpt-6(?:\.|-)/.test(slot.model) ? { reasoning: { effort: slot.reasoningEffort || 'low' } } : {}),
            instructions: instruction + '\nReturn only valid JSON.',
            input: openInput,
            max_output_tokens: slot.textOnlyFinal ? 4096 : repair ? 32000 : 16000,
            store: false,
          }),
        })
      : slot.provider === 'gemini'
        ? // Gemini (documentation 4.6): the key in its header, never in the address; JSON by responseMimeType.
          await diagnosticFetch(
            fetcher,
            'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(slot.model) +
              ':generateContent',
            {
              method: 'POST',
              signal: controller,
              headers: { 'x-goog-api-key': slot.key, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: instruction + '\nReturn only valid JSON.' }] },
                contents: [{ role: 'user', parts: geminiParts }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  maxOutputTokens: slot.textOnlyFinal ? 4096 : repair ? 32000 : 16000,
                  // Gemini 3 and later take a thinking level; older models decide their thinking themselves.
                  ...(/^gemini-(?:[3-9]|[1-9][0-9])/.test(slot.model)
                    ? { thinkingConfig: { thinkingLevel: slot.reasoningEffort === 'high' ? 'high' : 'low' } }
                    : {}),
                },
              }),
            },
          )
        : await diagnosticFetch(fetcher, 'https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: controller,
            headers: { 'x-api-key': slot.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: slot.model,
              ...(/^claude-(?:sonnet|opus)-5(?:-|$)/.test(slot.model) && slot.reasoningEffort
                ? { thinking: { type: 'adaptive' }, output_config: { effort: slot.reasoningEffort } }
                : {}),
              max_tokens: slot.textOnlyFinal ? 4096 : 32000,
              system: instruction + '\nReturn only valid JSON.',
              messages: [{ role: 'user', content: claudeInput }],
            }),
          });
  // Never forward provider response bodies: they may echo confidential request data.
  if (!response.ok) throw new Error(providerHttpError(slot, response.status));
  const body: any = await response.json();
  const candidate = slot.provider === 'gemini' ? body.candidates?.[0] : null;
  // A Gemini answer blocked by Google is an exact error without any of its content.
  if (
    slot.provider === 'gemini' &&
    (body.promptFeedback?.blockReason ||
      ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'OTHER'].includes(candidate?.finishReason))
  )
    throw new Error(
      'Google Gemini odpověď zablokoval (' +
        (body.promptFeedback?.blockReason || candidate.finishReason) +
        '). Návrh zůstal zachován.',
    );
  const text =
    slot.provider === 'gemini'
      ? (candidate?.content?.parts || [])
          .filter((p: any) => typeof p.text === 'string' && !p.thought)
          .map((p: any) => p.text)
          .join('\n')
      : slot.provider === 'openai'
        ? (body.output || [])
            .flatMap((item: any) =>
              (item.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text),
            )
            .join('\n')
        : (body.content || [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
  const truncated =
    slot.provider === 'gemini'
      ? candidate?.finishReason === 'MAX_TOKENS'
      : slot.provider === 'anthropic'
        ? body.stop_reason === 'max_tokens'
        : body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens';
  if (truncated) {
    if (repair || slot.textOnlyFinal)
      throw new Error(
        'Model opakovaně vyčerpal výstupní limit. Odpověď byla nedokončená; návrh zůstal zachován. Rozdělte zadání na menší kroky.',
      );
    return callModel(
      { ...slot, reasoningEffort: 'low' },
      instruction +
        '\nThe previous output hit its token limit. Return a small complete JSON response. For implementation return one bounded stage containing only the next necessary files; do not attempt the entire website in one response.',
      input,
      fetcher,
      true,
    );
  }
  try {
    const trimmed = text.trim(),
      start = trimmed.indexOf('{');
    if (
      trimmed.startsWith('<') ||
      /<\s*(?:invoke|function_calls|tool_call)\b/i.test(start < 0 ? trimmed : trimmed.slice(0, start))
    )
      throw Error('XML/tool wrappers are not JSON actions');
    return {
      value: parseJSON(text),
      usage: body.usage || body.usageMetadata || {},
      model: slot.model,
      provider: slot.provider,
    };
  } catch {
    if (repair || slot.textOnlyFinal)
      throw new Error('Model nevrátil platný JSON ani po opakování. Náhled zůstal zachován.');
    return callModel(
      slot,
      instruction +
        '\nThe previous response was invalid JSON. Produce a fresh complete response. Escape all newlines and quotes inside JSON strings; omit markdown fences, XML and <invoke> tool wrappers. This is a JSON action protocol, not a tool invocation. Return exactly one JSON object, for example {"action":"read","paths":["site/index.html"],"summary":"Reading current candidate"}.',
      input,
      fetcher,
      true,
    );
  }
}
