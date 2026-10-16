import Handlebars from 'handlebars';
import sanitizeHtml from 'sanitize-html';
import MarkdownIt from 'markdown-it';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSitePath } from './core.ts';
export const renderingCapability = {
  manifest: 'site/rendering.json',
  templates: 'site/templates/*.txt',
  engine: 'Handlebars, host-managed server rendering',
  contract:
    'For CMS websites prefer server-rendered HTML. Create site/rendering.json {version:1,pages:{"site/index.html":"site/templates/index.txt"}}. When editing a rendered page, edit its declared template; changing only the fallback HTML does not change the rendered response. Keep a valid site/index.html entry; the host replaces its response with the full HTML template. Templates are full HTML documents stored as .txt, not executable server code. Context is {schema,collections,page}. Collections contain actual rows keyed by collection name. Helpers: {{value "collection" "record-key" "field"}}, {{record "collection" "record-key"}}, {{label "collection" "record-key"}}, {{#each (where collections.pages "section" code)}}...{{/each}}, {{asset imagePath}}, {{url link}}, {{markdown formattedText}} (Formatted content fields: Markdown rendered and sanitized), {{html richText}} (legacy HTML fields only), {{color cssColor}}, {{token cssClass}}, {{encode routePart}}, {{phone phoneNumber}}. Normal expressions are escaped. Raw/triple braces are forbidden except {{html ...}}, which sanitizes HTML; {{markdown ...}} is a normal expression. CMS editor settings never enter context. The host injects <script type="application/json" id="sitetiller-cms"> with the same {schema,collections}; use this for client interactions without an initial CMS fetch or replacing correct initial DOM. Initial visible content, navigation, title and meta description must already exist without JavaScript. Build actual HTML pages for public routes; URL fragments are not available to the server. Technical checks render frozen snapshots and test first-response HTML/no-JavaScript content. Current previews and website runtime use live CMS; historical previews use frozen data. Static-only hosting needs pre-render export or the SiteTiller website runtime. Do not ask the user to build a backend. Keep JS for necessary interactions; defer noncritical scripts and lazy-load below-fold images.',
};
export function renderingPages(files: Record<string, string>): Record<string, string> {
  const text = files['site/rendering.json'];
  if (!text) return {};
  if (Buffer.byteLength(text) > 32000) throw Error('Rendering manifest is too large.');
  const config = JSON.parse(text);
  if (
    config?.version !== 1 ||
    !config.pages ||
    typeof config.pages !== 'object' ||
    Array.isArray(config.pages) ||
    Object.keys(config.pages).length > 20
  )
    throw Error('Invalid CMS rendering manifest.');
  for (const [page, template] of Object.entries(config.pages)) {
    safeSitePath('/project', page);
    if (
      !page.endsWith('.html') ||
      !Object.hasOwn(files, page) ||
      typeof template !== 'string' ||
      !/^site\/templates\/[\w/-]+\.txt$/.test(template)
    )
      throw Error('Invalid CMS rendering page.');
    safeSitePath('/project', template);
    if (!Object.hasOwn(files, template)) throw Error('CMS rendering template is missing.');
  }
  return config.pages;
}
const engine = Handlebars.create();
const row = (root: any, collection: string, key: string) => {
  const def = root.schema.lists?.[collection];
  return def ? root.collections[collection]?.find((r: any) => r[def.key] === key) : undefined;
};
const link = (value: unknown) => {
  const s = String(value || '').trim();
  return !/[\x00-\x20]/.test(s) && !s.startsWith('//') && /^(https?:\/\/|mailto:|tel:|#|\/|cms\/)/i.test(s) ? s : '';
};
function asset(value: unknown, root: any) {
  const path = String(value || '')
    .trim()
    .replace(/^\.\//, '');
  if (/^https?:\/\//i.test(path)) return link(path);
  if (/^cms\/media\/[a-f0-9]{16}\.(png|jpg|jpeg|webp)$/.test(path)) return path;
  const source = path.startsWith('cms/files/') ? path.slice(10) : path;
  const parts = source.split('/');
  return parts.length > 1 &&
    Object.hasOwn(root.schema.folders || {}, parts[0]) &&
    !parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))
    ? 'cms/files/' + parts.map(encodeURIComponent).join('/')
    : '';
}
engine.registerHelper('value', (c, k, f, o) => row(o.data.root, c, k)?.[f] ?? '');
engine.registerHelper('record', (c, k, o) => row(o.data.root, c, k));
engine.registerHelper('label', (c, k, o) => {
  const def = o.data.root.schema.lists?.[c],
    r = row(o.data.root, c, k),
    fields = Array.isArray(def?.display) ? def.display : [def?.display];
  return fields
    .map((f: any) => r?.[f] || '')
    .filter(Boolean)
    .join(' · ');
});
engine.registerHelper('where', (rows, field, value) =>
  Array.isArray(rows) ? rows.filter((r) => r?.[field] === value) : [],
);
engine.registerHelper('asset', (v, o) => asset(v, o.data.root));
engine.registerHelper('url', link);
engine.registerHelper('encode', (v) => encodeURIComponent(String(v ?? '')));
engine.registerHelper('phone', (v) => {
  const s = String(v || '').replace(/[^\d+]/g, '');
  return /^\+?\d+$/.test(s) ? 'tel:' + s : '';
});
engine.registerHelper('bool', (v) => v === true || v === 'true');
engine.registerHelper('color', (v) => (/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(String(v)) ? v : ''));
engine.registerHelper('token', (v) => (/^[a-zA-Z][\w-]*$/.test(String(v)) ? v : ''));
// Rich text for the website: only these tags, images from the content folders, safe links.
function richHtml(html: string, root: any) {
  return new engine.SafeString(
    sanitizeHtml(html, {
      allowedTags: [
        'p',
        'ul',
        'ol',
        'li',
        'strong',
        'b',
        'em',
        'i',
        'br',
        'a',
        'h2',
        'h3',
        'h4',
        'hr',
        'img',
        'blockquote',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ],
      allowedAttributes: { a: ['href', 'rel'], img: ['src', 'alt', 'loading', 'class'] },
      allowedSchemes: ['http', 'https', 'mailto', 'tel'],
      allowProtocolRelative: false,
      transformTags: {
        img: (_tag, attrs) => ({
          tagName: 'img',
          attribs: { src: asset(attrs.src, root), alt: attrs.alt || '', loading: 'lazy', class: 'inline-img' },
        }),
        a: (_tag, attrs) => ({
          tagName: 'a',
          attribs: { href: link(attrs.href) || asset(attrs.href, root), rel: 'noopener noreferrer' },
        }),
      },
    }),
  );
}
engine.registerHelper('html', (v, o) => richHtml(String(v || ''), o.data.root));
// Formatted content is Markdown (CommonMark + tables); HTML written inside it is not rendered.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
engine.registerHelper('markdown', (v, o) => richHtml(markdown.render(String(v || '')), o.data.root));
const compiled = new Map<string, ReturnType<typeof engine.compile>>();
function compile(source: string) {
  const cached = compiled.get(source);
  if (cached) return cached;
  let nodes = 0;
  const inspect = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    if (++nodes > 20000 || depth > 100) throw Error('CMS template is too complex.');
    if (node.type === 'MustacheStatement' && node.escaped === false && node.path.original !== 'html')
      throw Error('Use escaped expressions or the sanitized html helper.');
    if (['PartialStatement', 'PartialBlockStatement', 'Decorator', 'DecoratorBlock'].includes(node.type))
      throw Error('Template partials/decorators are not supported.');
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((n) => inspect(n, depth + 1));
      else if (v && typeof v === 'object') inspect(v, depth + 1);
    }
  };
  inspect(engine.parse(source));
  let template = compiled.get(source);
  if (!template) {
    if (compiled.size >= 100) compiled.clear();
    template = engine.compile(source, {
      knownHelpersOnly: true,
      knownHelpers: {
        value: true,
        record: true,
        label: true,
        where: true,
        asset: true,
        url: true,
        encode: true,
        phone: true,
        color: true,
        token: true,
        html: true,
        markdown: true,
        bool: true,
      },
    });
    compiled.set(source, template);
  }
  return template;
}
export async function renderingData(files: Record<string, string>, live = false) {
  const root = live ? process.env.SITETILLER_CMS_ROOT : undefined;
  let bytes = 0;
  const load = async (path: string) => {
    const text = root
      ? await readFile(
          join(root, path === 'cms/structure.json' ? 'schema/structure.json' : path.replace(/^cms\//, '')),
          'utf8',
        )
      : files['site/' + path];
    if (typeof text !== 'string') throw Error('CMS data missing: ' + path);
    bytes += Buffer.byteLength(text);
    if (bytes > 2000000) throw Error('CMS data exceeded rendering limit.');
    return JSON.parse(text);
  };
  const schema = await load('cms/structure.json');
  delete schema.settings;
  const collections: Record<string, any[]> = {};
  for (const name of Object.keys(schema.lists || {})) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw Error('Invalid CMS collection');
    try {
      const rows = await load('cms/data/' + name + '.json');
      if (!Array.isArray(rows) || rows.length > 10000) throw Error('Invalid CMS rows');
      collections[name] = rows;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      collections[name] = [];
    }
  }
  return { schema, collections };
}
export async function renderCmsPage(page: string, files: Record<string, string>, live = false) {
  const template = renderingPages(files)[page];
  if (!template) return null;
  return renderWithData(page, files, await renderingData(files, live));
}
export function renderWithData(page: string, files: Record<string, string>, data: any) {
  const template = renderingPages(files)[page];
  if (!template) return files[page];
  data = { ...data, schema: { ...data.schema } };
  delete data.schema.settings;
  let html = compile(files[template])(
    { ...data, page },
    { allowProtoMethodsByDefault: false, allowProtoPropertiesByDefault: false },
  );
  if (Buffer.byteLength(html) > 2000000 || !/<\/head>/i.test(html)) throw Error('Invalid or oversized rendered HTML.');
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  html = html
    .replace(/<html\b/i, '<html data-sitetiller-ssr="1"')
    .replace(/<\/head>/i, '<script type="application/json" id="sitetiller-cms">' + json + '</script></head>');
  return html;
}
