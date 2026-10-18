import { renderingPages, renderingData, renderWithData, renderCmsPage } from './cms-render.ts';
import { cmsSnapshotAsset } from './cms-snapshot-asset.ts';
import { serveForm, formDefinitions } from './contact-forms.ts';
import { websitePolicy } from './site-policy.ts';
import { validateBrowserTests, runBrowserScenario } from './browser-scenarios.ts';
import { Script } from 'node:vm';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { validateFiles, safeSitePath, resolveSiteFile } from './core.ts';
import { raster, imageMime, binaryAsset } from './images.ts';
export function staticChecks(files: Record<string, string>) {
  let checked = files;
  try {
    const pages = renderingPages(files);
    const schema = JSON.parse(files['site/cms/structure.json'] || 'null'),
      collections = Object.fromEntries(
        Object.keys(schema?.lists || {}).map((n) => [n, JSON.parse(files['site/cms/data/' + n + '.json'] || '[]')]),
      );
    checked = { ...files };
    for (const page of Object.keys(pages)) checked[page] = renderWithData(page, files, { schema, collections });
  } catch (e: any) {
    return { passed: false, errors: [e.message], checks: ['CMS templates'] };
  }
  const errors = validateFiles(checked);
  try {
    formDefinitions(files);
  } catch (e: any) {
    errors.push(e.message);
  }
  for (const [path, text] of Object.entries(files)) {
    const scripts = path.endsWith('.js')
      ? [text]
      : path.endsWith('.html')
        ? [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
            .filter(
              (m) => !m[1].includes('src=') && !/type\s*=\s*["'](?:application\/(?:ld\+)?json|module)["']/i.test(m[1]),
            )
            .map((m) => m[2])
        : [];
    for (const script of scripts)
      try {
        if (!/^\s*(?:import|export)\s/m.test(script)) new Script(script, { filename: path });
      } catch {
        errors.push('JavaScript syntax error: ' + path);
      }
  }
  return {
    passed: errors.length === 0,
    errors,
    checks: ['HTML structure', 'local references', 'classic JavaScript syntax'],
    limitations: ['Module JavaScript is validated during browser loading.'],
  };
}
// Browser for the checks: SITETILLER_BROWSER_EXECUTABLE when set, else Playwright's own Chromium, else the installed
// Chrome or Edge (Playwright's browser download is optional and disappears with every Playwright update).
export async function launchBrowser(chromium: any) {
  // A container may have only 64 MB of /dev/shm; Chromium then keeps its shared memory in /tmp.
  const options = { headless: true, args: ['--disable-dev-shm-usage'] };
  if (process.env.SITETILLER_BROWSER_EXECUTABLE)
    return chromium.launch({ ...options, executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE });
  try {
    return await chromium.launch(options);
  } catch (error: any) {
    if (!/Executable doesn't exist/.test(String(error?.message))) throw error;
    for (const channel of ['chrome', 'msedge'])
      try {
        return await chromium.launch({ ...options, channel });
      } catch {}
    throw Error(
      'Pro kontrolu v prohlížeči chybí prohlížeč. Nainstalujte Google Chrome nebo Microsoft Edge, ' +
        'případně nastavte SITETILLER_BROWSER_EXECUTABLE.',
    );
  }
}
// Ephemeral isolated preview. Never exposes the studio, credentials or project metadata.
export async function browserChecks(
  root: string,
  files: Record<string, string>,
  browserTests: any[] = [],
  preferredImages: string[] = [],
) {
  validateBrowserTests(browserTests, files);
  const scenarios: any[] = [];
  let scenarioTime = 0;
  const { chromium } = await import('playwright');
  const errors: string[] = [],
    warnings: string[] = [],
    screenshots: any[] = [],
    checks: any[] = [],
    interactions: any[] = [],
    imageEvidence: any[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1'),
        name =
          cmsSnapshotAsset(decodeURIComponent(url.pathname).slice(1), files) ||
          resolveSiteFile(decodeURIComponent(url.pathname), files);
      if (
        await serveForm(req, res, decodeURIComponent(url.pathname).slice(1), files, {
          preview: true,
          origin: 'http://' + req.headers.host,
        })
      )
        return;
      safeSitePath(root, name);
      if (!(name in files)) {
        res.writeHead(404);
        return res.end();
      }
      if (
        !cmsSnapshotAsset(decodeURIComponent(url.pathname).slice(1), files) &&
        !url.pathname.endsWith('/') &&
        !Object.hasOwn(files, 'site/' + decodeURIComponent(url.pathname).slice(1))
      ) {
        res.writeHead(302, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      const mime: any = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.pdf': 'application/pdf',
      };
      res.writeHead(200, {
        'Content-Type': raster(name) ? imageMime(name) : mime[extname(name)] || 'text/plain',
        'Content-Security-Policy': websitePolicy,
      });
      res.end(
        binaryAsset(name)
          ? await readFile(join(root, name))
          : name.endsWith('.html')
            ? (await renderCmsPage(name, files)) || files[name]
            : files[name],
      );
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser: any;
  try {
    browser = await launchBrowser(chromium);
    const origin = 'http://127.0.0.1:' + (server.address() as any).port;
    const pages = Object.keys(files).filter((p) => p.endsWith('.html'));
    if (pages.length > 20) throw Error('Browser check supports at most 20 pages per request.');
    const references = Object.entries(files)
        .filter(([p]) => !raster(p))
        .map(([, text]) => text)
        .join('\n'),
      imagePaths = [
        ...new Set([
          ...preferredImages,
          ...Object.keys(files).filter((p) => raster(p) && references.includes(p.slice(5))),
        ]),
      ]
        .filter((p) => raster(p) && Object.hasOwn(files, p))
        .slice(0, 20);
    if (imagePaths.length) {
      // Website scripts cannot alter the canvas APIs used for trusted pixel evidence.
      const evidenceContext = await browser.newContext({ javaScriptEnabled: false });
      await evidenceContext.route('**/*', async (route: any) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const evidencePage = await evidenceContext.newPage();
      try {
        await evidencePage.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        const decoded = await evidencePage.evaluate(async (paths: string[]) => {
          const evidence: any[] = [];
          let pixelBudget = 32000000;
          for (const path of paths)
            try {
              const image = new Image();
              image.src = '/' + path.split('/').slice(1).map(encodeURIComponent).join('/');
              await image.decode();
              const width = image.naturalWidth,
                height = image.naturalHeight,
                totalPixels = width * height;
              if (totalPixels > 8000000 || totalPixels > pixelBudget) {
                evidence.push({ path, width, height, totalPixels, checked: false, reason: 'Pixel budget exceeded' });
                continue;
              }
              pixelBudget -= totalPixels;
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const context = canvas.getContext('2d', { willReadFrequently: true })!;
              context.drawImage(image, 0, 0);
              const bytes = context.getImageData(0, 0, width, height).data;
              let transparentPixels = 0,
                partiallyTransparentPixels = 0;
              for (let i = 3; i < bytes.length; i += 4)
                if (bytes[i] === 0) transparentPixels++;
                else if (bytes[i] < 255) partiallyTransparentPixels++;
              evidence.push({
                path,
                width,
                height,
                totalPixels,
                checked: true,
                transparentPixels,
                partiallyTransparentPixels,
                hasTransparentPixels: transparentPixels + partiallyTransparentPixels > 0,
              });
              canvas.width = canvas.height = 0;
            } catch {
              evidence.push({ path, checked: false, error: 'Image decoding failed' });
            }
          return evidence;
        }, imagePaths);
        imageEvidence.push(...decoded);
        for (const image of decoded)
          if (image.error) errors.push(image.path + ': ' + image.error);
          else if (!image.checked) warnings.push(image.path + ': pixel evidence skipped');
      } finally {
        await evidenceContext.close();
      }
    }
    const serverRendering: any[] = [];
    if (Object.keys(renderingPages(files)).length) {
      const context = await browser.newContext({ javaScriptEnabled: false });
      await context.route('**/*', async (route: any) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      try {
        for (const path of Object.keys(renderingPages(files))) {
          const page = await context.newPage();
          const response = await page.goto(origin + '/' + path.slice(5), {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          const evidence = await page.evaluate(() => ({
            noJavaScript: true,
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
            mainText: (document.querySelector('main')?.textContent || '').trim(),
            domContentLoadedMs: performance.now(),
          }));
          serverRendering.push({ path, status: response?.status(), ...evidence });
          if (
            !evidence.mainText ||
            /^(Načítám|Loading)[. …]*$/i.test(evidence.mainText) ||
            /^(Načítání|Loading)/i.test(evidence.title)
          )
            errors.push(path + ': missing initial CMS content without JavaScript');
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      await context.route('**/*', async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        return route.continue();
      });
      for (const path of pages) {
        const page = await context.newPage(),
          label = path + ' @ ' + viewport.width;
        page.on('pageerror', (e: any) => errors.push(label + ': ' + e.message.slice(0, 300)));
        page.on('response', (r: any) => {
          if (r.url().startsWith(origin) && r.status() >= 400 && !r.url().endsWith('/favicon.ico'))
            errors.push(label + ': HTTP ' + r.status() + ' ' + new URL(r.url()).pathname);
        });
        // External resources are blocked to prevent preview scripts contacting real services.
        page.on('console', (msg: any) => {
          if (
            msg.type() === 'error' &&
            !/ERR_FAILED|ERR_BLOCKED|Content Security Policy|violates.*directive/i.test(msg.text())
          )
            errors.push(label + ': ' + msg.text().slice(0, 300));
        });
        const response = await page.goto(origin + '/' + path.slice(5), { waitUntil: 'load', timeout: 15000 });
        if (response?.status() !== 200) errors.push(label + ': page did not load');
        const dom = await page.evaluate(() => ({
          body: !!document.body,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        }));
        if (!dom.body) errors.push(label + ': missing body');
        if (dom.overflow) errors.push(label + ': horizontal overflow');
        checks.push({
          path,
          viewport: viewport.width,
          status: response?.status(),
          body: dom.body,
          overflow: dom.overflow,
        });
        if (viewport.width === 390) {
          const toggles = page.locator('button[aria-controls][aria-expanded]');
          for (let index = 0; index < Math.min(await toggles.count(), 8); index++) {
            const toggle = toggles.nth(index);
            if (!(await toggle.isVisible())) continue;
            const targetId = ((await toggle.getAttribute('aria-controls')) || '').trim().split(/\s+/)[0],
              target = page.locator('[id=' + JSON.stringify(targetId) + ']');
            if ((await target.count()) !== 1) {
              errors.push(label + ': toggle references a missing or ambiguous controlled element ' + targetId);
              continue;
            }
            const initiallyOpen = (await toggle.getAttribute('aria-expanded')) === 'true';
            const visibility = async () =>
              await target.evaluate((element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                let node: HTMLElement | null = element;
                while (node) {
                  const style = getComputedStyle(node);
                  if (
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    Number(style.opacity) === 0 ||
                    node.hidden
                  )
                    return false;
                  node = node.parentElement;
                }
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.right > 0 &&
                  rect.bottom > 0 &&
                  rect.left < innerWidth &&
                  rect.top < innerHeight
                );
              });
            const states: any[] = [];
            for (let click = 0; click < 2; click++) {
              await toggle.click({ timeout: 5000 });
              await page.waitForTimeout(300);
              states.push({
                expanded: (await toggle.getAttribute('aria-expanded')) === 'true',
                visible: await visibility(),
              });
            }
            const opened = initiallyOpen ? states[1] : states[0],
              closed = initiallyOpen ? states[0] : states[1];
            const passed = opened.expanded && opened.visible && !closed.expanded && !closed.visible;
            interactions.push({
              path,
              viewport: viewport.width,
              type: 'mobile-disclosure',
              targetId,
              initiallyOpen,
              opened,
              closed,
              restoredInitialState: states[1].expanded === initiallyOpen,
              passed,
            });
            if (!passed)
              errors.push(
                label + ': mobile toggle must open and close ' + targetId + ' and update aria-expanded correctly',
              );
          }
        }
        if (path === 'site/index.html')
          screenshots.push({ name: label, mime: 'image/png', data: (await page.screenshot()).toString('base64') });
        await page.close();
      }
      for (const test of browserTests) {
        const start = Date.now();
        if (scenarioTime >= 30000) {
          warnings.push(test.name + ': Interakci se nepodařilo ověřit v časovém limitu');
          scenarios.push({
            name: test.name,
            path: test.path,
            viewport: viewport.width,
            passed: false,
            error: 'Interaction test budget exhausted',
            failureKind: 'budget',
            steps: [],
          });
          continue;
        }
        const page = await context.newPage();
        let execution: any;
        try {
          page.on('pageerror', (e: any) => errors.push(test.name + ': ' + e.message.slice(0, 300)));
          page.on('response', (r: any) => {
            if (r.url().startsWith(origin) && r.status() >= 400 && !r.url().endsWith('/favicon.ico'))
              errors.push(test.name + ': HTTP ' + r.status() + ' ' + new URL(r.url()).pathname);
          });
          const response = await page.goto(origin + '/' + test.path.slice(5), { waitUntil: 'load', timeout: 10000 });
          if (response?.status() !== 200) throw Error('Scenario page did not load');
          execution = await runBrowserScenario(page, test, Math.max(0, 30000 - scenarioTime - (Date.now() - start)));
        } catch (e: any) {
          execution = {
            name: test.name,
            path: test.path,
            passed: false,
            error: String(e.message).slice(0, 500),
            failureKind: e.name === 'TimeoutError' ? 'timeout' : 'error',
            steps: [],
          };
        } finally {
          await page.close();
          scenarioTime += Date.now() - start;
        }
        scenarios.push({ ...execution, viewport: viewport.width });
        if (!execution.passed) {
          const message = test.name + ' @ ' + viewport.width + ': ' + execution.error;
          if (['timeout', 'budget'].includes(execution.failureKind))
            warnings.push('Interakci se nepodařilo ověřit: ' + message);
          else errors.push(message);
        }
      }
      await context.close();
    }
    warnings.push('External services are blocked during smoke tests; real Spotify/Mailchimp requests are not tested.');
    return {
      passed: errors.length === 0,
      errors: [...new Set(errors)],
      warnings,
      checks,
      interactions,
      scenarios,
      imageEvidence,
      screenshots,
      serverRendering,
    };
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
