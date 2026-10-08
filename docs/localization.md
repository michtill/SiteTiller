# Adding an interface language

English is the installation default and the fallback for missing translations.
An existing browser's saved language still takes precedence. The interface
language does not translate website content or historic AI replies; agents follow
the original request's language.

1. Create a JavaScript dictionary in `public/`, for example `translations.de.js`:

   ```js
   export const german={
     'Aktuální návrh':'Aktueller Entwurf',
     'Verze $1 byla publikována.':'Version $1 wurde veröffentlicht.'
   };
   ```

2. Import it in `public/locales.js` and add one entry to `languages`:

   ```js
   de:{name:'Deutsch',dateLocale:'de-DE',messages:german}
   ```

   Use a valid language code. The native `name` appears in Settings, and
   `dateLocale` controls date formatting. Dictionary keys are the exact Czech
   source strings used by the existing interface; use `public/translations.js`
   as the complete English reference. Preserve whitespace in prefix/suffix keys.
   Dynamic template keys use `$1`, `$2`, etc. as shown in that dictionary.
   Missing entries fall back to English, then to the unchanged source text.

3. Set `SITETILLER_UI_LANGUAGE=de` if this should be the installation default,
   then rebuild/restart the studio. The server and Settings picker both use the
   registry; no additional language-specific conditions are needed.

4. Run the localization tests and check the interface in a browser for text
   overflow, translated labels, dates, and language switching. For a new dynamic
   message shape, add its source pattern/template to `dynamicMessages` in
   `public/locales.js` and its translations to the dictionaries.

The browser stores its choice under `sitetiller-language`. Unknown language codes
fall back to English. Switching languages reloads the editor and preserves unsent
prompt text and completed uploaded attachments. Right-to-left languages also need
direction and layout support; a dictionary alone does not provide that.
