import { createApp } from 'vue';
import App from './app.ts';
import '../../../packages/ui/confirm-dialog.css';
import '../../../packages/ui/studio-switcher.css';
import { t, locale } from './i18n.ts';
import { s, start, notice, openSettingsDialog, onOpenSettings } from './studio.ts';
import { usePreviewModule } from './studio.ts';
import * as preview from './preview.ts';
usePreviewModule(preview);
document.documentElement.lang = locale;
createApp(App)
  .provide('translate', (key: string) => t(key))
  .mount('#app');
onOpenSettings(() => openSettingsDialog(true));
// An unsent request and its attachments survive a reload of the studio.
try {
  const attachments = sessionStorage.getItem('sitetiller-unsent-attachments');
  if (attachments) {
    s.attachments = JSON.parse(attachments);
    sessionStorage.removeItem('sitetiller-unsent-attachments');
  }
  const unsent = sessionStorage.getItem('sitetiller-unsent-prompt');
  if (unsent !== null) {
    s.prompt = unsent;
    sessionStorage.removeItem('sitetiller-unsent-prompt');
  }
} catch {}
window.addEventListener('beforeunload', () => {
  try {
    sessionStorage.setItem('sitetiller-unsent-prompt', s.prompt);
    sessionStorage.setItem('sitetiller-unsent-attachments', JSON.stringify(s.attachments));
  } catch {}
});
start().catch((e) => notice(e.message));
