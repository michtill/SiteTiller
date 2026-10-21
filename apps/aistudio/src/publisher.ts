import { publisherTransaction as drivePublisherTransaction } from './publisher-transaction.ts';
import { atomicJson } from '../../../packages/settings/index.mjs';
import { readApproval } from './approvals.ts';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { renderingPages } from './cms-render.ts';
import { formDefinitions } from './contact-forms.ts';
import { deploySite, prepareSite } from '../deploy/site-release.mjs';
import { productionSnapshot } from './production-snapshot.ts';
import { hostedSnapshot } from './hosted-snapshot.ts';
import { productionReleases, storeProductionRelease } from './production-history.ts';
import { assertHostingPolicy } from './hosting-policy-probe.ts';
import { staticChecks, keyChecks } from './checks.ts';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from './project.ts';
import { productionTarget, syncProductionMirror, pushProductionRefs, productionRemote } from './production-remote.ts';
import { publishStaticWebsite, websiteForeign } from './static-website.ts';
import { raster, binaryAsset } from './images.ts';
import { privateSiteFiles } from './site-policy.ts';
const exec = promisify(execFile),
  dataDirectory = process.env.SITETILLER_DATA_DIR || '/data',
  project = new Project(dataDirectory + '/project');
// history = the local production repository (or the mirror of a remote one), remote = where publications go.
const history = process.env.SITETILLER_PRODUCTION_GIT,
  remote = productionTarget();
if (!history || !remote || !process.env.SITETILLER_PUBLISH_TOKEN)
  throw new Error('Publisher requires a fixed Git target and token.');
// The mirror of a remote production Git is refreshed at start; failures are retried before each use.
await syncProductionMirror().catch((e) => console.error('Production Git not reachable: ' + (e.code || e.name)));
let busy = false,
  stage = '';
const journalDirectory = join(dataDirectory, 'publisher-transactions');
await mkdir(journalDirectory, { recursive: true });
const journalPath = (commit: string) => {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid transaction');
  return join(journalDirectory, commit + '.json');
};
async function journal(commit: string) {
  try {
    return JSON.parse(await readFile(journalPath(commit), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function finishRecord(record: any) {
  const { commit, deployedCommit, before } = record;
  if (!(await recordOps.probeCommitted(record))) throw Error('Publication target advanced; completion paused');
  const run = (args: string[]) => exec('git', args, { windowsHide: true, timeout: 120000, maxBuffer: 1000000 });
  if (process.env.SITETILLER_PRODUCTION_DIRECTORY) {
    stage = 'export';
    await deploySite(project, commit, process.env.SITETILLER_PRODUCTION_DIRECTORY);
  }
  // A previous push may have succeeded while its deploy hook failed. Retry the
  // existing, fixed production hook when Git already contains this exact SHA.
  if (record.committed && process.env.SITETILLER_RETRY_DEPLOY_HOOK === '1' && !productionRemote()) {
    stage = 'hook';
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'php',
        [join(history, 'hooks/post-receive')],
        { windowsHide: true, timeout: 45000, maxBuffer: 100000 },
        (error) => (error ? reject(Error('Deployment hook failed')) : resolve()),
      );
      child.stdin!.end(deployedCommit + ' ' + deployedCommit + ' refs/heads/main\n');
    });
  }
  const { stdout } = await run(['ls-remote', remote, 'refs/heads/main']);
  if (!stdout.startsWith(deployedCommit)) throw new Error('Remote commit mismatch');
  if (process.env.SITETILLER_PRODUCTION_URL) {
    stage = 'verify';
    const expectedFiles = await project.committedFiles(commit);
    let verified = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const checks = await Promise.all(
          // Private files are not served, so they are not expected on the website.
          Object.entries(expectedFiles)
            .filter(([name]) => !privateSiteFiles.has(name.slice(5)))
            .map(async ([name, content]) => {
              const url = new URL(
                name === 'site/index.html' ? './' : name.slice(5),
                process.env.SITETILLER_PRODUCTION_URL,
              );
              url.searchParams.set('sitetiller', commit);
              const response = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
              return (
                response.ok &&
                (binaryAsset(name)
                  ? Buffer.from(await response.arrayBuffer()).equals(await project.binary(commit, name))
                  : (await response.text()).trim() ===
                    (name.endsWith('.html')
                      ? (await (await import('./cms-render.ts')).renderCmsPage(name, expectedFiles, false)) || content
                      : content
                    ).trim())
              );
            }),
        );
        if (checks.every(Boolean)) {
          verified = true;
          break;
        }
      } catch {
        /* Deployment can briefly restart while the hook builds it. */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!verified) throw new Error('Git updated; production deployment not verified');
  }
  await syncProductionMirror();
  const records = await productionReleases(new Project(history));
  const intent = record.intent || {
    number: Math.max(0, ...records.map((r) => r.number)) + 1,
    description: '',
    previousCommit: records.at(-1)?.commit || before,
  };
  const release = await storeProductionRelease(
    new Project(history),
    { ...intent, previousCommit: records.find((r) => r.tag === intent.tag)?.previousCommit || before },
    deployedCommit,
    commit,
  );
  await pushProductionRefs(['refs/tags/' + release.tag]);
  // The hosted website follows every publication; a failure leaves the release valid and is retried next time.
  if (process.env.SITETILLER_PRODUCTION_DIRECTORY)
    await publishStaticWebsite({ force: record.overrideWebsite === true }).catch((e) =>
      console.error('Static website not written: ' + (e.code || e.name)),
    );
  return release;
}
const recordOps = {
  probeCommitted: async (record: any) =>
    (await exec('git', ['ls-remote', remote!, 'refs/heads/main'], { windowsHide: true, timeout: 30000 })).stdout.split(
      /\s/,
    )[0] === record.deployedCommit,
  prepare: async () => {},
  persist: async (record: any) => atomicJson(journalPath(record.commit), record),
  commit: async (record: any) => {
    throw Error('Cannot activate an uncommitted transaction through recovery');
  },
  finish: finishRecord,
};
let retryDelay = 2000;
async function replayTransactions() {
  if (busy) return;
  busy = true;
  try {
    for (const name of await readdir(journalDirectory)) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      const record = await journal(name.slice(0, -5));
      if (record.completed || !(await recordOps.probeCommitted(record))) continue;
      const outcome = await drivePublisherTransaction(record, recordOps);
      retryDelay = outcome.state === 'pending' ? Math.min(retryDelay * 2, 60000) : 2000;
    }
  } catch (e: any) {
    retryDelay = Math.min(retryDelay * 2, 60000);
    console.error('Publisher internal completion pending: ' + (e.code || e.name));
  } finally {
    busy = false;
  }
}
function scheduleReplay() {
  const timer = setTimeout(async () => {
    await replayTransactions();
    scheduleReplay();
  }, retryDelay);
  timer.unref();
}
scheduleReplay();

http
  .createServer(async (req, res) => {
    let publicWriteStarted = false;
    const json = (status: number, value: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      const received = Buffer.from(req.headers.authorization || ''),
        expected = Buffer.from('Bearer ' + process.env.SITETILLER_PUBLISH_TOKEN);
      if (received.length !== expected.length || !timingSafeEqual(received, expected))
        return json(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url?.startsWith('/publication-status?')) {
        const record = await journal(new URL(req.url, 'http://local').searchParams.get('commit') || '');
        return record
          ? json(200, {
              ok: record.completed === true,
              commit: record.commit,
              committed: record.committed || (await recordOps.probeCommitted(record)),
              pending: !record.completed,
              release: record.release,
            })
          : json(404, { error: 'Unknown publication' });
      }
      if (req.method === 'GET' && req.url === '/status')
        return json(200, {
          ok: true,
          busy,
          hostingPolicyOverride: !!process.env.SITETILLER_HOSTING_POLICY_URL,
          productionHostingConfigured: !!process.env.SITETILLER_PRODUCTION_URL,
        });
      if (req.method === 'GET' && req.url === '/snapshot') {
        if (busy) return json(409, { error: 'Počkej na dokončení publikování.' });
        if (!process.env.SITETILLER_PRODUCTION_URL)
          return json(501, { error: 'Čtení nasazeného webu není nastavené.' });
        busy = true;
        try {
          await syncProductionMirror();
          const snapshot = await hostedSnapshot(
            new Project(history),
            process.env.SITETILLER_PRODUCTION_URL,
            fetch,
            process.env.SITETILLER_SITE_URL || process.env.SITETILLER_PRODUCTION_URL,
          );
          return json(200, {
            ...snapshot,
            binary: Object.fromEntries(
              Object.entries(snapshot.binary).map(([path, bytes]) => [path, bytes.toString('base64')]),
            ),
          });
        } catch (e: any) {
          return json(502, { error: e.name === 'TimeoutError' ? 'Načítání webu překročilo časový limit.' : e.message });
        } finally {
          busy = false;
        }
      }
      // External presentation: the current release to the website Git (after a content publication, or when the owner
      // confirms "Publish anyway" over someone else's change).
      if (req.method === 'GET' && req.url === '/www/status') {
        try {
          return json(200, { foreign: await websiteForeign() });
        } catch {
          return json(502, { error: 'Git webu není dostupný.' });
        }
      }
      if (req.method === 'POST' && req.url === '/www') {
        if (!process.env.SITETILLER_PRODUCTION_DIRECTORY) return json(501, { error: 'Not configured' });
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1000) return json(413, { error: 'Too large' });
        }
        const force = text ? JSON.parse(text).force === true : false;
        try {
          return json(200, await publishStaticWebsite({ force }));
        } catch (e: any) {
          console.error('Static website not written: ' + (e.code || e.name));
          return json(502, { error: 'Web se nepodařilo zapsat do Gitu.' });
        }
      }
      if (req.method === 'POST' && req.url === '/archive') {
        if (busy) return json(409, { error: 'Počkej na dokončení publikování.' });
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1000) return json(413, { error: 'Too large' });
        }
        const input = JSON.parse(text),
          approval = await readApproval(dataDirectory, 'archive');
        if (!approval || approval.commit !== input.commit || input.commit !== (await project.head()))
          return json(409, { error: 'Chybí ověřený snímek skutečného webu.' });
        await syncProductionMirror();
        const production = new Project(history),
          before = await production.head();
        if (before !== approval.hostingCommit)
          return json(409, { error: 'Skutečný web se mezitím změnil. Porovnej jej znovu.' });
        if (
          !Number.isInteger(input.number) ||
          input.number < 0 ||
          input.number > 999999 ||
          (await productionReleases(production)).some((r) => r.number === input.number)
        )
          return json(409, { error: 'Číslo verze již existuje.' });
        busy = true;
        publicWriteStarted = false;
        const temp = await mkdtemp(join(tmpdir(), 'sitetiller-archive-'));
        try {
          const target = new Project(temp);
          await target.git(['init', '-b', 'main']);
          await target.git(['fetch', remote, 'main']);
          const commit = await productionSnapshot(target, input.commit, before, project);
          await production.git(['fetch', temp, commit]);
          await production.git(['update-ref', 'refs/heads/main', commit, before]);
          await pushProductionRefs([commit + ':refs/heads/main']);
          const release = await storeProductionRelease(
            production,
            {
              number: input.number,
              description: 'Stav načtený ze skutečného webu',
              previousCommit: before,
              imported: true,
            },
            commit,
            input.commit,
          );
          await pushProductionRefs(['refs/tags/' + release.tag]);
          return json(200, { ok: true, release });
        } finally {
          busy = false;
          await rm(temp, { recursive: true, force: true });
        }
      }
      if (req.method === 'POST' && req.url === '/publish') {
        for (const name of await readdir(journalDirectory)) {
          if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
          const pending = await journal(name.slice(0, -5));
          if (!pending.completed && (await recordOps.probeCommitted(pending)))
            return json(409, { error: 'Publishing transaction is completing internally' });
        }
      }
      if (req.method !== 'POST' || req.url !== '/publish') return json(404, { error: 'Not found' });
      if (busy) return json(409, { error: 'Publish running' });
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 1000) return json(413, { error: 'Too large' });
      }
      const { commit, overrideWebsite } = JSON.parse(text);
      if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) return json(409, { error: 'Invalid snapshot' });
      const head = await project.head();
      // Approval is written by the controller, never by model tools; Publisher reads nothing else from AI Studio data.
      const approval = await readApproval(dataDirectory, 'publish');
      if (!approval || commit !== approval.commit) return json(409, { error: 'Commit not reviewed' });
      if (head !== approval.head) return json(409, { error: 'Draft changed' });
      try {
        await project.git(['merge-base', '--is-ancestor', commit, head]);
      } catch {
        return json(409, { error: 'Snapshot is not in draft history' });
      }
      const publishingFiles = await project.committedFiles(commit),
        // The checks level of an assistant's publication (documentation 2.8): key and strict keep the hosting checks,
        // none skips every technical check; the button is always strict.
        level = approval.checks === 'key' || approval.checks === 'none' ? approval.checks : 'strict';
      if (
        level !== 'none' &&
        Object.keys(renderingPages(publishingFiles)).length &&
        process.env.SITETILLER_WEBSITE_RUNTIME !== '1'
      )
        return json(409, {
          error:
            'Serverové CMS šablony vyžadují nasazený SiteTiller website runtime. Samotný statický export je nevykreslí.',
        });
      if (
        level !== 'none' &&
        Object.keys(formDefinitions(publishingFiles)).length &&
        process.env.SITETILLER_FORMS_RUNTIME !== '1' &&
        process.env.SITETILLER_WEBSITE_RUNTIME !== '1'
      )
        return json(409, {
          error:
            'Kontaktní formulář vyžaduje nasazený SiteTiller website runtime a nastavení pošty. Statické publikování by odesílání nezprovoznilo.',
        });
      const test =
        level === 'strict' ? staticChecks(publishingFiles) : level === 'key' ? keyChecks(publishingFiles) : null;
      if (test && !test.passed) return json(409, { error: 'Tests failed' });
      busy = true;
      const temp = await mkdtemp(join(tmpdir(), 'sitetiller-publish-'));
      try {
        if (level !== 'none' && (process.env.SITETILLER_PRODUCTION_URL || process.env.SITETILLER_HOSTING_POLICY_URL)) {
          stage = 'policy';
          if (!process.env.SITETILLER_PRODUCTION_URL) throw Error('Hosting policy probe requires fixed production URL');
          await assertHostingPolicy(process.env.SITETILLER_PRODUCTION_URL, process.env.SITETILLER_HOSTING_POLICY_URL);
        }
        await exec('git', ['init', '-b', 'main', temp], { windowsHide: true, timeout: 30000 });
        const run = async (args: string[]) =>
          exec('git', ['-c', 'safe.directory=' + temp, ...args], {
            windowsHide: true,
            cwd: temp,
            timeout: 120000,
            maxBuffer: 1000000,
          });

        stage = 'git';
        // An empty production Git (a new hosting repository) has no main yet: the publication becomes its first commit.
        const before = (await run(['ls-remote', remote, 'refs/heads/main'])).stdout.split(/\s/)[0] || null;
        if (before) {
          await run(['fetch', remote, 'main']);
          if ((await run(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== before)
            throw Error('Production Git changed during preparation');
        }
        const deployedCommit = await productionSnapshot(new Project(temp), commit, before, project);
        if (before) await run(['merge-base', '--is-ancestor', 'FETCH_HEAD', deployedCommit]);
        // No force push. Freeze explicit SHA so later draft changes cannot be released.
        if (process.env.SITETILLER_PRODUCTION_DIRECTORY)
          await prepareSite(project, commit, process.env.SITETILLER_PRODUCTION_DIRECTORY);
        await project.git(['update-ref', 'refs/sitetiller/publication/' + commit, commit]);
        await atomicJson(journalPath(commit), {
          commit,
          deployedCommit,
          before,
          intent: approval.intent,
          overrideWebsite: overrideWebsite === true,
          committed: false,
          completed: false,
        });
        publicWriteStarted = true;
        try {
          await run(['push', remote, deployedCommit + ':refs/heads/main']);
        } catch (error) {
          if (!(await recordOps.probeCommitted({ deployedCommit }))) throw error;
        }
        const record: any = {
          commit,
          deployedCommit,
          before,
          intent: approval.intent,
          overrideWebsite: overrideWebsite === true,
          committed: true,
          completed: false,
        };
        const outcome = await drivePublisherTransaction(record, recordOps);
        return json(outcome.state === 'published' ? 200 : 202, outcome);
      } finally {
        busy = false;
        await rm(temp, { recursive: true, force: true });
      }
    } catch (e: any) {
      console.error('SiteTiller publication failed at ' + stage + ' (' + (e.code || e.name || 'error') + ')');
      json(502, {
        committed: publicWriteStarted ? undefined : false,
        error:
          stage === 'policy'
            ? 'Publikování zastaveno: bezpečnostní pravidla produkčního hostingu neodpovídají náhledu. Je nutné opravit CSP domény.'
            : stage === 'verify'
              ? 'Git je aktualizovaný, ale veřejný web zatím neodpovídá této verzi. Systém dokončí nasazení interně.'
              : stage === 'hook'
                ? 'Git je aktualizovaný, ale spuštění nasazení ve VPS Centru selhalo.'
                : stage === 'git'
                  ? 'Zápis do produkčního Gitu selhal. Zkontroluj publikační službu.'
                  : 'Publikování selhalo před ověřením webu.',
      });
    }
  })
  .listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1');
