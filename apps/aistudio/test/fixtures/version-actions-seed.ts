import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from '../../src/project.ts';
import { captureCmsPublication } from '../../src/cms-publication.ts';
const data = process.env.SITETILLER_DATA_DIR!;
if (!data.includes('next-real-integration-')) throw Error('Fixture import only');
const project = new Project(join(data, 'project'));
await captureCmsPublication(project, process.env.SITETILLER_CMS_ROOT!);
const base = await project.head();
await project.write({ 'site/action-fixture.txt': 'First' });
const first = await project.commit('First action fixture');
await project.write({ 'site/action-fixture.txt': 'Last' });
const last = await project.commit('Last action fixture');
const path = join(data, 'config.json'),
  config = JSON.parse(await readFile(path, 'utf8'));
config.requests = [
  { id: 'fixture-first', sequence: 1, status: 'ready', commit: first, baseCommit: base, prompt: 'First' },
  { id: 'fixture-last', sequence: 2, status: 'ready', commit: last, baseCommit: first, prompt: 'Last' },
];
config.requestSequence = 2;
config.presentationHead = last;
await writeFile(path, JSON.stringify(config));
await writeFile(join(data, 'action-fixture.json'), JSON.stringify({ base, first, last }));
