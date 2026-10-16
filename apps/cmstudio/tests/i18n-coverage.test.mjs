import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { baseParse, parserOptions } from '@vue/compiler-dom';
import { dictionaries, translateMessage } from '../../../packages/i18n/index.mjs';
const { en } = dictionaries;
test('I18-01: product templates and literal translation keys have complete English coverage', () => {
  const q = String.fromCharCode(96);
  for (const file of ['editor/main.ts', 'editor/architect.ts', '../../packages/ui/studio-switcher.ts']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8'),
      start = source.indexOf(q, source.indexOf('const template=')) + 1,
      end = source.indexOf(q + ';', start),
      root = baseParse(source.slice(start, end), parserOptions);
    function visit(node) {
      if (node.type === 2)
        assert.equal(
          /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(node.content),
          false,
          file + ': untranslated static product text ' + node.content,
        );
      for (const prop of node.props || [])
        if (prop.type === 6 && ['aria-label', 'placeholder', 'title', 'alt'].includes(prop.name))
          assert.equal(
            /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(prop.value?.content || ''),
            false,
            file + ': untranslated attribute',
          );
      for (const child of node.children || []) visit(child);
    }
    visit(root);
    const script = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function keys(n) {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 't' &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0])
      )
        assert.equal(
          Object.hasOwn(en, n.arguments[0].text),
          true,
          file + ': missing dictionary key ' + n.arguments[0].text,
        );
      ts.forEachChild(n, keys);
    }
    keys(script);
  }
});
test('I18-01: all statically exposed backend errors have an English UI wrapper', () => {
  const files = [
    'store',
    'structure',
    'server',
    'settings',
    'publication',
    'generated-values',
    'file-upload',
    'media-delete',
    'design-content',
    'design-structure',
    'design-restore',
    'discard-changes',
    'working-transaction',
  ];
  for (const file of files) {
    const source = readFileSync(new URL('../server/' + file + '.ts', import.meta.url), 'utf8'),
      root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(n) {
      if (
        ts.isNewExpression(n) &&
        n.expression.getText(root) === 'Problem' &&
        n.arguments?.[1] &&
        ts.isStringLiteral(n.arguments[1])
      )
        assert.notEqual(
          translateMessage(n.arguments[1].text, 'en'),
          n.arguments[1].text,
          file + ': untranslated error ' + n.arguments[1].text,
        );
      ts.forEachChild(n, visit);
    }
    visit(root);
  }
});
