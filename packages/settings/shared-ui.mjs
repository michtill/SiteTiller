import { readJson } from './index.mjs';
export const sharedLanguage = (value) => (value?.language === 'en' ? 'en' : 'cs');
// The colour mode of the whole editor (documentation 2.4): light or dark. The former environment colours read as
// light, the former black one as dark.
export const colourMode = (value) => (value?.theme === 'dark' || value?.theme === 'black' ? 'dark' : 'light');

const sharedSaves = new Map();
export async function withSharedSettingsSave(path, task) {
  const prior = sharedSaves.get(path) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    queued = prior.then(() => gate);
  sharedSaves.set(path, queued);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (sharedSaves.get(path) === queued) sharedSaves.delete(path);
  }
}
