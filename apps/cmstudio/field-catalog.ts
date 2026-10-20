/** Shared, instance-free source for the Editor selector, CM validation and Studio catalog. */
export const fieldLimits = {
  collections: 100,
  rowsPerCollection: 10000,
  valueLength: 300000,
  regexLength: 2000,
  valuePatternLength: 500,
};
export const fieldWidths = ['full', 'half', 'third'];
export const textPatternTypes = ['text', 'short_text', 'textarea', 'long_text'];
export const fieldAliases = { short_text: 'text', long_text: 'textarea', media: 'file' } as const;
const definition = (
  type: string,
  label: string,
  purpose: string,
  properties: Record<string, unknown>,
  valueRules: Record<string, unknown>,
  defaults: Record<string, unknown> = { missingValue: '' },
  readonlyRules: Record<string, unknown> = {
    editor: 'editable on creation; readonly locks saved records',
    backend: 'ordinary readonly is an Editor control; not a general backend write prohibition',
  },
) => ({ type, label, purpose, properties, valueRules, defaults, readonlyRules });
export const canonicalFields = [
  definition(
    'generated',
    'Generovaná hodnota',
    'Server-generated numbered value or editable custom value.',
    {
      valuePattern: {
        kind: 'string',
        required: true,
        contains: '#',
        maxLength: fieldLimits.valuePatternLength,
        controlCharacters: false,
      },
      default: { allowed: false },
      pattern: { allowed: false },
    },
    {
      shape: 'string',
      number: 'positive BigInt',
      padding: 'each # run is minimum zero-padding; never truncate',
      multipleRuns: 'same number in every run',
      allocation: 'only successful creation commits spend numbers; dryrun/preview do not',
      editableOverride:
        'readonly:false (always) or editableOnCreate:true (new records only) permits custom strings; consume only blank/exact proposal or full decimal digit token numerically equal to proposed number',
      identity: 'original stable collection key; existing editable non-key changes do not allocate',
      uniqueness:
        'explicit duplicate collection keys rejected; automatic key values skip occupied values; no universal uniqueness on non-key fields',
      history:
        'monotonic private high-water does not rewind on delete/discard/restore; concrete imported values scan except tracked non-consuming manual values',
    },
    {
      missingValue: 'allocate on new record; no silent existing-row backfill',
      editorReadonly: true,
      editorValuePattern: '<collectionCode>-####',
    },
    {
      editor:
        'readonly:true or unspecified locks also during creation unless editableOnCreate:true (then editable when the record is created, locked afterwards); readonly:false permits edits',
      backend: 'same generated allocation/override rules for normal and AI writes; frozen restore preserves values',
    },
  ),
  definition(
    'checkbox',
    'Zaškrtávátko ano/ne',
    'Yes/no choice.',
    { default: { kind: 'string', enum: ['true', 'false'] } },
    { shape: 'string', enum: ['', 'true', 'false'], notBoolean: true },
    { missingValue: 'false' },
  ),
  definition(
    'text',
    'Jednořádkový text',
    'One-line plain text.',
    {
      pattern: {
        kind: 'string',
        maxLength: fieldLimits.regexLength,
        syntax: 'Unicode regular expression without delimiter; full value match',
      },
    },
    { shape: 'string' },
  ),
  definition(
    'textarea',
    'Víceřádkový text',
    'Multiline plain text.',
    {
      pattern: {
        kind: 'string',
        maxLength: fieldLimits.regexLength,
        syntax: 'Unicode regular expression without delimiter; full value match',
      },
    },
    { shape: 'string' },
  ),
  definition(
    'markdown',
    'Formátovaný obsah (Markdown)',
    'Formatted text in Markdown; replaces the suppressed html type for new fields.',
    {},
    {
      shape: 'string',
      syntax:
        'CommonMark + GFM tables: ## to #### headings, **bold**, *italic*, [link](https://…), - and 1. lists, > quote, --- divider, tables, ![alt](folder/file) images from schema folders; no raw HTML (not rendered)',
      render: 'templates use {{markdown field}}',
    },
  ),
  definition(
    'html',
    'HTML obsah',
    'Rich text HTML. Suppressed: not offered for new fields; existing fields keep working. Use markdown for new fields.',
    {},
    {
      shape: 'string',
      suppressed: true,
      editorSave: 'DOMPurify sanitation in Editor; do not infer universal backend HTML sanitization',
    },
  ),
  definition(
    'list',
    'Odkaz na kolekci',
    'Single relation to a schema-defined collection.',
    { list: { kind: 'identifier', required: true, reference: 'schema.lists' } },
    {
      shape: 'string',
      value: 'target row[targetCollection.key], NOT label/index or assumed code/id',
      targetMustExist: true,
      emptyAllowedUnlessRequired: true,
    },
  ),
  definition(
    'file',
    'Soubor ze složky',
    'File path from a schema-defined media folder.',
    { folder: { kind: 'identifier', required: true, reference: 'schema.folders' } },
    {
      shape: 'string',
      value:
        'canonical folder/filename or nested path; existing resolver also accepts URL path prefixes containing the declared folder segment',
      fileMustExist: true,
      plannedAssetsAccepted: true,
      restore: 'frozen asset must be supplied; no missing historical files',
      folderTypes: ['img', 'other'],
      pathResolution:
        'declared folder segment plus remaining path is resolved under instance media; traversal/colon/backslash/empty segments rejected',
    },
  ),
  definition('color', 'Barva', 'RGB color.', {}, { shape: 'string', nonemptyPattern: '^#[0-9a-fA-F]{6}$' }),
  definition(
    'url',
    'Webová adresa',
    'HTTP/HTTPS URL.',
    {},
    { shape: 'string', nonemptyProtocols: ['http:', 'https:'] },
  ),
  definition(
    'email',
    'E-mail',
    'Email address.',
    {},
    { shape: 'string', nonemptyPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
  ),
  definition(
    'number',
    'Číslo',
    'Finite numeric value stored as text.',
    {},
    { shape: 'string', nonempty: 'non-whitespace and Number(value) is finite; not JSON number' },
  ),
  definition(
    'date',
    'Datum',
    'Calendar date.',
    {},
    { shape: 'string', format: 'YYYY-MM-DD', nonempty: 'valid exact calendar date, no overflow normalization' },
  ),
  definition(
    'time',
    'Čas',
    'Time of day.',
    {},
    { shape: 'string', format: 'HH:mm or HH:mm:ss', hours: [0, 23], minutes: [0, 59], seconds: [0, 59] },
  ),
];
export const fieldTypeLabels: Record<string, string> = Object.fromEntries(
  canonicalFields.map((f) => [f.type, f.label]),
);
export const supportedFieldTypes = [...canonicalFields.map((f) => f.type), ...Object.keys(fieldAliases)];
export const fieldCatalog = {
  version: 1,
  types: canonicalFields,
  aliases: fieldAliases,
  commonProperties: {
    type: { kind: 'string', required: true, enum: supportedFieldTypes },
    label: { kind: 'string', required: true, nonemptyTrimmed: true },
    hint: { kind: 'string', purpose: 'Editor help', schemaEnforced: false },
    width: { kind: 'string', enum: fieldWidths, editorDefault: 'full' },
    required: { kind: 'boolean', rowRule: 'trimmed value nonempty when true; collection key independently nonempty' },
    readonly: { kind: 'boolean', meaning: 'see type readonlyRules; not a published-source permission flag' },
    editableOnCreate: {
      kind: 'boolean',
      meaning: 'generated fields only, with readonly: the value can be given when a record is created',
    },
    maxlen: { kind: 'integer', minimum: 1, maximum: fieldLimits.valueLength, rowDefault: fieldLimits.valueLength },
    default: {
      kind: 'string',
      except: ['generated', 'html', 'list', 'file', 'media', 'date', 'time'],
      markdown: 'a Formatted content default is Markdown like the value',
      exceptRule: 'a default for these types is not kept when the structure is saved',
      checkboxEnum: ['true', 'false'],
      rowRule: 'missing/null value uses default; adding field migrates missing existing values',
      schemaCheck:
        'checked like a value of the field when the structure is saved (number, #RRGGBB color, http(s) URL, e-mail, length, pattern); also when planning rows',
    },
  },
  collectionRules: {
    shape:
      'structure.json = {version, lists:{<collection id>:{label, key, columns:{<field id>:{type, label, ...}}, display?, group?}}, folders:{}}; the fields of a collection go in "columns" (not "fields")',
    version: { kind: 'integer', minimum: 1 },
    identifiers: { pattern: '^[a-zA-Z][\\w-]{0,63}$', forbidden: ['constructor', 'prototype', '__proto__'] },
    key: 'must name existing field; nonempty unique string per collection; explicit duplicates fail422 with label/value; referenced keys cannot be removed/renamed',
    display: 'existing column name or array of existing column names',
    group: 'array of existing column names',
    folders:
      'schema.folders maps identifiers to {label:nonempty string,type:img|other,maxSizeMb?:integer 1-100 (largest file; absent = 20 MB)}',
    unknownFieldProperties:
      'preserved; current schema validator does not reject every unknown or irrelevant property; listed properties are supported contract',
    textPattern: 'pattern accepted only by text/textarea and their aliases; all nonempty matches cover full value',
    settings: 'private Editor/common settings must not be put in schema',
    migration:
      'populated fields/collections and nonempty folders cannot be deleted; default/relations/required/assets rules validated against joint planned rows',
    aiWrites:
      'working unpublished content permission required in Studio; CAS + shared CM APIs, never published snapshot mutation',
  },
  limits: fieldLimits,
};
