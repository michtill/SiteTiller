// Components keep their markup in `const template = \`...\``; at build time it becomes a compiled render
// function, so the browser needs only the Vue runtime. `match` selects the files that may hold such a template;
// `compile` is @vue/compiler-dom's compile from the building app's toolchain.
export function templatePlugin(match, compile) {
  return {
    name: 'sitetiller-template',
    enforce: 'pre',
    transform(source, id) {
      if (!match.test(id.replaceAll('\\', '/'))) return;
      const found = source.match(/const template\s*=\s*`([\s\S]*?)`;/);
      if (!found) return;
      const rendered = compile(found[1], { mode: 'module', prefixIdentifiers: true }).code.replace(
        'export function render',
        'function render',
      );
      return source.replace(found[0], rendered).replace(/\{\s*template\s*,/, '{ render,');
    },
  };
}
