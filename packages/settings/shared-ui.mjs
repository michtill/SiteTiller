import { readJson } from './index.mjs';
export const sharedLanguage = (value) => (value?.language === 'en' ? 'en' : 'cs');

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
