import { createServer } from 'node:http';
import { initialTeam, initialImages } from '../../src/team.ts';
import { previewDocument } from '../../src/preview-document.ts';
import { studioAsset } from './studio-assets.ts';
// The built AI Studio page against a fixture API: /api/state answers `state` (merged with defaults), previews
// are pages that report their title for the commit in their address, other API calls answer {}.
export function studioState(state: any) {
  return {
    versionActions: 1,
    networkMode: 'offline',
    providers: [],
    roles: initialTeam(),
    imageModels: initialImages(),
    events: [],
    job: null,
    busy: false,
    hasLoadedReality: true,
    hasDraftSteps: true,
    hasUnpublishedWork: true,
    publishConfigured: true,
    publishableCommits: [],
    releases: [],
    savedDrafts: [],
    history: [],
    requests: [],
    cmsPreviewSources: {},
    ...state,
  };
}
export async function studioPage(browser: any, initial: any, { language = 'cs' } = {}) {
  let state = studioState(initial);
  const calls: any[] = [];
  let origin = '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname.slice(5);
        let body: any = {};
        if (req.method === 'POST') {
          let text = '';
          for await (const chunk of req) text += chunk;
          body = JSON.parse(text || '{}');
          calls.push({ path, body });
        }
        const value =
          path === 'session'
            ? { authenticated: true }
            : path === 'state'
              ? { ...state, previewUrl: origin + '/preview/' }
              : path === 'models'
                ? { models: [], issues: [], optionalIssues: [] }
                : path === 'design-content-status'
                  ? { unpublished: false }
                  : path === 'drafts/preview'
                    ? { url: '/preview/drafts/' + body.id + '/access/fixture/', expires: Date.now() + 3600000 }
                    : {};
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
        return;
      }
      if (url.pathname.startsWith('/preview/')) {
        const commit =
          url.pathname.match(/[a-f0-9]{40}/)?.[0] ||
          state.savedDrafts.find((d: any) => url.pathname.includes(d.id))?.commit ||
          state.head;
        res.setHeader('Content-Type', 'text/html');
        res.end(
          req.method === 'HEAD'
            ? ''
            : previewDocument(
                '<html><head><title>Fixture ' +
                  commit.slice(0, 8) +
                  '</title></head><body><h1>' +
                  commit +
                  '</h1></body></html>',
                commit,
                true,
              ),
        );
        return;
      }
      const asset = await studioAsset(url.pathname, language);
      if (!asset) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Content-Type', asset.type);
      res.end(asset.body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/');
  await page.waitForFunction(() => {
    const w = document.getElementById('workspace');
    return !!w && !w.hidden && !w.hasAttribute('aria-busy');
  });
  return {
    page,
    calls,
    errors,
    // Replaces the state and lets the studio fetch it (as when its window becomes visible again).
    async update(next: any) {
      state = studioState(next);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(300);
    },
    async close() {
      await page.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
