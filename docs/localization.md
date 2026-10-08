# Adding an interface language

English is the installation default and the fallback for missing translations.
An existing browser's saved language still takes precedence. The interface
language does not translate website content or historic AI replies; agents follow
the original request's language.

1. Create a JavaScript dictionary in `public/`, for example `translations.de.js`:

   ```js
   export const german={
     current_draft:'Aktueller Entwurf',
     version_published:'Version {version} wurde veröffentlicht.'
   };
   ```

2. Import it in `public/locales.js` and add one entry to `languages`:

   ```js
   de:{name:'Deutsch',dateLocale:'de-DE',messages:german}
   ```

   Use a valid language code. The native `name` appears in Settings, and
   `dateLocale` controls date formatting. Dictionary keys are stable English
   technical codes in lowercase snake_case, such as `current_draft`. Use
   `public/translations.js` as the English reference; `translations.cs.js` uses
   the same keys for Czech. Preserve whitespace in prefix/suffix values.
   Dynamic messages use named parameters such as `{version}`, `{provider}` and
   `{status}`. Missing entries fall back to English, then to the unchanged key.

3. Set `SITETILLER_UI_LANGUAGE=de` if this should be the installation default,
   then rebuild/restart the studio. The server and Settings picker both use the
   registry; no additional language-specific conditions are needed.

4. Run the localization tests and check the interface in a browser for text
   overflow, translated labels, dates, and language switching.

Use `t('current_draft')` in interface JavaScript, or
`t('version_published', {version: '12.2'})` for parameters. Static HTML marks text
with `data-i18n="current_draft"`, and attributes with, for example,
`data-i18n-placeholder="prompt_placeholder"`. Keep English text in HTML as the initial fallback. Translation
updates only these marked elements, never arbitrary document or website text.

`tm()` / `translateMessage()` are compatibility adapters for existing server
messages and persisted system history. They recognize older Czech messages and
select technical keys; new interface labels must use `t()` and technical keys.
Agent replies and user content bypass this compatibility translation.

The browser stores its choice under `sitetiller-language`. Unknown language codes
fall back to English. Switching languages reloads the editor and preserves unsent
prompt text and completed uploaded attachments. Right-to-left languages also need
direction and layout support; a dictionary alone does not provide that.
