import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedLanguage, t, localize } from '../editor/i18n.ts';
test('I18-01: shared language wins; absence is Czech; dynamic user labels are preserved', () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { documentElement: { dataset: { sharedLanguage: 'en' }, lang: 'cs' } };
    assert.equal(sharedLanguage(), 'en');
    assert.equal(t('saved'), 'Saved');
    assert.equal(
      localize('Identifikátor: hodnota "one" již existuje. Zadejte jiný jedinečný klíč.'),
      'Identifikátor: value "one" already exists. Enter a different unique key.',
    );
    assert.equal(
      localize('Kolekce „Moje alba“ obsahuje 2 záznamů a nelze ji odstranit.'),
      'Collection “Moje alba” contains 2 records and cannot be deleted.',
    );
    globalThis.document = { documentElement: { dataset: {}, lang: 'en' } };
    assert.equal(sharedLanguage(), 'cs');
    assert.equal(t('saved'), 'Uloženo');
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
