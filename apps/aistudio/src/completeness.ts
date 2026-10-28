import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siteServer, launchBrowser } from './checks.ts';
import { currentStopSignal, StoppedError } from './run-control.ts';
import { raster } from './images.ts';
// The completeness check (documentation 4.11): does the website have what a finished website is expected to have?
// It only reports: every rule gives ok or a warning, nothing is changed and nothing blocks a publication.
export type Item = { id: string; ok: boolean; pages?: string[]; detail?: string };
export type Group = { id: 'face' | 'search' | 'sharing' | 'access' | 'eu' | 'function'; items: Item[] };
export type Completeness = {
  commit?: string;
  groups: Group[];
  ai: { done: boolean; note?: string };
  excerpt: any[];
  // The addresses outside the website its pages link to; checked only on request (Check external links too).
  externalLinks: string[];
};

// Known measuring and advertising services that set tracking cookies (EU rules: they need consent first).
const tracking =
  /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|static\.hotjar\.com|clarity\.ms|snap\.licdn\.com|analytics\.tiktok\.com|doubleclick\.net|mc\.yandex/i;
const consentTools = /cookiebot|onetrust|cookieconsent|cookie-consent|klaro|tarteaucitron|cookieyes|usercentrics/i;
const privacyWords = /ochran[aěu] (osobních )?údajů|zpracování osobních údajů|osobní údaje|GDPR|privacy|soukromí/i;

// The address of a page on the website: site/index.html → /, site/a/index.html → /a/, site/b.html → /b.html.
const pageAddress = (path: string) => '/' + path.slice(5).replace(/(^|\/)index\.html$/, '$1');

export async function completenessChecks(
  root: string,
  files: Record<string, string>,
  { siteUrl = process.env.SITETILLER_SITE_URL || '' }: { siteUrl?: string } = {},
): Promise<Completeness> {
  const pages = Object.keys(files)
    .filter((p) => p.endsWith('.html') && p !== 'site/404.html' && !p.startsWith('site/cms/'))
    .slice(0, 20);
  const evidence = await pageEvidence(root, files, pages);
  const all = (pick: (e: any) => boolean) => evidence.filter((e) => !pick(e)).map((e) => e.path);
  const item = (id: string, failing: string[] | boolean, detail?: string): Item =>
    Array.isArray(failing)
      ? { id, ok: !failing.length, ...(failing.length ? { pages: failing } : {}), ...(detail ? { detail } : {}) }
      : { id, ok: !failing, ...(detail && failing ? { detail } : {}) };
  const anyLink = (rel: RegExp) => evidence.some((e) => e.links.some((l: any) => rel.test(l.rel)));
  // Face of the website.
  const titles = evidence.map((e) => e.title.trim()),
    duplicateTitles = evidence
      .filter((e, i) => e.title.trim() && titles.indexOf(e.title.trim()) !== i)
      .map((e) => e.path);
  const face: Group = {
    id: 'face',
    items: [
      item('icon', !(Object.hasOwn(files, 'site/favicon.ico') || anyLink(/(^|\s)icon(\s|$)/i))),
      item('touch_icon', !(Object.hasOwn(files, 'site/apple-touch-icon.png') || anyLink(/apple-touch-icon/i))),
      item('title', [...all((e) => !!e.title.trim()), ...duplicateTitles]),
      item(
        'description',
        all((e) => e.description.trim().length >= 50),
      ),
    ],
  };
  // Search engines.
  const sitemap = files['site/sitemap.xml'] || '',
    robots = files['site/robots.txt'] || '',
    missingInSitemap = pages.filter((p) => !sitemap.includes(pageAddress(p).replace(/\/$/, '') || '/'));
  const host = (() => {
    try {
      return siteUrl ? new URL(siteUrl).host : '';
    } catch {
      return '';
    }
  })();
  const search: Group = {
    id: 'search',
    items: [
      item(
        'one_h1',
        all((e) => e.h1 === 1),
      ),
      item(
        'lang',
        all((e) => !!e.lang),
      ),
      item('sitemap', sitemap ? missingInSitemap : true),
      item('robots', !robots || /^\s*disallow:\s*\/\s*$/im.test(robots) || !/^\s*sitemap:/im.test(robots)),
      item(
        'canonical',
        all(
          (e) =>
            !!e.canonical &&
            (!host ||
              (() => {
                try {
                  return new URL(e.canonical).host === host;
                } catch {
                  return false;
                }
              })()),
        ),
      ),
      item(
        'readable_addresses',
        pages.filter((p) => !/^site\/[a-z0-9/-]+(\.html)?$/.test(p)),
      ),
    ],
  };
  // Sharing on social networks.
  const sharing: Group = {
    id: 'sharing',
    items: [
      item(
        'og_title',
        all((e) => !!e.og.title),
      ),
      item(
        'og_description',
        all((e) => !!e.og.description),
      ),
      item(
        'og_image',
        all((e) => e.og.image && e.og.imageWidth >= 600 && e.og.imageHeight >= 315),
      ),
    ],
  };
  // Accessibility.
  const access: Group = {
    id: 'access',
    items: [
      item(
        'alt',
        all((e) => !e.missingAlt),
      ),
      item(
        'contrast',
        all((e) => !e.lowContrast.length),
      ),
      item(
        'heading_order',
        all((e) => !e.headingJump),
      ),
    ],
  };
  // EU rules (GDPR, ePrivacy): only noticed, never advised.
  const text = evidence.map((e) => e.text).join('\n'),
    hrefs = evidence.flatMap((e) => e.anchors);
  const contact =
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) ||
    /(\+\d{3}\s?)?\d{3}\s?\d{3}\s?\d{3}/.test(text) ||
    hrefs.some((a: any) => /^(mailto|tel):/i.test(a.href));
  const hasForm = evidence.some((e) => e.forms > 0),
    privacy = hrefs.some((a: any) => privacyWords.test(a.text) || privacyWords.test(a.href)) || privacyWords.test(text);
  const tracked = evidence.some((e) => e.scripts.some((s: string) => tracking.test(s))),
    consent =
      evidence.some((e) => e.scripts.some((s: string) => consentTools.test(s))) ||
      (/cookie/i.test(text) && /(souhlas|přijmout|odmítnout|accept|consent|reject)/i.test(text));
  const eu: Group = {
    id: 'eu',
    items: [item('contact', !contact), item('privacy', hasForm && !privacy), item('consent', tracked && !consent)],
  };
  // Function beyond the technical check.
  const heavy: string[] = [];
  for (const path of Object.keys(files).filter(raster)) {
    try {
      const size = (await readFile(join(root, path))).length;
      if (size > 1024 * 1024) heavy.push(path);
    } catch {}
  }
  for (const e of evidence) for (const image of e.oversized) if (!heavy.includes(image)) heavy.push(image);
  const fn: Group = {
    id: 'function',
    items: [item('not_found_page', !Object.hasOwn(files, 'site/404.html')), item('image_size', heavy)],
  };
  const externalLinks = [
    ...new Set(
      hrefs
        .map((a: any) => a.href)
        .filter((href: string) => {
          try {
            const url = new URL(href);
            return ['http:', 'https:'].includes(url.protocol) && url.host !== host;
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 100) as string[];
  return {
    externalLinks,
    groups: [face, search, sharing, access, eu, fn],
    ai: { done: false },
    excerpt: evidence.map((e) => ({
      path: e.path,
      title: e.title,
      description: e.description,
      og: { title: e.og.title, description: e.og.description },
      headings: e.headings.slice(0, 10),
      links: e.anchors.slice(0, 20).map((a: any) => a.text + ' → ' + a.href),
      text: e.text.slice(0, 600),
      forms: e.forms,
    })),
  };
}

// What every page shows in a browser at desktop width: its head, headings, images, links, text and colours.
async function pageEvidence(root: string, files: Record<string, string>, pages: string[]) {
  const { chromium } = await import('playwright');
  const server = await siteServer(root, files),
    origin = 'http://127.0.0.1:' + (server.address() as any).port;
  let browser: any;
  try {
    browser = await launchBrowser(chromium);
    const stop = currentStopSignal();
    if (stop?.aborted) throw new StoppedError();
    stop?.addEventListener('abort', () => browser.close().catch(() => {}), { once: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // The page records its own scripts, but nothing outside the website is loaded.
    await context.route('**/*', async (route: any) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const result: any[] = [];
    for (const path of pages) {
      const page = await context.newPage();
      try {
        await page.goto(origin + pageAddress(path), { waitUntil: 'load', timeout: 15000 });
        result.push({ path, ...(await page.evaluate(collect)) });
      } catch {
        result.push({ path, ...emptyEvidence() });
      } finally {
        await page.close();
      }
    }
    await context.close();
    return result;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function emptyEvidence() {
  return {
    title: '',
    description: '',
    lang: '',
    canonical: '',
    h1: 0,
    headings: [],
    headingJump: false,
    og: { title: '', description: '', image: '', imageWidth: 0, imageHeight: 0 },
    links: [],
    anchors: [],
    scripts: [],
    forms: 0,
    missingAlt: 0,
    lowContrast: [],
    oversized: [],
    text: '',
  };
}

// Runs in the page.
async function collect() {
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent || '').trim().slice(0, 120),
  }));
  let headingJump = false;
  for (let i = 1; i < headings.length; i++) if (headings[i].level > headings[i - 1].level + 1) headingJump = true;
  const ogImage = meta('meta[property="og:image"]');
  let imageWidth = 0,
    imageHeight = 0;
  if (ogImage)
    try {
      const image = new Image();
      image.src = new URL(ogImage, location.href).pathname;
      await image.decode();
      imageWidth = image.naturalWidth;
      imageHeight = image.naturalHeight;
    } catch {}
  // Relative luminance and contrast ratio (WCAG 2.x) of the text against the first opaque background behind it.
  const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
  const luminance = ([r, g, b]: number[]) =>
    [r, g, b]
      .map((c) => c / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const lowContrast: string[] = [];
  const texts = [...document.querySelectorAll('p,li,a,span,h1,h2,h3,h4,h5,h6,button,label,td,th')].slice(0, 300);
  for (const element of texts) {
    const own = [...element.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim());
    const box = element.getBoundingClientRect();
    if (!own || !box.width || !box.height) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    let background: number[] | null = null,
      node: Element | null = element;
    while (node) {
      const s = getComputedStyle(node);
      if (s.backgroundImage !== 'none') break;
      const c = rgb(s.backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] >= 0.9)) {
        background = c;
        break;
      }
      node = node.parentElement;
    }
    if (!node) background = [255, 255, 255];
    if (!background) continue;
    const fg = rgb(style.color),
      [a, b] = [luminance(fg), luminance(background)].sort((x, y) => y - x),
      ratio = (a + 0.05) / (b + 0.05),
      size = parseFloat(style.fontSize),
      large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push((element.textContent || '').trim().slice(0, 60));
    if (lowContrast.length >= 5) break;
  }
  const images = [...document.images];
  return {
    title: document.title || '',
    description: meta('meta[name="description"]'),
    lang: document.documentElement.getAttribute('lang') || '',
    canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || '',
    h1: document.querySelectorAll('h1').length,
    headings,
    headingJump,
    og: {
      title: meta('meta[property="og:title"]'),
      description: meta('meta[property="og:description"]'),
      image: ogImage,
      imageWidth,
      imageHeight,
    },
    links: [...document.querySelectorAll('link[rel]')].map((l) => ({
      rel: l.getAttribute('rel') || '',
      href: l.getAttribute('href') || '',
    })),
    anchors: [...document.querySelectorAll('a[href]')].map((a) => ({
      href: a.getAttribute('href') || '',
      text: (a.textContent || '').trim().slice(0, 80),
    })),
    scripts: [...document.scripts].map((s) => s.src || (s.textContent || '').slice(0, 2000)),
    forms: document.forms.length,
    missingAlt: images.filter((i) => !i.hasAttribute('alt') && i.getAttribute('role') !== 'presentation').length,
    lowContrast,
    oversized: images
      .filter(
        (i) =>
          i.naturalWidth &&
          i.clientWidth &&
          i.naturalWidth > 2 * i.clientWidth * devicePixelRatio &&
          i.naturalWidth > 800,
      )
      .map((i) => 'site' + new URL(i.currentSrc || i.src).pathname),
    text: (document.body?.innerText || '').slice(0, 20000),
  };
}

// The AI part (documentation 4.11): one call of the Verifier on the excerpt only. It judges what rules cannot: whether
// the names, descriptions and texts for sharing fit the content and are not placeholders, and whether a website with
// a form really informs about the processing of personal data. It only reports.
export const reviewInstruction =
  'You check the completeness of a finished website. Input: pages with title, description, Open Graph texts, headings, links and a short text excerpt. Judge only: (1) texts: do the page titles, descriptions and Open Graph texts fit the page content, without placeholders, lorem ipsum or generic text? (2) privacy: only when some page has a form, does the website clearly inform about the processing of personal data (EU rules, GDPR)? Never give legal advice, never invent facts. Return JSON {"texts":{"ok":boolean,"detail":string},"privacy":{"ok":boolean,"detail":string}|null} with detail as one short sentence in the language of the website, naming pages when relevant.';
export function mergeReview(result: Completeness, value: any) {
  const valid = (v: any) => v && typeof v.ok === 'boolean' && typeof v.detail === 'string' && v.detail.length <= 500;
  if (!valid(value?.texts) || (value.privacy !== null && value.privacy !== undefined && !valid(value.privacy)))
    throw Error('Invalid completeness review.');
  const add = (group: string, id: string, v: any) =>
    result.groups
      .find((g) => g.id === group)!
      .items.push({ id, ok: v.ok, ...(v.ok ? {} : { detail: v.detail.trim() }) });
  add('face', 'texts_fit', value.texts);
  if (value.privacy && result.excerpt.some((p) => p.forms > 0)) add('eu', 'privacy_content', value.privacy);
  result.ai = { done: true };
  return result;
}
// The result for one commit, computed once and kept (.sitetiller/completeness/<commit>.json); the same commit is never
// checked or paid for again. Without a key, or when the provider fails, only the rules run and the result says so.
export async function completenessFor(
  project: {
    committedFiles(commit: string): Promise<Record<string, string>>;
    binary(commit: string, path: string): Promise<Buffer>;
  },
  commit: string,
  dataDir: string,
  review: ((excerpt: any[]) => Promise<any>) | null,
): Promise<Completeness> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Neplatná verze.');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { binaryAsset } = await import('./images.ts'),
    { atomicJson } = await import('../../../packages/settings/index.mjs'),
    file = join(dataDir, 'completeness', commit + '.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const files = await project.committedFiles(commit),
    root = await mkdtemp(join(tmpdir(), 'sitetiller-completeness-'));
  let result: Completeness;
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), binaryAsset(path) ? await project.binary(commit, path) : content);
    }
    result = await completenessChecks(root, files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (!review) result.ai = { done: false, note: 'no_key' };
  else
    try {
      mergeReview(result, await review(result.excerpt));
    } catch {
      result.ai = { done: false, note: 'failed' };
    }
  result.commit = commit;
  await mkdir(join(dataDir, 'completeness'), { recursive: true });
  // Only a complete result is kept; one without the AI part is computed again when a key is there next time.
  if (result.ai.done) await atomicJson(file, result);
  return result;
}

// Check external links too (documentation 4.11): each address once, five at a time, 10 s each. A server that does not
// answer is "unavailable", 404 or 410 "missing", an internal address is never contacted; none of them is an error.
export async function checkExternalLinks(
  links: string[],
  probe: (url: string) => Promise<'ok' | 'missing' | 'unavailable' | 'internal'>,
) {
  const result: { url: string; state: string }[] = [],
    queue = links.slice(0, 100);
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) result.push({ url, state: await probe(url) });
    }),
  );
  return links.slice(0, 100).map((url) => result.find((r) => r.url === url)!);
}
