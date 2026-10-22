// The AI providers the AI Studio team can use (documentation 4.6): one list for the AI Studio, the Shell and the
// network policy. Each has its API host and the path prefix the network policy allows (6.2).
export const providers = [
  { id: 'openai', name: 'OpenAI', host: 'api.openai.com', path: '/v1/' },
  { id: 'anthropic', name: 'Anthropic', host: 'api.anthropic.com', path: '/v1/' },
  { id: 'gemini', name: 'Google Gemini', host: 'generativelanguage.googleapis.com', path: '/v1beta/' },
];
export const providerIds = providers.map((p) => p.id);
export function providerName(id) {
  return providers.find((p) => p.id === id)?.name || id;
}
// One field for every key (documentation 2.4): the provider is told by the key's shape, never by trying the key with
// several providers (a secret key would reach companies it does not belong to). Anthropic first: its keys also
// start with "sk-". An OpenAI admin key manages the organization and cannot call models.
export function detectProvider(value) {
  const key = String(value || '').trim();
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return { provider: 'anthropic' };
  if (/^sk-admin-/.test(key)) return { problem: 'admin' };
  if (/^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/.test(key)) return { provider: 'openai' };
  // Gemini: the standard key "AIza…" and, since 2026, the auth key "AQ.…" that AI Studio creates; both go in the
  // x-goog-api-key header.
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(key) || /^AQ\.[0-9A-Za-z._-]{30,}$/.test(key)) return { provider: 'gemini' };
  return { problem: 'unknown' };
}
// What a model produces (documentation 4.6). Google's model list gives no output type (both text and image models
// list generateContent), so a Gemini model is told by its id and, as a second hint, by its description: image models
// are named "…image…" or "nano-banana…"; speech, audio, video, transcription, embedding and similar models are
// neither text nor image models. A model that is not clearly a text model is never offered for a text role.
const geminiNotText =
  /(image|nano-banana|embedding|tts|live|aqa|audio|robotics|computer-use|transcribe|omni|veo|lyria|imagen|translate)/i;
const notTextDescription =
  /\b(image generation|generates? images?|text-to-speech|speech generation|video generation|generates? videos?|embeddings?|transcription)\b/i;
export function geminiTextModel(id, description = '') {
  return /^gemini-/.test(id) && !geminiNotText.test(id) && !notTextDescription.test(String(description || ''));
}
// The image tools: OpenAI gpt-image-* or a Google Gemini image model.
export function imageModelProvider(id) {
  const model = String(id || '');
  if (/^gpt-image-[a-zA-Z0-9.-]+$/.test(model)) return 'openai';
  if (/^gemini-[a-zA-Z0-9.-]+$/.test(model) && /(image|nano-banana)/i.test(model)) return 'gemini';
  return null;
}
