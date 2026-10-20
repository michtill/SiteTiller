import type { IncomingMessage, ServerResponse } from 'node:http';
import { liveCms } from './cms-live.ts';
export type FormField = {
  name: string;
  label: string;
  type: 'text' | 'email' | 'textarea' | 'checkbox';
  required?: boolean;
  maxLength?: number;
};
export type FormDefinition = {
  label: string;
  fields: FormField[];
  replyTo?: string;
  recipientFromCms?: { collection: string; record: string; field: string };
};
const id = /^[a-zA-Z][\w-]{0,63}$/;
export function formDefinitions(files: Record<string, string>): Record<string, FormDefinition> {
  const source = files['site/forms.json'];
  if (!source) return {};
  if (Buffer.byteLength(source) > 32000) throw Error('forms.json je příliš velký.');
  const value = JSON.parse(source);
  if (
    value?.version !== 1 ||
    !value.forms ||
    typeof value.forms !== 'object' ||
    Array.isArray(value.forms) ||
    Object.keys(value.forms).length > 20
  )
    throw Error('Neplatná definice formulářů.');
  for (const [key, form] of Object.entries(value.forms) as [string, FormDefinition][]) {
    if (
      !id.test(key) ||
      !form ||
      typeof form.label !== 'string' ||
      !form.label.trim() ||
      form.label.length > 200 ||
      /[\r\n]/.test(form.label) ||
      !Array.isArray(form.fields) ||
      !form.fields.length ||
      form.fields.length > 20
    )
      throw Error('Neplatný formulář ' + key + '.');
    const names = new Set<string>();
    for (const f of form.fields) {
      if (
        !f ||
        !id.test(f.name) ||
        f.name === '_website' ||
        names.has(f.name) ||
        typeof f.label !== 'string' ||
        !f.label.trim() ||
        f.label.length > 200 ||
        !['text', 'email', 'textarea', 'checkbox'].includes(f.type) ||
        (f.required !== undefined && typeof f.required !== 'boolean') ||
        (f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 10000))
      )
        throw Error('Neplatné pole formuláře ' + key + '.');
      names.add(f.name);
    }
    if (form.replyTo !== undefined && !form.fields.some((f) => f.name === form.replyTo && f.type === 'email'))
      throw Error('replyTo musí odkazovat na e-mailové pole.');
    const ref = form.recipientFromCms;
    if (
      ref &&
      (!id.test(ref.collection) ||
        !id.test(ref.field) ||
        typeof ref.record !== 'string' ||
        !ref.record ||
        ref.record.length > 1000 ||
        Object.keys(ref).some((k) => !['collection', 'record', 'field'].includes(k)))
    )
      throw Error('Neplatný odkaz na příjemce z CMS.');
    if (Object.keys(form).some((k) => !['label', 'fields', 'replyTo', 'recipientFromCms'].includes(k)))
      throw Error('Formulář nesmí obsahovat přímou adresu příjemce ani nastavení doručování.');
  }
  return value.forms;
}
export const formCapability = {
  endpoint: '/__sitetiller/forms/{id}.php',
  definition: 'site/forms.json',
  version: 1,
  preview: 'validation-only; no email delivery',
  production:
    'static website: generated PHP script sending mail through the hosting; SiteTiller website runtime: SMTP configured by owner',
  contract:
    'Create site/forms.json as {version:1,forms:{contact:{label:"Contact",replyTo:"email",fields:[{name:"name",label:"Name",type:"text",required:true,maxLength:200},{name:"email",label:"Email",type:"email",required:true},{name:"message",label:"Message",type:"textarea",required:true,maxLength:5000}]}}}. Supported types: text,email,textarea,checkbox. Render accessible HTML form action="/__sitetiller/forms/contact.php" method="post". Use JS to POST JSON to form.action and inspect response.ok plus JSON {ok,preview,message,errors}; never claim an email was sent when preview=true. Include hidden honeypot input name="_website", keep it empty. Checkbox values must be boolean or strings true/false. Only declared fields are accepted. No file attachments. Browser checks use the same validation in preview mode. Use this built-in capability when asked for a contact form; do not require an external endpoint or credentials. Use recipientFromCms:{collection:"content",record:"email",field:"content"} inside the form definition when the recipient is stored in CMS; inspect actual schema/data to choose the correct collection, record key and field, never assume those names. The server reads the current CMS recipient at submission time; the visitor cannot override it. Without recipientFromCms, host MAIL_TO is the fallback. SMTP from/credentials belong to host environment, never generated files or model context. If production delivery is unconfigured, create and test the form and disclose the one-time mail setup requirement.',
};
type Mail = { subject: string; text: string; replyTo?: string; to?: string };
export async function recipientFromCms(form: FormDefinition, files: Record<string, string>, live = true) {
  const ref = form.recipientFromCms;
  if (!ref) return undefined;
  const load = async (path: string) => {
    const current = live ? await liveCms(path) : null;
    if (current) {
      if (current.status !== 200) throw Error('Missing CMS');
      return JSON.parse(current.body.toString('utf8'));
    }
    return JSON.parse(files['site/' + path] || 'null');
  };
  const schema = await load('cms/structure.json'),
    def = schema?.lists?.[ref.collection];
  if (!def?.columns?.[ref.field] || !def.columns[def.key]) throw Error('Missing CMS field');
  const rows = await load('cms/data/' + ref.collection + '.json');
  if (!Array.isArray(rows)) throw Error('Missing CMS data');
  const matching = rows.filter((r) => r[def.key] === ref.record);
  if (matching.length !== 1) throw Error('Ambiguous recipient');
  const address = matching[0][ref.field];
  if (typeof address !== 'string' || !validAddress(address.trim())) throw Error('Invalid recipient');
  return address.trim();
}
const validAddress = (value: string) => /^[^\s@\r\n,;<>]+@[^\s@\r\n,;<>]+\.[^\s@\r\n,;<>]+$/.test(value);
type Options = { preview: boolean; origin?: string; deliver?: (mail: Mail) => Promise<void> };
const limits = new Map<string, { count: number; until: number }>();
export async function serveForm(
  req: IncomingMessage,
  res: ServerResponse,
  relative: string,
  files: Record<string, string>,
  options: Options,
) {
  // <id>.php is the address on a static website (a generated PHP script); <id> is its older form.
  const match = relative.match(/^__sitetiller\/forms\/([a-zA-Z][\w-]{0,63})(?:\.php)?$/);
  if (!match) return false;
  const json = (status: number, value: any) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
    return true;
  };
  let form: FormDefinition;
  try {
    form = formDefinitions(files)[match[1]];
  } catch {
    return json(503, { ok: false, message: 'Formulář není správně nastavený.' });
  }
  if (!form) return json(404, { ok: false, message: 'Formulář neexistuje.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(405, { ok: false, message: 'Použijte odeslání formuláře.' });
  }
  const origin = req.headers.origin;
  // Studio sandbox has opaque origin; allow it only in validation-only previews.
  if (origin === 'null' ? !options.preview : !origin || origin !== options.origin)
    return json(403, { ok: false, message: 'Nepovolený původ požadavku.' });
  const now = Date.now(),
    remote = (options.origin || 'site') + '|' + (req.socket.remoteAddress || 'unknown');
  for (const [key, v] of limits) if (v.until < now) limits.delete(key);
  const slot = limits.get(remote) || { count: 0, until: now + 600000 };
  if (limits.size >= 10000 && !limits.has(remote)) return json(429, { ok: false, message: 'Zkuste to později.' });
  limits.set(remote, slot);
  if (++slot.count > 10) return json(429, { ok: false, message: 'Příliš mnoho pokusů. Zkuste to později.' });
  const mime = req.headers['content-type']?.split(';')[0];
  if (!['application/json', 'application/x-www-form-urlencoded'].includes(mime || ''))
    return json(415, { ok: false, message: 'Nepodporovaný formát.' });
  let text = '',
    bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32000) return json(413, { ok: false, message: 'Zpráva je příliš dlouhá.' });
      text += chunk;
    }
  } catch {
    return json(400, { ok: false, message: 'Neplatná zpráva.' });
  }
  let input: any;
  try {
    if (mime === 'application/json') input = JSON.parse(text);
    else {
      const params = new URLSearchParams(text);
      if ([...params.keys()].some((k) => params.getAll(k).length > 1)) throw Error();
      input = Object.fromEntries(params);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  } catch {
    return json(400, { ok: false, message: 'Neplatná zpráva.' });
  }
  if (input._website) return json(400, { ok: false, message: 'Zprávu nelze přijmout.' });
  if (Object.keys(input).some((k) => k !== '_website' && !form.fields.some((f) => f.name === k)))
    return json(422, { ok: false, message: 'Formulář obsahuje neznámá pole.' });
  const errors: Record<string, string> = {},
    values: Record<string, string> = {};
  for (const f of form.fields) {
    const raw = input[f.name] ?? (f.type === 'checkbox' ? false : '');
    if (f.type === 'checkbox') {
      if (![true, false, 'true', 'false'].includes(raw)) errors[f.name] = 'Vyberte ano/ne.';
      values[f.name] = raw === true || raw === 'true' ? 'true' : 'false';
      if (f.required && values[f.name] !== 'true') errors[f.name] = 'Zaškrtněte toto pole.';
    } else {
      if (typeof raw !== 'string') {
        errors[f.name] = 'Vyplňte text.';
        continue;
      }
      const v = raw.trim();
      values[f.name] = v;
      if (f.required && !v) errors[f.name] = 'Vyplňte toto pole.';
      if (v.length > (f.maxLength ?? (f.type === 'textarea' ? 5000 : 500))) errors[f.name] = 'Text je příliš dlouhý.';
      if (f.type === 'email' && v && !/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(v))
        errors[f.name] = 'Vyplňte platný e-mail.';
    }
  }
  if (Object.keys(errors).length) return json(422, { ok: false, message: 'Zkontrolujte vyplněná pole.', errors });
  if (options.preview)
    return json(200, {
      ok: true,
      preview: true,
      message: 'Testovací odeslání proběhlo. E-mail se v náhledu neodesílá.',
    });
  try {
    const to = await recipientFromCms(form, files);
    await (options.deliver || smtpDelivery)({
      to,
      subject: form.label,
      text: form.fields
        .map(
          (f) =>
            f.label + ':\n' + (f.type === 'checkbox' ? (values[f.name] === 'true' ? 'Ano' : 'Ne') : values[f.name]),
        )
        .join('\n\n'),
      replyTo: form.replyTo ? values[form.replyTo] || undefined : undefined,
    });
    return json(200, { ok: true, preview: false, message: 'Zpráva byla odeslána.' });
  } catch {
    return json(503, {
      ok: false,
      message: 'Zprávu se nepodařilo odeslat. Zkuste to později nebo použijte přímý kontakt.',
    });
  }
}
export async function smtpDelivery(mail: Mail) {
  const env = process.env,
    host = env.SITETILLER_SMTP_HOST,
    from = env.SITETILLER_MAIL_FROM,
    to = mail.to || env.SITETILLER_MAIL_TO;
  if (!host || !from || !to || !validAddress(from) || !validAddress(to)) throw Error('Mail is not configured');
  const port = Number(env.SITETILLER_SMTP_PORT || 587);
  const localRelay = port === 25 && ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (![465, 587].includes(port) && !localRelay) throw Error('Unsupported SMTP port');
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: !localRelay,
    ignoreTLS: localRelay,
    auth: env.SITETILLER_SMTP_USER ? { user: env.SITETILLER_SMTP_USER, pass: env.SITETILLER_SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({ ...mail, from, to });
    if (!result.accepted?.length || result.rejected?.length) throw Error('Mail rejected');
  } finally {
    transport.close();
  }
}
