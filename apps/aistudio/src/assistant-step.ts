import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from './project.ts';
import { Problem } from './problem.ts';
import { safeSitePath } from './core.ts';
import { binaryAsset } from './images.ts';
import { staticChecks, browserChecks, checkLevel } from './checks.ts';
import { addRequest } from './journal.ts';
// A step written by an AI assistant over MCP (documentation 2.8): website files only, never the frozen content in
// site/cms/. The same technical checks as a loaded website; in warn-only mode a failed check becomes a warning.
function sitePath(root: string, name: unknown) {
  if (typeof name !== 'string' || name.startsWith('site/cms/'))
    throw new Problem(422, 'Zapisovat lze jen soubory webu (site/, mimo site/cms/): ' + String(name));
  try {
    return safeSitePath(root, name);
  } catch (e: any) {
    throw new Problem(422, e.message + ' ' + name);
  }
}
export async function assistantStep(project: Project, config: any, input: any, check = browserChecks) {
  const assistant = typeof input.assistant === 'string' ? input.assistant.trim() : '',
    summary = typeof input.summary === 'string' ? input.summary.trim() : '',
    files = Array.isArray(input.files) ? input.files : [],
    remove = Array.isArray(input.remove) ? input.remove : [];
  if (!assistant || assistant.length > 60) throw new Problem(422, 'Chybí jméno asistenta.');
  if (!summary || summary.length > 2000) throw new Problem(422, 'Shrnutí změny musí mít 1–2000 znaků.');
  if (!files.length && !remove.length) throw new Problem(422, 'Změna neobsahuje žádný soubor.');
  if (files.length + remove.length > 200) throw new Problem(422, 'Jedna změna smí obsahovat nejvýše 200 souborů.');
  const baseCommit = await project.head();
  if (input.expectedHead && input.expectedHead !== baseCommit)
    throw new Problem(409, 'Návrh se mezitím změnil. Načtěte přehled znovu.');
  const path = join(project.root, '..', 'assistant-' + randomUUID());
  await cp(project.root, path, { recursive: true });
  try {
    for (const file of files) {
      const target = sitePath(path, file?.path),
        binary = binaryAsset(file.path);
      if (binary ? typeof file.base64 !== 'string' : typeof file.text !== 'string')
        throw new Problem(
          422,
          (binary ? 'Binární soubor patří do pole base64: ' : 'Textový soubor patří do pole text: ') + file.path,
        );
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, binary ? Buffer.from(file.base64, 'base64') : file.text);
    }
    for (const name of remove) await rm(sitePath(path, name), { force: true });
    const draft = new Project(path),
      snapshot = await draft.files();
    // MCP limits (documentation 2.8): strict stops the step, key writes it with warnings, none checks nothing.
    const level = checkLevel(input.checks),
      skipped = {
        passed: true,
        errors: [] as string[],
        checks: [],
        skipped: true,
        reason: 'Omezení MCP: Nekontrolovat.',
      },
      tests = level === 'none' ? skipped : staticChecks(snapshot),
      browser =
        level === 'none'
          ? skipped
          : tests.passed
            ? await check(path, snapshot)
            : {
                passed: false,
                errors: [] as string[],
                checks: [],
                skipped: true,
                reason: 'Statická kontrola neprošla.',
              },
      errors = [...tests.errors, ...browser.errors];
    if (errors.length && level === 'strict') throw new Problem(422, 'Změna neprošla kontrolou: ' + errors.join('; '));
    await draft.git(['add', '-A', 'site']);
    if (!(await draft.git(['status', '--porcelain', 'site']))) throw new Problem(422, 'Změna nic nezměnila.');
    await draft.git(['commit', '-m', 'Asistent (' + assistant + '): ' + summary.replace(/\s+/g, ' ').slice(0, 100)]);
    const commit = await draft.head();
    if ((await project.head()) !== baseCommit) throw new Problem(409, 'Návrh se mezitím změnil.');
    await project.git(['fetch', path, 'main']);
    await project.git(['merge', '--ff-only', 'FETCH_HEAD']);
    const written = [...files.map((f: any) => f.path), ...remove.map((p: string) => p + ' (smazáno)')];
    return addRequest(config, {
      id: randomUUID(),
      prompt: summary,
      assistant,
      createdAt: new Date().toISOString(),
      status: 'ready',
      commit,
      scope: 'edit',
      baseCommit,
      memory: { summary: 'Asistent ' + assistant + ' změnil soubory: ' + written.join(', ') },
      tests: {
        passed: !errors.length,
        level,
        static: tests,
        browser: { ...browser, screenshots: undefined },
        warnings: errors.map((e) => 'Kontrola neprošla: ' + e),
      },
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
