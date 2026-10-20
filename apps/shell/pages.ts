import { readFileSync } from 'node:fs';
// Vue's full build compiles the page templates on the server.
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { translate, translateMessage } from '../../packages/i18n/index.mjs';
// The Shell's own pages: sign-in, home, common settings and password change. They are Vue components
// rendered on the server, so the forms work as plain HTML forms; the look follows the Content editor.
const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');
const themes = ['green', 'blue', 'plum', 'graphite', 'sand', 'black', 'light'];
const Layout = {
  props: { site: String, back: String, backLabel: String },
  template: `<aside class="shell-band"><div class="eyebrow">SiteTiller</div><div class="shell-site"><span class="shell-dot" aria-hidden="true"></span>{{site}}</div><a v-if="back" class="shell-back" :href="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>{{backLabel}}</a></aside><main class="shell-main"><div class="shell-card"><slot/></div></main>`,
};
const pages: Record<string, string> = {
  login: `<Layout :site="site"><div class="eyebrow">{{t('sign_in_2')}}</div><h1>{{site}}</h1><p class="login-path">{{t('structure_content_presentation_with_ai')}}</p><p v-if="error" class="error" role="alert">{{error}}</p><form method="post" :action="action"><label>{{t('password')}}<span class="password-field"><input type="password" name="password" autocomplete="current-password" required autofocus><button type="button" class="show-password" hidden aria-pressed="false" :aria-label="t('show_password')" :title="t('show_password')" :data-show="t('show_password')" :data-hide="t('hide_password')"><svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></button></span></label><button>{{t('sign_in_3')}}</button></form></Layout>`,
  home: `<Layout :site="site"><div class="eyebrow">SiteTiller</div><h1>{{site}}</h1><a class="card" href="/content/">{{t('content_editor')}}</a><a class="card" href="/site/">{{t('ai_studio')}}</a><div class="links"><a href="/settings">{{t('common_settings')}}</a><a href="/site/?settings=ai">{{t('ai_settings')}}</a><a href="/password">{{t('password')}}</a><a href="/logout">{{t('sign_out')}}</a></div></Layout>`,
  password: `<Layout :site="site"><div class="eyebrow">SiteTiller</div><h1>{{t('change_password')}}</h1><p>{{t('shared_sign_in_for_content_editor_and')}}</p><p v-if="error" class="error" role="alert">{{error}}</p><form method="post" action="/password"><label>{{t('current_password')}}<span class="password-field"><input type="password" name="currentPassword" autocomplete="current-password" maxlength="256" required><button type="button" class="show-password" hidden aria-pressed="false" :aria-label="t('show_password')" :title="t('show_password')" :data-show="t('show_password')" :data-hide="t('hide_password')"><svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></button></span></label><label>{{t('new_password')}}<span class="password-field"><input type="password" name="newPassword" autocomplete="new-password" minlength="8" maxlength="256" required><button type="button" class="show-password" hidden aria-pressed="false" :aria-label="t('show_password')" :title="t('show_password')" :data-show="t('show_password')" :data-hide="t('hide_password')"><svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></button></span></label><label>{{t('confirm_new_password')}}<span class="password-field"><input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" maxlength="256" required><button type="button" class="show-password" hidden aria-pressed="false" :aria-label="t('show_password')" :title="t('show_password')" :data-show="t('show_password')" :data-hide="t('hide_password')"><svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></button></span></label><small>{{t('at_least_8_characters_all_sessions_will')}}</small><button>{{t('change_password')}}</button></form><p><a href="/content/">{{t('back_to_content_editor')}}</a></p></Layout>`,
  passwordChanged: `<Layout :site="site"><h1>{{t('password_changed')}}</h1><p>{{t('sign_in_with_the_new_password_previous')}}</p><a href="/login">{{t('sign_in_3')}}</a></Layout>`,
  settings: `<Layout :site="site" :back="returnTo" :back-label="t('back')"><h1>{{t('shared_settings')}}</h1><p v-if="error" class="error" role="alert">{{error}}</p><form method="post"><input type="hidden" name="returnTo" :value="returnTo"><input type="hidden" name="revision" :value="revision"><label>{{t('name')}}<input name="name" :value="fields.name" maxlength="200" required></label><label>{{t('environment_colors')}}<select required name="theme"><option v-if="!themes.includes(fields.theme)" value="" selected disabled>{{fields.theme}}</option><option v-for="theme in themes" :value="theme" :selected="theme===fields.theme">{{t(theme+'_2')}}</option></select></label><label>{{t('interface_language')}}<select required name="language"><option v-if="!['cs','en'].includes(fields.language)" value="" selected disabled>{{fields.language}}</option><option value="cs" :selected="fields.language==='cs'">Čeština</option><option value="en" :selected="fields.language==='en'">English</option></select></label><label>{{t('default_content_editing_mode')}}<select required name="contentDefault"><option v-if="!['draft','live'].includes(fields.contentDefault)" value="" selected disabled>{{fields.contentDefault}}</option><option value="draft" :selected="fields.contentDefault==='draft'">{{t('unpublished_editing')}}</option><option value="live" :selected="fields.contentDefault==='live'">{{t('live_editing')}}</option></select></label><label>{{t('existing_website_address')}}<input name="siteUrl" type="url" :value="fields.siteUrl||''" placeholder="https://example.com" maxlength="2000" aria-describedby="site-url-help"></label><small id="site-url-help">{{t('address_for_importing_an_existing_website_into')}}</small><template v-if="publicPreviewUrl"><input type="hidden" name="publicPreviewOffered" value="1"><label class="check"><input type="checkbox" name="publicPreview" :checked="fields.publicPreview" aria-describedby="public-preview-help"> {{t('public_draft_preview')}}</label><small id="public-preview-help">{{t('public_draft_preview_help')}} <a :href="publicPreviewUrl" target="_blank" rel="noopener">{{publicPreviewUrl}}</a></small></template><button>{{t('save_step')}}</button></form><div class="links"><a href="/password">{{t('change_password')}}</a><a href="/site/?settings=ai">{{t('ai_settings')}}</a></div></Layout>`,
};
// Renders one page; `props` are its values, the language and theme come from the shared settings.
export async function renderPage(
  page: string,
  props: Record<string, unknown>,
  { language = 'cs', theme = 'green', site = 'SiteTiller' }: { language?: string; theme?: string; site?: string } = {},
) {
  const t = (key: string, params?: Record<string, unknown>) => translate(key, language, params);
  const app = createSSRApp({
    template: pages[page],
    components: { Layout },
    setup: () => ({ t, themes, site, ...props }),
  });
  // The pages are not hydrated, so Vue's hydration markers are left out; user text is escaped and cannot contain them.
  const body = (await renderToString(app)).replace(/<!--(?:\[|\]|)-->/g, '');
  const safeTheme = themes.includes(theme) ? theme : 'green';
  return (
    '<!doctype html><html lang="' +
    language +
    '" data-shared-language="' +
    language +
    '" data-cms-theme="' +
    safeTheme +
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteTiller</title><style>' +
    css +
    '</style></head><body>' +
    body +
    // Common settings: a chosen environment colour shows at once (the form still works without scripts).
    "<script>document.querySelector('select[name=\"theme\"]')?.addEventListener('change',(e)=>{document.documentElement.dataset.cmsTheme=e.target.value})</script>" +
    // Password fields: Show / Hide switches the input between hidden and readable text.
    "<script>for(const b of document.querySelectorAll('.show-password')){const i=b.previousElementSibling;b.hidden=false;b.addEventListener('click',()=>{const show=i.type==='password';i.type=show?'text':'password';b.setAttribute('aria-label',show?b.dataset.hide:b.dataset.show);b.title=b.getAttribute('aria-label');b.setAttribute('aria-pressed',String(show));i.focus()})}</script>" +
    '</body></html>'
  );
}
// An error of the common settings in the interface language; unknown text keeps its detail.
export function settingsError(error: unknown, language: string) {
  const text = String(error || '');
  if (language !== 'en') return text;
  const translated = translateMessage(text, 'en');
  return translated !== text ? translated : translate('settings_could_not_be_saved_detail', 'en', { detail: text });
}
