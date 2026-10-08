import { parseJSON, type Slot } from './core.ts';
import {diagnosticFetch} from './diagnostics.ts';

export async function callModel(slot: Slot & { model: string;reasoningEffort?:string }, instruction: string, input: unknown, fetcher = fetch, repair = false): Promise<any> {
  instruction += '\nUse concise English for machine-facing fields. Write ALL human-facing text in the language of originalRequest (or the original user request), including summary, blockedReason, requiredFixes, warnings and requests for missing information. Ignore the language of internal delegated tasks. For a short ambiguous follow-up, preserve the language of the recent user conversation. Return no reasoning transcript.';
  const {_images:images=[],...plain}=input as any;const prompt = JSON.stringify(plain);
  const openInput=images.length?[{role:'user',content:[{type:'input_text',text:prompt},...images.map((i:any)=>({type:'input_image',image_url:'data:'+i.mime+';base64,'+i.data}))]}]:prompt;
  const claudeInput=images.length?[...images.map((i:any)=>({type:'image',source:{type:'base64',media_type:i.mime,data:i.data}})),{type:'text',text:prompt}]:prompt;
  const controller = AbortSignal.timeout(180000);
  const response = slot.provider === 'openai'
    ? await diagnosticFetch(fetcher,'https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller,
      headers: {'Authorization': `Bearer ${slot.key}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ model: slot.model, ...(/^gpt-6(?:\.|-)/.test(slot.model)?{reasoning:{effort:slot.reasoningEffort||'low'}}:{}), instructions: instruction + '\nReturn only valid JSON.', input: openInput, max_output_tokens: 16000, store: false })
    })
    : await diagnosticFetch(fetcher,'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller,
      headers: {'x-api-key': slot.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
      body: JSON.stringify({model: slot.model, ...(/^claude-(?:sonnet|opus)-5(?:-|$)/.test(slot.model)&&slot.reasoningEffort?{thinking:{type:'adaptive'},output_config:{effort:slot.reasoningEffort}}:{}), max_tokens: 16000, system: instruction + '\nReturn only valid JSON.', messages: [{role:'user',content:claudeInput}]})
    });
  // Never forward provider response bodies: they may echo confidential request data.
  if (!response.ok) throw new Error(`Poskytovatel ${slot.provider} vrátil HTTP ${response.status}. Ověř klíč, model a kredit.`);
  const body: any = await response.json();
  const text = slot.provider === 'openai'
    ? (body.output || []).flatMap((item: any) => (item.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text)).join('\n')
    : (body.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  try { return { value: parseJSON(text), usage: body.usage || {}, model: slot.model, provider: slot.provider }; }
  catch {
    if(repair)throw new Error('Model nevrátil platný JSON ani po opakování. Náhled zůstal zachován.');
    return callModel(slot,instruction+'\nThe previous response was invalid JSON. Produce a fresh complete response. Escape all newlines and quotes inside JSON strings; omit markdown fences.',input,fetcher,true);
  }
}
