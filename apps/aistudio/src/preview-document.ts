// Every document decides whether it is actually framed, including later navigation.
export function previewDocument(html: string, commit: string, embedded = false, label = '') {
  const titleBridge =
    '<script data-sitetiller-title>(()=>{const report=()=>{if(window.parent!==window)window.parent.postMessage({type:"sitetiller-preview-title",commit:' +
    JSON.stringify(commit) +
    ',title:document.title},"*");};report();addEventListener("pageshow",report);new MutationObserver(report).observe(document.head||document.documentElement,{childList:true,subtree:true,characterData:true});})();</script>';
  html = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, titleBridge + '</head>')
    : html.replace(/<body\b[^>]*>/i, (match) => match + titleBridge);
  if (embedded) {
    const storage =
      '<script data-sitetiller-preview-storage>(()=>{for(const name of ["localStorage","sessionStorage"]){try{window[name].getItem("sitetiller-storage-probe");}catch{const values=new Map();const store={get length(){return values.size;},key:index=>Array.from(values.keys())[index]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>values.set(String(key),String(value)),removeItem:key=>values.delete(String(key)),clear:()=>values.clear()};Object.defineProperty(window,name,{value:store,configurable:true});}}})();</script>';
    return html.replace(/<head\b[^>]*>/i, (match) => match + storage);
  }
  // Opened on its own (not in the studio), the page shows a small corner with "i"; on hover or focus it says what is
  // shown (documentation 4.3). It never covers or moves the page.
  const text = (label || 'SiteTiller').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
  return html.replace(
    /<body([^>]*)>/i,
    '<body$1><div data-sitetiller-preview-banner tabindex="0" role="note" aria-label="' +
      text +
      '"><style>[data-sitetiller-preview-banner]{position:fixed;top:0;right:0;z-index:999999;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:24px;min-width:24px;padding:0 7px;border-bottom-left-radius:10px;background:rgba(255,216,77,.85);color:#161616;font:600 13px/24px sans-serif;cursor:default}[data-sitetiller-preview-banner] b{font:italic 700 14px/24px Georgia,serif}[data-sitetiller-preview-banner] span{display:none;white-space:nowrap}[data-sitetiller-preview-banner]:hover span,[data-sitetiller-preview-banner]:focus span{display:inline}</style><b aria-hidden="true">i</b><span>' +
      text +
      '</span></div><script>(()=>{if(window.self!==window.top)document.currentScript.previousElementSibling.remove();document.currentScript.remove();})();</script>',
  );
}

// What a preview shows, for its corner: the current draft, a step, a published version, a saved draft or a shared link.
export async function previewLabel(project: { root: string }, commit: string, share = false) {
  const { readFile } = await import('node:fs/promises'),
    { join } = await import('node:path'),
    { translate } = await import('../../../packages/i18n/index.mjs');
  let language = 'cs',
    config: any = {},
    drafts: any[] = [],
    head = '';
  try {
    language = JSON.parse(await readFile(process.env.SITETILLER_SHARED_SETTINGS_FILE || '', 'utf8')).language || 'cs';
  } catch {}
  const t = (key: string, params?: Record<string, unknown>) => translate(key, language, params);
  try {
    config = JSON.parse(await readFile(join(project.root, '..', 'config.json'), 'utf8'));
  } catch {}
  try {
    drafts = JSON.parse(await readFile(join(project.root, '..', 'saved-drafts.json'), 'utf8'));
  } catch {}
  try {
    head = (await readFile(join(project.root, '.git', 'HEAD'), 'utf8')).trim();
    const ref = head.match(/^ref: (.+)$/)?.[1];
    if (ref) head = (await readFile(join(project.root, '.git', ref), 'utf8')).trim();
  } catch {}
  const release = (config.releases || []).findLast((r: any) => r.commit === commit),
    draft = drafts.find((d: any) => d.commit === commit),
    step = (config.requests || []).findLast((r: any) => r.commit === commit && ['ready', 'legacy'].includes(r.status));
  const name = release
    ? t('preview_badge_release', { version: release.number + (release.minor !== undefined ? '.' + release.minor : '') })
    : draft
      ? t('preview_badge_saved', { name: draft.name })
      : commit === head && !share
        ? t('preview_badge_draft')
        : step
          ? t('preview_badge_step', { step: step.sequence })
          : t('preview_badge_version');
  // A shared link says what it shows like the studio, without the commit (documentation 4.10); being frozen, it is
  // never the current draft.
  return t('preview_badge', { name }) + (commit && !share ? ' · ' + commit.slice(0, 8) : '');
}
