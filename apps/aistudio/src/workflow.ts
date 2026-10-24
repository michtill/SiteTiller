import { providerIds } from '../../../packages/providers/index.mjs';
import { prepareFinalAnswer, hostAnswer, primaryFinalContract, type ResponseLanguage } from './final-answer.ts';
import { stepChanges } from './step-changes.ts';
import { verificationOutcome, outcomeWarnings } from './verification-outcome.ts';
import { sharedModuleContext } from './shared-modules.ts';
import { webRequestIntent, readPublicSource, prepareSourceContent, type SourceEvidence } from './web-source.ts';
import { expandTextEdits } from './text-edits.ts';
import { historyContentSnapshot } from './cms-history-snapshot.ts';
import { rememberImage, rememberedImages, collectionImageRequest } from './design-image-cache.ts';
import { throwIfStopped } from './run-control.ts';
import { stageContentFiles } from './cms-content-files.ts';
import { contentBaseline, applyDesignContent, normalizeContentPlan } from './cms-content-write.ts';
import { designCmsSource } from './cms-design-source.ts';
import { renderingCapability } from './cms-render.ts';
import { requestChecks } from './request-checks.ts';
import { formCapability } from './contact-forms.ts';
import { cmsSource, assertCmsChanges, refreshCmsCandidate } from './cms-source.ts';
import { attachmentPaths } from './attachment-paths.ts';
import { cleanImages } from './image-cleanup.ts';
import { importWebsite, requestedUrl } from './web-import.ts';
import { validateBrowserTests, browserTestContract } from './browser-scenarios.ts';
import { withRules } from './instructions.ts';
import { routeTask, editContract } from './orchestrator.ts';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSitePath, type Slot, type Provider } from './core.ts';
import { clientFor, initialTeam, initialImages, type Team, type Role, type ImageChoices } from './team.ts';
import { callModel } from './providers.ts';
import { Project } from './project.ts';
import { editImage, generateImage, websiteImages, capabilityImage, imageProvider } from './image-editor.ts';
import { raster, binaryAsset } from './images.ts';
import { projectManifest, initialContext, selectContext } from './manifest.ts';
import { staticChecks, browserChecks } from './checks.ts';
import { smallStyleChange } from './check-scope.ts';
import { changeMemory } from './memory.ts';
export type ReturnTypeClient = ReturnType<typeof clientFor>;
export type Scope = 'edit' | 'redesign' | 'create';
type Options = {
  responseLanguage?: ResponseLanguage;
  cmsSource?: 'published' | 'unpublished';
  requestChecks?: { technical: boolean; verification: boolean };
  webImport?: typeof importWebsite;
  webSource?: typeof readPublicSource;
  cleanup?: (path: string) => Promise<void>;
  reasoningEffort?: 'auto' | 'low' | 'medium' | 'high';
  mode?: Scope;
  conversation?: any;
  history?: (query: any) => Promise<any> | any;
  publication?: () => { publishedCommit: string | null };
  model?: string | null;
  call?: typeof editImage;
  generate?: typeof generateImage;
  imageModels?: ImageChoices;
  availableModels?: { provider: string; id: string; usable: boolean }[];
  check?: typeof browserChecks;
};
const specialistInstruction = withRules(
  'ui',
  'Implement the bounded UI/CODE task. Do not add a planning round or re-analyze the project. In edit scope preserve existing behavior and unrelated content; respect its design system. In create scope build from the new brief without inheriting old content or design; obsolete text files have already been removed from the candidate. In redesign scope replace the requested design and structure. Request exact missing paths only when necessary. Return changed files and concrete required checks. ' +
    editContract,
);
const escalationInstruction = withRules(
  'escalation',
  'First act as adjudicator: determine whether the failure belongs to implementation, browser scenario, or verifier judgment. Only then act as executor when a real repair is necessary. You may repair files, replace browserTests, use image/web tools, or return action="verify" to repeat verification of the unchanged candidate. verify must not contain file changes. After escalation the configured escalation model performs authoritative read-only verification instead of the ordinary verifier. Do not weaken the original user requirements, fabricate evidence, waive deterministic failures, expand scope or select models. Use supplied failures and evidence; read additional files only when needed. ' +
    editContract,
);
const verifierInstruction = withRules(
  'verify',
  'Verify only necessary requirements against the original request, acceptance, changed files and deterministic test/screenshot evidence. No edits or optional improvements. Browser interactions are actual executed open/close tests, including aria-expanded and visibility. testResults.publication is trusted runtime evidence: this isolated workflow cannot invoke publishing, and the captured published commit must remain unchanged. Accept this evidence for draft-only requirements; do not request content edits to prove an operation controlled by the host. For image transparency use trusted testResults.browser.imageEvidence from decoded pixels, not filenames or visual guessing. hasTransparentPixels=true establishes actual non-opaque pixels; still assess the requested subject and composition visually. Return JSON {status:"PASS"|"FAIL",requiredFixes:string[],warnings:string[],technicalFindings?:[{message:string,path:string,evidence:string}]}. Block only concrete technical defects supported by exact candidate source evidence in technicalFindings (path and literal code excerpt proving the defect). Missing evidence, unexecuted/failed model-written scenarios, appearance or user-requirement judgments belong in warnings, never blocking requiredFixes. A failed assertion alone is not proof of a technical defect. Unknown is success with an explicit warning, not proof that the requirement passed.',
);
function acceptance(value: any) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 40 ||
    value.some(
      (c) =>
        !c ||
        typeof c.id !== 'string' ||
        !c.id ||
        !['required', 'preference'].includes(c.category) ||
        typeof c.description !== 'string' ||
        typeof c.basis !== 'string' ||
        !c.basis.trim(),
    ) ||
    new Set(value.map((c) => c.id)).size !== value.length
  )
    throw Error('Neplatná akceptační kritéria.');
  return value;
}
function assertAvailable(team: Team, role: Role, options: Options) {
  const choice = team[role];
  if (
    options.availableModels &&
    !options.availableModels.some((m) => m.provider === choice.provider && m.id === choice.model && m.usable)
  )
    throw Error(role + ': nakonfigurovaný model není dostupný.');
}
export async function workflow(
  project: Project,
  slots: Slot[],
  prompt: string,
  draftRoot: string,
  emit: (event: any) => void,
  modelCall = callModel,
  team: Team = initialTeam(slots),
  images: any[] = [],
  options: Options = {},
) {
  const responseLanguage = options.responseLanguage || 'cs';
  const prepareAnswer = (role: string, value: any, summary: string, facts: any[] = []) =>
    prepareFinalAnswer({
      language: responseLanguage,
      role,
      value,
      summary,
      facts,
      client: clientFor(team, keys, 'primary'),
      modelCall,
    });
  const answer = (finalAnswer: string, scope: Scope = 'edit', resolvedRequest = prompt, memory: any = {}) => {
    emit({ stage: 'final-answer', status: 'completed', message: finalAnswer, agentResponse: true });
    emit({ stage: 'ready' });
    return {
      conversationOnly: true,
      finalAnswer,
      commit: null,
      baseCommit,
      scope,
      resolvedRequest,
      memory: { ...memory, summary: finalAnswer },
      plan: { summary: finalAnswer },
      imageResults: [],
      tests: null,
      review: null,
    };
  };
  const enabledChecks = requestChecks(options.requestChecks);
  const webIntent = webRequestIntent(prompt, options.conversation);
  images = images.map((i) => (i.use === 'auto' ? { ...i, use: 'website', automaticUse: true } : i));
  const keys = Object.fromEntries(
    providerIds.map((provider) => [provider, slots.find((s) => s.provider === provider && s.key)?.key || '']),
  ) as Record<Provider, string>;
  const original = await project.files(),
    baseCommit = await project.head(),
    manifest = await projectManifest(project, original);
  const contentAssets: any[] = [];
  const cms = await designCmsSource(options.cmsSource);
  const contentBase = await contentBaseline(cms);
  const blockedContent = () => answer(hostAnswer('readonly', responseLanguage));
  if (collectionImageRequest(prompt, cms?.context)) return blockedContent();
  const imageCacheDirectory = join(draftRoot, '..', 'generated-images'),
    cachedImages = await rememberedImages(imageCacheDirectory);
  const contentSnapshot = cms
    ? await historyContentSnapshot(cms.historySource.root, cms.historySource.publishedLayout, cms)
    : { files: {}, binary: {} };
  const initialPublication = options.publication?.();
  const requestedEffort = options.reasoningEffort === 'auto' ? undefined : options.reasoningEffort;
  if (options.reasoningEffort && !['auto', 'low', 'medium', 'high'].includes(options.reasoningEffort))
    throw Error('Neplatná míra uvažování.');
  let scope: Scope = options.mode || 'edit';
  if (!['edit', 'redesign', 'create'].includes(scope)) throw Error('Neplatný rozsah změny.');
  let files =
      scope === 'create'
        ? Object.fromEntries(Object.entries(original).filter(([path]) => raster(path)))
        : { ...original },
    context = scope === 'create' ? {} : initialContext(original),
    role: Role = 'primary',
    feedback: any = null,
    task = webIntent.effectiveRequest,
    resolvedRequest = webIntent.effectiveRequest,
    effort: 'low' | 'medium' | 'high' =
      requestedEffort || (team.primary.reasoningEffort === 'auto' ? 'low' : team.primary.reasoningEffort) || 'low';
  let needsVerification = scope !== 'edit',
    failures = 0,
    readRounds = 0,
    historyRounds = 0,
    escalationCalls = 0,
    protocolRepairs = 0,
    staged = false,
    finalSummary = '',
    plan: any = { summary: '', steps: [], acceptance: [] };
  let imported: any = null,
    imageCleanup: any = null;
  const importedBinary: Record<string, Buffer> = { ...(cms?.binary || {}), ...contentSnapshot.binary };
  let webRounds = 0,
    sourceRounds = 0,
    sourceRepairs = 0;
  const sources: SourceEvidence[] = [],
    sourceReviews: any[] = [];
  if (cms) {
    for (const target of [files, context])
      for (const path of Object.keys(target)) if (path.startsWith('site/cms/')) delete target[path];
  }
  Object.assign(files, cms?.files || {}, contentSnapshot.files);
  Object.assign(context, cms?.files || {});
  for (const image of cachedImages) {
    if (!Object.hasOwn(files, image.path)) {
      files[image.path] = '[Binary image asset]';
      context[image.path] = '[Previously generated image; reusable without generation]';
      importedBinary[image.path] = image.bytes;
    }
  }
  if (scope !== 'create' && Object.hasOwn(original, 'site/architecture.txt'))
    context['site/architecture.txt'] = original['site/architecture.txt'];
  const observed = new Set(Object.keys(context)),
    historyResults: any[] = [];
  let browserTests: any[] = [],
    lastCheckImages: any[] = [];
  let delegations = 0,
    scenarioRepairs = 0,
    acceptanceRepairs = 0,
    pathRepairs = 0,
    answerRepairs = 0,
    blockedRecoveries = 0;
  const generated: any[] = [],
    imageResults: any[] = [];
  const attachmentInfo = images.map(({ data, ...item }) => ({
    ...item,
    ...(item.use === 'website'
      ? { path: 'site/assets/' + item.id, publicUrl: 'assets/' + item.id, immutable: true }
      : {}),
  }));
  const attachmentPath = attachmentPaths(images);
  const existingImages = images.length ? await websiteImages(project, baseCommit, original) : [];
  let vision: any[] = [...images.filter((image) => raster(image.id)), ...existingImages];
  for (const image of images.filter((i) => i.use === 'website'))
    files['site/assets/' + image.id] = '[Binary image asset]';
  const imageChoices = options.imageModels || initialImages();
  const imageAvailable = (capability: keyof ImageChoices) => {
    const model = options.model || imageChoices[capability],
      provider = model ? imageProvider(model) || 'openai' : null;
    return (
      options.model !== null &&
      !!provider &&
      !!keys[provider] &&
      (!options.availableModels || options.availableModels.some((m) => m.provider === provider && m.id === model))
    );
  };
  for (let round = 0; round < 12; round++) {
    for (const image of images.filter((i) => i.automaticUse)) files['site/assets/' + image.id] = '[Binary image asset]';
    assertAvailable(team, role, options);
    const client = {
      ...clientFor(team, keys, role),
      reasoningEffort:
        role === 'escalation'
          ? team.escalation.reasoningEffort === 'auto'
            ? effort
            : team.escalation.reasoningEffort || 'high'
          : requestedEffort ||
            (role === 'primary' ? effort : team[role].reasoningEffort === 'auto' ? effort : team[role].reasoningEffort),
    };
    const input = {
      originalRequest: prompt,
      request: role === 'primary' ? prompt : resolvedRequest,
      resolvedRequest,
      task,
      scope,
      reasoningPreference: options.reasoningEffort || 'auto',
      roleState: {
        role,
        allowedActions:
          role === 'primary'
            ? [
                'answer',
                'implement',
                'stage',
                'read',
                'history',
                'delegate',
                'escalate',
                'image',
                'web',
                'cleanup',
                'blocked',
              ]
            : role === 'escalation'
              ? ['implement', 'stage', 'read', 'verify', 'image', 'web', 'blocked']
              : ['implement', 'stage', 'read', 'blocked'],
      },
      ...(role === 'primary'
        ? {
            finalResponseLanguage: responseLanguage,
            recentConversation: options.conversation || { currentHead: baseCommit, turns: [] },
            historyResults,
          }
        : {}),
      sharedModules: sharedModuleContext(files, original),
      manifest:
        scope === 'create'
          ? {
              ...manifest,
              newWebsite: true,
              designSystem: [],
              files: Object.keys(files).map((path) => ({
                path,
                type: raster(path) ? 'image' : path.split('.').at(-1),
              })),
            }
          : manifest,
      requestChecks: {
        ...enabledChecks,
        instruction:
          'These checks were explicitly selected by the user. Do not override them. When technical=false do not generate browser scenarios or claim browser execution. When verification=false the host will not call the independent verifier. Skipped checks are recorded as skipped, never as successful execution.',
      },
      cms: cms?.context,
      files: context,
      acceptance: plan.acceptance,
      feedback,
      browserTests,
      imageResults,
      availableImageAssets: cachedImages.map(({ id, path, mime, prompt, originalTarget }) => ({
        id,
        path,
        mime,
        prompt,
        originalTarget,
        reusable: true,
      })),
      webImport: imported?.evidence,
      sources: sources.map(({ citationText, ...source }) => source),
      webIntent: {
        purpose: webIntent.importing ? 'import' : 'source',
        effectiveRequest: webIntent.effectiveRequest,
        contentOnly: webIntent.contentOnly,
      },
      attachments: attachmentInfo,
      capabilities: {
        contentStructure: {
          relationships: {
            type: 'list',
            targetProperty: 'list',
            value:
              'Exact target record value at schema.lists[target].key; use for related collections unless the user explicitly requests plain text',
          },
          writable: cms?.context.permissions?.schema === 'write',
          path: 'site/cms/structure.json',
          commit:
            'Owner-validated atomic schema/rows/assets after dry-run and checks; published/historical sources are read-only',
        },
        cmsRendering: renderingCapability,
        contactForms: formCapability,
        publicWebsiteImport: true,
        publicSourceRead: {
          available: true,
          maxReads: 2,
          changesPresentation: false,
          allowedHosts:
            'Only hosts named in current/active human requests; source redirects restricted to same host/www variant',
        },
        interactionTests: browserTestContract,
        imageEditing: imageAvailable('precise'),
        imageGeneration: imageAvailable('fast'),
        images: { precise: imageAvailable('precise'), fast: imageAvailable('fast') },
        editableFiles: 'static site text files',
        browser: 'isolated local smoke tests; external services blocked',
      },
      _images: [...vision, ...(role === 'escalation' ? lastCheckImages : [])],
    };
    let result: any;
    if (role === 'primary') result = await routeTask(client, input, emit, modelCall);
    else {
      if (role === 'escalation' && ++escalationCalls > 2) throw Error('Úloha překročila limit eskalace.');
      emit({
        stage: role === 'ui' ? 'design' : 'escalation',
        status: 'running',
        message: role === 'ui' ? 'Provádím větší úpravu webu.' : 'Posuzuji příčinu chyby a potřebný další krok.',
        provider: client.provider,
        model: client.model,
      });
      result = await modelCall(client, role === 'ui' ? specialistInstruction : escalationInstruction, input);
    }
    const value = result?.value;
    if (value?.textEdits !== undefined) {
      if (!['stage', 'implement'].includes(value.action))
        throw Error('Dílčí změny jsou dostupné pouze pro stage/implement.');
      try {
        value.files = expandTextEdits(value, files, observed);
      } catch (e: any) {
        if (++pathRepairs > 2) throw e;
        feedback = {
          ...feedback,
          requiredFixes: [...(feedback?.requiredFixes || []), e.message],
          instruction:
            'Exact edits were rejected atomically; candidate is unchanged. Read the current candidate and correct the unique match or delimiters. Do not repeat full large files.',
        };
        if (role === 'escalation') escalationCalls--;
        continue;
      }
    }
    if (
      cms?.context.readOnly &&
      value &&
      (value.requiresContentWrite === true ||
        value.files?.some(
          (item: any) => item.path?.startsWith('site/cms/data/') || item.path === 'site/cms/structure.json',
        ) ||
        value.contentFiles?.length ||
        value.imageEdits?.some((image: any) => image.purpose === 'content'))
    )
      return blockedContent();
    if (cms && value) assertCmsChanges(value, cms.context);
    if (
      !value ||
      ![
        'answer',
        'implement',
        'stage',
        'read',
        'history',
        'delegate',
        'escalate',
        'image',
        'web',
        'blocked',
        'verify',
        'cleanup',
      ].includes(value.action)
    )
      throw Error('Agent nevrátil platnou akci.');
    if (value.action === 'cleanup') {
      if (!['primary', 'escalation'].includes(role))
        throw Error('Úklid může vyžádat pouze Web Lead nebo eskalační model.');
      const cleaned = await cleanImages(files, async (path) => {
        if (path.endsWith('.svg')) return Buffer.from(files[path]);
        const generatedImage = [...images.filter((i) => i.use === 'website'), ...generated].find(
          (i) => 'site/assets/' + i.id === path,
        );
        if (generatedImage) return Buffer.from(generatedImage.data, 'base64');
        return importedBinary[path] || (await project.binary(baseCommit, path));
      });
      imageCleanup = {
        removed: cleaned.removed,
        duplicates: cleaned.duplicates,
        retainedForDynamicReferences: cleaned.retainedForDynamicReferences,
      };
      files = cleaned.files;
      Object.assign(files, cms?.files || {});
      context = selectContext(
        files,
        Object.keys(context).filter((path) => Object.hasOwn(files, path)),
      );
      if (cleaned.retainedForDynamicReferences)
        emit({
          stage: 'test',
          status: 'warning',
          warnings: ['Obrázky s nejasnými dynamickými odkazy byly zachovány.'],
        });
      value.files = [];
      value.deleteFiles = [];
      staged = true;
      finalSummary =
        value.summary ||
        'Nepoužívané a totožné obrázky byly uklizeny. Vložené originály a starší verze zůstávají zachované.';
    }
    if (value.action === 'verify') {
      if (
        role !== 'escalation' ||
        (value.files !== undefined && (!Array.isArray(value.files) || value.files.length)) ||
        (value.deleteFiles !== undefined && (!Array.isArray(value.deleteFiles) || value.deleteFiles.length))
      )
        throw Error('Opakování kontroly nesmí měnit soubory a je dostupné pouze při eskalaci.');
      value.files = [];
      needsVerification = true;
    }
    if (Array.isArray(value.paths)) value.paths = value.paths.map(attachmentPath);
    if (Array.isArray(value.imageEdits))
      for (const item of value.imageEdits) if (item?.source) item.source = attachmentPath(item.source);
    const proposedPaths = [
      ...(Array.isArray(value.paths) ? value.paths : []),
      ...(Array.isArray(value.files) ? value.files.map((f: any) => f?.path) : []),
      ...(Array.isArray(value.deleteFiles) ? value.deleteFiles : []),
      ...(Array.isArray(value.imageEdits)
        ? value.imageEdits.flatMap((i: any) => [i?.source, i?.target].filter((p) => p !== undefined))
        : []),
    ];
    try {
      for (const path of proposedPaths) safeSitePath(project.root, path);
    } catch (e: any) {
      if (++pathRepairs > 2) throw Error('Nepodařilo se opravit cestu k souboru: ' + e.message);
      feedback = {
        requiredFixes: [e.message],
        proposedPaths,
        availablePaths: Object.keys(files),
        instruction:
          'Correct only the invalid file paths. All project paths begin with site/. Website attachments already exist at attachment.path; use attachment.publicUrl in HTML/CSS. Preserve the uploaded original; do not call image generation for simply placing it.',
      };
      emit({ stage: 'build', status: 'running', message: 'Opravuji odkaz na soubor.' });
      continue;
    }
    if (role === 'primary' && ['delegate', 'escalate'].includes(value.action) && value.scope === undefined) {
      if (++protocolRepairs > 1) throw Error('Web Lead neurčil rozsah před předáním úlohy.');
      feedback = {
        requiredFixes: [
          ...(feedback?.requiredFixes || []),
          'Before delegation return explicit scope edit/redesign/create and a self-contained resolvedRequest. A request to replace the whole website requires create. No implementation has been applied.',
        ],
      };
      continue;
    }
    if (value.action === 'web' && !webIntent.importing && value.scope !== undefined && value.scope !== scope) {
      if (++sourceRepairs > 2) throw Error('Zdroj informací nesmí změnit rozsah úlohy.');
      feedback = {
        ...feedback,
        requiredFixes: [
          'Reading source evidence preserves the current scope and candidate; do not select create/import.',
        ],
        instruction: 'Return web with purpose=source and unchanged scope.',
      };
      continue;
    }
    if (role === 'primary' && value.scope !== undefined) {
      if (
        !['edit', 'redesign', 'create'].includes(value.scope) ||
        (staged && value.scope !== scope) ||
        (options.mode && options.mode !== 'edit' && value.scope !== options.mode)
      )
        throw Error('Agent změnil explicitní nebo již rozpracovaný rozsah.');
      if (value.scope === 'create' && scope !== 'create') {
        files = Object.fromEntries(Object.entries(files).filter(([path]) => raster(path)));
        Object.assign(files, cms?.files || {});
        context = {};
      }
      scope = value.scope;
      if (scope !== 'edit') needsVerification = true;
    }
    if (role === 'primary' && value.resolvedRequest !== undefined) {
      if (
        typeof value.resolvedRequest !== 'string' ||
        !value.resolvedRequest.trim() ||
        value.resolvedRequest.length > 6000
      )
        throw Error('Neplatné upřesnění navazujícího požadavku.');
      resolvedRequest = value.resolvedRequest;
      task = resolvedRequest;
    }
    if (role === 'primary' && value.acceptance !== undefined) plan.acceptance = acceptance(value.acceptance);
    if (value.needsVerification === true) needsVerification = true;
    if (value.summary) finalSummary = String(value.summary);
    if (value.action === 'answer') {
      if (
        role !== 'primary' ||
        staged ||
        generated.length ||
        failures ||
        /^(?:prosím\s+)?(?:vem|vezmi|vytvoř|vytvor|udělej|udelej|uprav|změň|zmen|přidej|pridej|odstraň|odstran|vyřízni|vyrizni|dej|načti|nacti|předělej|predelej|create|make|change|edit|add|remove|build|replace|implement|redesign|load)(?=\s|[.!,:;]|$)/iu.test(
          prompt.trim(),
        ) ||
        typeof value.summary !== 'string' ||
        !value.summary.trim() ||
        value.files?.length ||
        value.deleteFiles?.length ||
        value.imageEdits?.length ||
        value.contentFiles?.length
      ) {
        if (++answerRepairs > 2) throw Error('Agent nedokončil požadovanou změnu ani po upřesnění postupu.');
        feedback = {
          ...(feedback || {}),
          requiredFixes: [
            ...(feedback?.requiredFixes || []),
            'The original request is an implementation task with a pending candidate. Do not return answer or turn it into a conversation. Return implement to finish/repair the candidate, or (escalation only) verify to adjudicate the unchanged candidate. Reuse existing generated assets and supplied evidence.',
          ],
        };
        emit({
          stage: role === 'escalation' ? 'escalation' : 'orchestrate',
          status: 'running',
          message: 'Upřesňuji postup dokončení změny.',
          model: client.model,
          provider: client.provider,
        });
        continue;
      }
      return answer(await prepareAnswer(role, value, finalSummary), scope, resolvedRequest);
    }
    if (value.action === 'blocked' && role !== 'primary' && blockedRecoveries < 2) {
      blockedRecoveries++;
      const blockedRole = role;
      role = 'primary';
      task = resolvedRequest;
      delegations = 0;
      feedback = {
        ...feedback,
        requiredFixes: feedback?.requiredFixes || [],
        specialistBlock: {
          role: blockedRole,
          reason: value.blockedReason || 'No reason supplied',
          attempt: blockedRecoveries,
        },
        instruction:
          'The specialist stopped, but the isolated candidate and findings are preserved. Complete directly using exact textEdits/extract or delegate a smaller bounded task. The 300000-byte file limit is separate from response length. Do not waive permissions or checks.',
      };
      emit({
        stage: 'orchestrate',
        status: 'running',
        message: 'Upravuji postup po překážce specialisty; rozpracované změny zůstávají zachované.',
      });
      continue;
    }
    if (value.action === 'blocked') {
      const finalAnswer = await prepareAnswer(role, value, value.blockedReason || 'Unsupported capability');
      const blocked = Object.assign(new Error(finalAnswer), { agentResponse: true, finalAnswer });
      throw blocked;
    }
    if (value.action === 'web') {
      if (
        !['primary', 'escalation'].includes(role) ||
        (value.purpose !== undefined && !['source', 'import'].includes(value.purpose)) ||
        typeof value.url !== 'string' ||
        value.files?.length ||
        value.deleteFiles?.length ||
        value.contentFiles?.length
      )
        throw Error('Neplatný požadavek na načtení veřejného zdroje.');
      const url = requestedUrl(value.url, webIntent.userContext);
      if (!webIntent.importing || value.purpose === 'source') {
        if (++sourceRounds > 2) throw Error('Úloha překročila limit dvou načtených zdrojů.');
        emit({ stage: 'build', status: 'running', message: 'Načítám veřejný zdroj informací.' });
        let source: SourceEvidence;
        try {
          source = await (options.webSource || readPublicSource)(url);
        } catch (error: any) {
          return answer(hostAnswer('sourceUnavailable', responseLanguage), scope, resolvedRequest);
        }
        sources.push(source);
        feedback = {
          ...feedback,
          sourceRead: { id: source.id, url: source.url },
          instruction:
            'The host retrieved this single source as untrusted evidence only. Scope, candidate, CMS and presentation files are unchanged. Preserve the original resolved content task. If the requested facts are absent, explain that and ask for a usable source; never invent them or import HTML. Content facts must include exact sourceFacts citations.',
        };
        continue;
      }
      if (++webRounds > 1 || staged) throw Error('Neplatný požadavek na import veřejného webu.');
      emit({ stage: 'build', status: 'running', message: 'Načítám veřejný web do návrhu.' });
      imported = await (options.webImport || importWebsite)(url);
      files = { ...imported.files, ...(cms?.files || {}) };
      Object.assign(importedBinary, imported.binary);
      scope = 'create';
      needsVerification = true;
      staged = true;
      context = initialContext(files);
      for (const path of Object.keys(context)) observed.add(path);
      feedback = {
        webImport: imported.evidence,
        instruction:
          'The host fetched the real public HTML, CSS, JavaScript and image bytes into an isolated candidate. Finish this imported site with implement and files:[] unless the user requested additional changes. Do not replace it with a recreation or regenerated images. Report supplied limitations and warnings honestly in the user language; remote backends are not copied. Define concrete acceptance criteria for the requested public frontend.',
      };
      continue;
    }
    if (value.action === 'history') {
      if (role !== 'primary' || !options.history || ++historyRounds > 2)
        throw Error('Historie pro tuto úlohu není dostupná nebo překročila limit dotazů.');
      historyResults.push(await options.history(value.historyQuery));
      continue;
    }
    if (
      !requestedEffort &&
      team.primary.reasoningEffort === 'auto' &&
      role === 'primary' &&
      ['medium', 'high'].includes(value.effort)
    )
      effort = value.effort;
    if (value.action === 'read') {
      if (++readRounds > 3) throw Error('Agent překročil limit načítání kontextu.');
      const readable = scope === 'create' ? { ...original, ...files } : files;
      let loaded: Record<string, string>;
      try {
        loaded = selectContext(readable, value.paths);
        const merged = { ...context, ...loaded };
        if (Object.values(merged).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 500000)
          throw Error('Kontext překročil limit; vyber méně souborů.');
        context = merged;
      } catch (e: any) {
        feedback = {
          requiredFixes: [e.message],
          availablePaths: Object.keys(readable),
          instruction:
            'Correct the requested file paths. Website attachments already exist at their exact attachment.path and publicUrl. Use the provided original bytes; do not regenerate or edit an uploaded image when the user only asks to place it.',
        };
        emit({ stage: 'build', status: 'running', message: 'Upřesňuji cestu k souboru.' });
        continue;
      }
      for (const path of Object.keys(loaded)) observed.add(path);
      const requestedImages = Object.keys(loaded).filter(raster);
      for (const path of requestedImages) {
        const cached = cachedImages.find((image) => image.path === path);
        if (cached && !vision.some((image) => image.path === path)) vision.push(cached);
        if (!vision.some((i) => i.path === path) && original[path])
          vision.push({
            path,
            mime: (await import('./images.ts')).imageMime(path),
            data: (await project.binary(baseCommit, path)).toString('base64'),
          });
      }
      continue;
    }
    if (value.action === 'delegate' || value.action === 'escalate') {
      if (
        role !== 'primary' ||
        ((failures > 1 || escalationCalls) && !feedback?.specialistBlock) ||
        ++delegations > 1 ||
        typeof value.task !== 'string' ||
        !value.task.trim() ||
        value.task.length > 10000
      )
        throw Error('Neplatné předání úlohy specialistovi.');
      if (value.action === 'escalate' && (typeof value.difficultyReason !== 'string' || !value.difficultyReason.trim()))
        throw Error('Eskalační úloha potřebuje konkrétní důvod obtížnosti.');
      if (!plan.acceptance.length) throw Error('Specialista potřebuje akceptační kritéria.');
      const paths = value.paths || Object.keys(context);
      if (scope === 'create') for (const path of paths) safeSitePath(project.root, path);
      try {
        if (value.paths)
          context = selectContext(
            files,
            scope === 'create'
              ? paths.filter((path: string) => Object.hasOwn(files, path) || !Object.hasOwn(original, path))
              : paths,
          );
      } catch (e: any) {
        if (++protocolRepairs > 2) throw e;
        delegations--;
        feedback = {
          requiredFixes: [e.message],
          instruction:
            'Delegate at most 30 existing explicit paths, or omit paths to reuse the already supplied context.',
        };
        continue;
      }
      for (const path of Object.keys(context)) observed.add(path);
      task = value.task;
      role = value.action === 'escalate' ? 'escalation' : 'ui';
      needsVerification = true;
      continue;
    }
    if (value.action === 'image') {
      if (!['primary', 'escalation'].includes(role))
        throw Error('Obrazový nástroj může volat pouze Web Lead nebo eskalační model.');
      if (
        !Array.isArray(value.imageEdits) ||
        !value.imageEdits.length ||
        imageResults.length + value.imageEdits.length > 10
      )
        throw Error('V jednom požadavku lze vytvořit nebo upravit nejvýše 10 obrázků.');
      // Validate the whole batch before spending on any image.
      const tasks = value.imageEdits.map((image: any) => {
        if (typeof image.prompt !== 'string' || !image.prompt.trim() || image.prompt.length > 10000)
          throw Error('Neplatné zadání obrázku.');
        if (image.source) {
          safeSitePath(project.root, image.source);
          if (!raster(image.source)) throw Error('Neplatný zdroj obrázku.');
          if (
            !original[image.source] &&
            !images.some((i) => i.use === 'website' && 'site/assets/' + i.id === image.source)
          )
            throw Error('Zdrojový obrázek není součástí webu ani webovou přílohou.');
        }
        const capability = image.capability || (image.source ? 'precise' : 'fast');
        if (!['precise', 'fast'].includes(capability)) throw Error('Neplatná obrazová capability.');
        const model =
          options.model === null
            ? null
            : options.model || capabilityImage(capability, imageChoices, options.availableModels);
        // A model that is not Gemini's goes to OpenAI, as before.
        const provider = model ? imageProvider(model) || 'openai' : null;
        if (!model || !provider || !keys[provider])
          throw Error('Obrázky potřebují dostupný obrazový model a klíč jeho poskytovatele.');
        const format =
          image.format ||
          (image.target?.endsWith('.png') ? 'png' : /\.jpe?g$/.test(image.target || '') ? 'jpeg' : 'webp');
        if (!['png', 'webp', 'jpeg'].includes(format)) throw Error('Neplatný formát obrázku.');
        if (
          (image.background !== undefined && !['auto', 'opaque', 'transparent'].includes(image.background)) ||
          (image.background === 'transparent' && format === 'jpeg')
        )
          throw Error('Průhledné pozadí vyžaduje formát PNG nebo WebP.');
        if (image.target) {
          safeSitePath(project.root, image.target);
          if (!/^site\/assets\/[a-zA-Z0-9_-]+\.(png|webp|jpe?g)$/.test(image.target) || files[image.target])
            throw Error('Cílový obrázek musí mít novou bezpečnou cestu.');
          const ext = image.target.split('.').at(-1);
          if (format === 'jpeg' ? !['jpg', 'jpeg'].includes(ext) : format !== ext)
            throw Error('Název obrázku neodpovídá formátu.');
        }
        return { ...image, model, format, provider };
      });
      if (new Set(tasks.filter((t) => t.target).map((t) => t.target)).size !== tasks.filter((t) => t.target).length)
        throw Error('Cílové cesty obrázků se opakují.');
      for (const image of tasks) {
        emit({
          stage: 'image',
          status: 'running',
          message: 'Připravuji obrázek.',
          model: image.model,
          provider: image.provider,
        });
        const uploaded = images.find((i) => i.use === 'website' && 'site/assets/' + i.id === image.source);
        const source = image.source
          ? uploaded || {
              data: (await project.binary(baseCommit, image.source)).toString('base64'),
              mime: (await import('./images.ts')).imageMime(image.source),
            }
          : null;
        const edited = source
          ? await (options.call || editImage)(keys[image.provider], image.model, source, image.prompt, undefined, {
              format: image.format,
              background: image.background,
            })
          : await (options.generate || generateImage)(keys[image.provider], image.model, image.prompt, undefined, {
              format: image.format,
              background: image.background,
            });
        // A Gemini image keeps its own format: a requested target name follows the real format (documentation 4.7).
        const real = edited.id.split('.').at(-1),
          path = image.target
            ? /\.(jpe?g)$/.test(image.target) && real === 'jpg'
              ? image.target
              : image.target.replace(/\.[a-z]+$/, '.' + real)
            : 'site/assets/' + edited.id;
        if (files[path]) throw Error('Obrázek nevytvořil samostatnou novou verzi.');
        await rememberImage(imageCacheDirectory, edited, { path, prompt: image.prompt });
        generated.push({ ...edited, id: path.slice('site/assets/'.length), path, use: 'website' });
        files[path] = '[Binary image asset]';
        imageResults.push({
          source: image.source || null,
          path,
          format: edited.mime,
          prompt: image.prompt,
          background: image.background || 'auto',
          // A Gemini image that could not be converted keeps its format; the agent is told (documentation 4.7).
          ...(edited.note ? { note: edited.note } : {}),
        });
        if (source && !vision.some((i) => i.path === image.source)) vision.push({ ...source, path: image.source });
        vision.push({ ...edited, path });
        context[path] = '[Binary image asset]';
        emit({
          stage: 'image',
          status: 'completed',
          message: 'Obrázek je připraven.',
          model: image.model,
          provider: image.provider,
          usage: edited.usage,
        });
      }
      needsVerification = true;
      feedback = { imageResults, instruction: 'Integrate the exact returned asset paths. Originals are preserved.' };
      continue;
    }
    const deletes = value.deleteFiles || [];
    if (
      !Array.isArray(value.files) ||
      value.files.length > 60 ||
      !Array.isArray(deletes) ||
      deletes.length > 120 ||
      deletes.some((path: any) => typeof path !== 'string') ||
      new Set(deletes).size !== deletes.length ||
      new Set(value.files.map((item: any) => item.path)).size !== value.files.length
    )
      throw Error('Neplatná změna souborů.');
    const hasCandidateChange = [...new Set([...Object.keys(original), ...Object.keys(files)])].some(
      (path) => original[path] !== files[path],
    );
    if (
      !value.files.length &&
      !deletes.length &&
      !generated.length &&
      !staged &&
      !hasCandidateChange &&
      !value.contentFiles?.length
    )
      throw Error('Agent neprovedl žádnou změnu.');
    // A change to a file the agent has not read is rejected, but the request goes on: the file is loaded and the agent
    // redoes the change from its current content (at most twice, like other path repairs).
    const unread = value.files
      .map((item: any) => item?.path)
      .filter((path: any) => typeof path === 'string' && original[path] && scope !== 'create' && !observed.has(path));
    if (unread.length) {
      if (++pathRepairs > 2) throw Error('Agent nesmí měnit soubor, který nenačetl: ' + unread[0]);
      const loaded = selectContext(files, unread),
        merged = { ...context, ...loaded };
      if (Object.values(merged).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 500000)
        throw Error('Agent nesmí měnit soubor, který nenačetl: ' + unread[0]);
      context = merged;
      for (const path of Object.keys(loaded)) observed.add(path);
      feedback = {
        ...feedback,
        requiredFixes: [...(feedback?.requiredFixes || []), 'Changed without reading: ' + unread.join(', ')],
        instruction:
          'The change was rejected and the candidate is unchanged: a file must be read before it is changed. Its current content is now in the context; redo the whole change from it.',
      };
      if (role === 'escalation') escalationCalls--;
      continue;
    }
    for (const path of deletes) {
      safeSitePath(project.root, path);
      if (
        raster(path) ||
        (!Object.hasOwn(files, path) && !(scope === 'create' && Object.hasOwn(original, path))) ||
        (scope !== 'create' && !observed.has(path)) ||
        value.files.some((item: any) => item.path === path)
      )
        throw Error('Agent nesmí odstranit nenačtený nebo chráněný soubor: ' + path);
    }
    for (const item of value.files) {
      safeSitePath(project.root, item.path);
      if (binaryAsset(item.path) || typeof item.content !== 'string' || Buffer.byteLength(item.content) > 300000)
        throw Error('Neplatný textový soubor.');
      if (original[item.path] && scope !== 'create' && !observed.has(item.path))
        throw Error('Agent nesmí měnit soubor, který nenačetl: ' + item.path);
    }
    let reviews: any[];
    try {
      reviews = prepareSourceContent(
        value,
        files,
        sources,
        webIntent.contentOnly,
        webIntent.userContext,
        webIntent.confirmedChoices,
      );
    } catch (error: any) {
      if (++sourceRepairs > 2) throw error;
      feedback = {
        ...feedback,
        requiredFixes: [error.message],
        instruction:
          'Source-backed changes were rejected before candidate mutation. Supply exact sourceFacts citations for factual field values from sources; preserve original presentation and scope. If unavailable, answer truthfully instead of inventing data.',
      };
      continue;
    }
    sourceReviews.push(...reviews);
    const decisions = reviews.filter((review) => review.status === 'decision');
    if (decisions.length) {
      return answer(hostAnswer('sourceChoice', responseLanguage, decisions), scope, resolvedRequest, {
        sourceDecisions: decisions,
      });
    }
    if (value.files.length || deletes.length)
      emit({
        stage: 'build',
        status: 'running',
        message: 'Upravuji web.',
        provider: client.provider,
        model: client.model,
      });
    for (const path of deletes) {
      delete files[path];
      delete context[path];
    }
    for (const item of value.files) {
      files[item.path] = item.content;
      context[item.path] = item.content;
      observed.add(item.path);
    }
    if (cms) {
      refreshCmsCandidate(cms.context, files, context);
      cms.files = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('site/cms/')));
      for (const path of Object.keys(context).filter((path) => path.startsWith('site/cms/'))) observed.add(path);
    }
    if (value.contentFiles) for (const item of value.contentFiles) item.source = attachmentPath(item.source);
    await stageContentFiles(value.contentFiles, cms?.context, project.root, files, importedBinary, contentAssets, [
      ...images.map((image) => ({ ...image, path: 'site/assets/' + image.id })),
      ...generated,
      ...cachedImages,
    ]);
    for (const asset of contentAssets) {
      const target = 'site/cms/files/' + asset.folder + '/' + asset.name;
      context[target] = files[target];
      observed.add(target);
      const ref = asset.folder + '/' + asset.name;
      if (cms && !cms.context.media.some((item: any) => item.source === ref))
        cms.context.media.push({
          source: ref,
          path: target,
          url: target.slice(5),
          available: true,
          kind: raster(target) ? 'image' : 'file',
          imageProcessingSupported: raster(target),
          staged: true,
        });
    }
    if (cms && files['site/cms/snapshot.json']) {
      const snapshot = JSON.parse(files['site/cms/snapshot.json']);
      for (const asset of contentAssets)
        snapshot.assets[asset.folder + '/' + asset.name] = 'site/cms/files/' + asset.folder + '/' + asset.name;
      files['site/cms/snapshot.json'] = JSON.stringify(snapshot, null, 2);
    }
    if (Object.keys(files).length > 200) throw Error('Web překročil limit 200 souborů.');
    if (value.action === 'stage') {
      staged = true;
      needsVerification = true;
      feedback = {
        stagedPaths: value.files.map((item: any) => item.path),
        removedPaths: deletes,
        instruction:
          'These changes exist only in the isolated candidate. Finish the remaining website; use implement when complete.',
      };
      emit({
        stage: 'build',
        status: 'running',
        message: 'Připravuji další část webu.',
        provider: client.provider,
        model: client.model,
      });
      continue;
    }
    if (enabledChecks.technical && value.browserTests !== undefined) {
      try {
        browserTests = validateBrowserTests(value.browserTests, files);
        needsVerification = true;
      } catch (e: any) {
        if (++scenarioRepairs > 2) throw Error('Nepodařilo se připravit test prohlížeče: ' + e.message);
        feedback = {
          requiredFixes: [e.message],
          invalidBrowserTests: value.browserTests,
          contract: browserTestContract,
          instruction:
            'Repair only the browser test schema. The candidate files and generated image assets are already preserved. Return implement with files:[] and corrected browserTests; do not regenerate images or claim tests ran.',
        };
        emit({ stage: 'test', status: 'rejected', message: 'Opravuji zadání testu prohlížeče.', errors: [e.message] });
        continue;
      }
    }
    // A new website or a redesign is verified against what it must meet (acceptance). A Web Lead that left it out is
    // asked for it again with the candidate kept; only then the request ends, with a reason the user can act on.
    if (enabledChecks.verification && scope !== 'edit' && !plan.acceptance.length) {
      if (++acceptanceRepairs > 2)
        throw Error(
          'Hlavní model nesepsal, co má nový web splňovat (akceptační kritéria). Zkuste to znovu, nebo zvolte silnější tým.',
        );
      feedback = {
        requiredFixes: ['acceptance is missing: a new website or a redesign needs concrete acceptance criteria.'],
        instruction:
          'The candidate files are already preserved. Return implement with files:[] and the acceptance array (items {id, category: required|preference, description, basis}) describing what the finished website must meet; do not rewrite files.',
      };
      emit({ stage: 'build', status: 'running', message: 'Doplňuji, co má web splňovat.' });
      continue;
    }
    let contentError: string | undefined,
      contentWillWrite = false;
    try {
      const preview = await applyDesignContent(contentBase, files, true, contentAssets);
      contentWillWrite = !!preview;
      normalizeContentPlan(files, preview);
      if (cms) {
        refreshCmsCandidate(cms.context, files, context);
        cms.files = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('site/cms/')));
      }
    } catch (e: any) {
      contentError = e.message;
    }
    const changed = [...new Set([...Object.keys(original), ...Object.keys(files)])].filter((path) =>
      path.startsWith('site/cms/') && cms
        ? (!!contentBase &&
            (path.startsWith('site/cms/data/') || path === 'site/cms/structure.json') &&
            files[path] !== contentBase.files[path]) ||
          (!!contentBase && contentAssets.some((asset) => path === 'site/cms/files/' + asset.folder + '/' + asset.name))
        : files[path] !== original[path],
    );
    const functional = (text: string) =>
      [
        ...text.matchAll(
          /<(?:form|script|iframe)\b[\s\S]*?<\/(?:form|script|iframe)>|\bon[a-z]+\s*=\s*["'][^"']*["']/gi,
        ),
      ]
        .map((m) => m[0])
        .join('\n');
    if (
      changed.some((p) => p.endsWith('.js')) ||
      value.files.some(
        (f: any) => /\.html$/.test(f.path) && functional(f.content) !== functional(original[f.path] || ''),
      )
    )
      needsVerification = true;
    for (const image of images.filter((i) => i.automaticUse)) {
      const path = 'site/assets/' + image.id;
      if (
        !original[path] &&
        !Object.entries(files).some(([p, t]) => !raster(p) && t.includes(path.slice(5))) &&
        !imageResults.some((i) => i.source === path)
      ) {
        delete files[path];
        delete context[path];
      }
    }
    for (const image of cachedImages) {
      if (
        !original[image.path] &&
        !contentAssets.some((asset) => asset.source === image.path) &&
        !Object.entries(files).some(([path, text]) => !binaryAsset(path) && text.includes(image.path.slice(5)))
      ) {
        delete files[image.path];
        delete context[image.path];
      }
    }
    const quickCheck =
      scope === 'edit' &&
      role === 'primary' &&
      !failures &&
      !staged &&
      !imported &&
      !generated.length &&
      !imageCleanup &&
      !browserTests.length &&
      !changed.some((p) => p.endsWith('.html') && functional(files[p] || '') !== functional(original[p] || '')) &&
      smallStyleChange(original, files);
    if (quickCheck || !enabledChecks.verification) needsVerification = false;
    const tests: any = enabledChecks.technical
      ? staticChecks(files)
      : { passed: true, errors: [], checks: [], skipped: true, reason: 'Disabled by user for this request.' };
    for (const image of enabledChecks.technical ? imageResults : [])
      if (
        !contentAssets.some((asset) => asset.source === image.path) &&
        !Object.entries(files).some(([p, t]) => !raster(p) && t.includes(image.path.slice(5)))
      )
        tests.errors.push('Nový obrázek není použitý na webu: ' + image.path);
    if (contentError) tests.errors.push(contentError);
    tests.passed = tests.errors.length === 0;
    if (!enabledChecks.technical)
      emit({ stage: 'test', status: 'skipped', message: 'Technická kontrola vypnuta pro tento požadavek.' });
    else
      emit({
        stage: 'test',
        status: 'running',
        message: quickCheck ? 'Ověřuji změněné styly a odkazy.' : 'Ověřuji soubory a zobrazení webu.',
      });
    let browser: any = { passed: false, errors: [], checks: [], screenshots: [] },
      verified: any = null,
      completion: any = null;
    await mkdir(draftRoot, { recursive: true });
    const path = join(draftRoot, 'job-' + Date.now());
    try {
      if (tests.passed) {
        await cp(project.root, path, { recursive: true });
        const draft = new Project(path);
        await draft.writeSnapshot(files);
        for (const image of [...images.filter((i) => i.use === 'website'), ...generated].filter((i) =>
          Object.hasOwn(files, 'site/assets/' + i.id),
        )) {
          await mkdir(join(path, 'site/assets'), { recursive: true });
          await writeFile(join(path, 'site/assets', image.id), Buffer.from(image.data, 'base64'));
        }
        for (const [name, bytes] of Object.entries(importedBinary))
          if (Object.hasOwn(files, name)) {
            const target = safeSitePath(path, name);
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, bytes);
          }
        browser = !enabledChecks.technical
          ? {
              passed: true,
              errors: [],
              checks: [],
              screenshots: [],
              skipped: true,
              reason: 'Disabled by user for this request.',
            }
          : quickCheck
            ? {
                passed: true,
                errors: [],
                checks: [],
                screenshots: [],
                skipped: true,
                reason: 'Small presentation-only change; full browser checks run before publishing.',
              }
            : await (options.check || browserChecks)(
                path,
                files,
                browserTests,
                imageResults.map((image) => image.path),
              );
        for (const image of (enabledChecks.technical ? imageResults : []).filter(
          (image) => image.background === 'transparent',
        )) {
          const evidence = browser.imageEvidence?.find((item) => item.path === image.path);
          if (evidence?.checked && !evidence.hasTransparentPixels) {
            browser.errors.push('Obrázek ' + image.path + ' neobsahuje požadované průhledné pixely.');
            browser.passed = false;
          }
        }
        if (browser.passed && enabledChecks.technical)
          emit({ stage: 'test', status: 'completed', message: 'Technické kontroly prošly.' });
        lastCheckImages = browser.screenshots || [];
        const currentPublication = options.publication?.(),
          publication = {
            mode: 'isolated-unpublished-draft',
            publishInvoked: false,
            baselinePublishedCommit: initialPublication?.publishedCommit ?? null,
            publishedCommit: currentPublication?.publishedCommit ?? null,
            unchanged: initialPublication?.publishedCommit === currentPublication?.publishedCommit,
            source:
              'SiteTiller host workflow and captured application publication state; publication endpoint is separate and locked while the edit runs',
          };
        if (browser.passed && !enabledChecks.verification) {
          verified = { status: 'SKIPPED', requiredFixes: [], reason: 'Disabled by user for this request.' };
          emit({ stage: 'verify', status: 'skipped', message: 'Ověření zadání vypnuto pro tento požadavek.' });
        }
        if (browser.passed && needsVerification) {
          const verificationRole: Role = role === 'escalation' ? 'escalation' : 'verify';
          assertAvailable(team, verificationRole, options);
          const verifier = {
            ...clientFor(team, keys, verificationRole),
            ...(verificationRole === 'escalation'
              ? {
                  reasoningEffort:
                    team.escalation.reasoningEffort === 'auto' ? effort : team.escalation.reasoningEffort || 'high',
                }
              : requestedEffort
                ? { reasoningEffort: requestedEffort }
                : team.verify.reasoningEffort === 'auto'
                  ? { reasoningEffort: effort }
                  : {}),
          };
          emit({
            stage: 'verify',
            status: 'running',
            message: 'Ověřuji splnění zadání.',
            model: verifier.model,
            provider: verifier.provider,
          });
          const diff = changed.map((path) => ({
            path,
            before: (path.startsWith('site/cms/') ? contentBase?.files[path] : original[path]) || null,
            after: files[path] || null,
          }));
          const response = await modelCall(verifier, verifierInstruction, {
            originalRequest: prompt,
            request: prompt,
            resolvedRequest,
            scope,
            acceptance: plan.acceptance,
            diff,
            architecture: files['site/architecture.txt'] ?? null,
            sharedModules: sharedModuleContext(files, original).filter((module) => module.changed),
            requestChecks: {
              ...enabledChecks,
              instruction:
                'Respect the user-selected skipped checks. Evaluate the implementation using source and available evidence. Do not demand execution of technical/browser checks explicitly disabled by the user; disclose resulting limits rather than claiming they ran.',
            },
            cms: cms
              ? {
                  ...cms.context,
                  readOnly: cms.context.readOnly,
                  sourceMode: cms.context.sourceMode,
                  snapshotRefreshByHost: true,
                  instruction:
                    'The host refreshes site/cms snapshots from the owner-managed CMS at job start. This is not an agent edit. Such refreshes are excluded from the presentation diff. Agents may propose the selected unpublished structure, schema-defined collection data and new-folder assets when readOnly=false. The supplied diff includes those requested content changes. Settings, existing media and published schema/content remain protected; structure and data are jointly validated by the owner Editor API. The host validates content and saves it as unpublished only after checks pass, with live editing disabled. Do not require restoring old CMS values. Evaluate presentation changes and the supplied evidence normally.',
                }
              : undefined,
            imageResults,
            previousFailure: feedback,
            sources: sources.map(({ citationText, ...source }) => source),
            testResults: {
              static: tests,
              browser: { ...browser, screenshots: undefined },
              publication,
              webImport: imported?.evidence,
            },
            _images: [...vision, ...browser.screenshots],
          });
          verified = verificationOutcome(response.value, files);
          if (
            !verified ||
            !['PASS', 'FAIL'].includes(verified.status) ||
            !Array.isArray(verified.requiredFixes) ||
            verified.requiredFixes.some((x: any) => typeof x !== 'string') ||
            (verified.status === 'FAIL' && !verified.requiredFixes.length) ||
            (verified.status === 'PASS' && verified.requiredFixes.length)
          )
            throw Error('Verifier nevrátil platný PASS/FAIL.');
          verified = { ...verified, model: verifier.model, provider: verifier.provider, role: verificationRole };
          emit({
            stage: 'verify',
            status: verified.status === 'PASS' ? 'completed' : 'rejected',
            message:
              verified.status === 'PASS'
                ? verified.warnings.length
                  ? 'Úspěch s upozorněním.'
                  : 'Ověření nezjistilo technické závady.'
                : 'Kontrola doložila technickou chybu.',
            warnings: verified.warnings,
            issues: verified.requiredFixes,
            model: verifier.model,
            provider: verifier.provider,
            usage: response.usage,
          });
        }
        if (browser.passed && (!needsVerification || verified?.status === 'PASS')) {
          const outcome = outcomeWarnings(browser.warnings, verified?.warnings, imported?.evidence.warnings),
            blanks = [
              ...new Set(
                sourceReviews
                  .filter((review) => review.status === 'blank')
                  .map((review) => review.collection + '.' + review.field),
              ),
            ],
            inferred = [
              ...new Set(
                sourceReviews
                  .filter((review) => review.status === 'inferred')
                  .map((review) => review.collection + '.' + review.field),
              ),
            ];
          const facts = [
            ...(outcome.length ? [{ warnings: outcome }] : []),
            ...(blanks.length ? [{ optionalOrderLeftBlank: blanks }] : []),
            ...(inferred.length ? [{ orderInferredNotLiteral: inferred }] : []),
            ...(contentWillWrite ? [{ contentSavedUnpublished: true, liveEditingDisabled: true }] : []),
          ];
          const finalAnswer = await prepareAnswer(role, value, finalSummary, facts);
          if ((await project.head()) !== baseCommit) throw Error('Projekt se mezitím změnil.');
          const message = 'SiteTiller: ' + prompt.replace(/\s+/g, ' ').slice(0, 110);
          if (imported) {
            await draft.git(['add', 'site']);
            await draft.git(['commit', '--allow-empty', '-m', message]);
          }
          // A stopped request changes nothing: no step and no content write.
          throwIfStopped();
          const commit = imported ? await draft.head() : await draft.commit(message);
          if ((await project.head()) !== baseCommit) throw Error('Projekt se mezitím změnil.');
          await project.git(['fetch', path, 'main']);
          await project.git(['merge', '--ff-only', 'FETCH_HEAD']);
          try {
            const saved = await applyDesignContent(contentBase, files, false, contentAssets);
            if (saved) {
              if (cms) for (const item of cms.context.media) item.staged = false;
              normalizeContentPlan(files, saved);
              if (cms) {
                refreshCmsCandidate(cms.context, files, context);
                cms.files = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('site/cms/')));
              }
              if (saved.schema && contentBase) {
                contentBase.schema = saved.schema;
                contentBase.schemaRevision = saved.schemaRevision;
                contentBase.contentRevision = saved.contentRevision;
                contentBase.revisions = Object.fromEntries(
                  Object.entries(saved.lists).map(([name, value]: [string, any]) => [name, value.revision]),
                );
                contentBase.files = { ...cms!.files };
              }
            }
            if (saved)
              emit({
                stage: 'build',
                status: 'completed',
                message: 'Změny obsahu jsou uložené jako nepublikované. Živá editace je vypnutá.',
              });
          } catch (e) {
            if ((await project.head()) === commit) await project.git(['reset', '--hard', baseCommit]);
            throw e;
          }
          const changes = await stepChanges(
            project,
            baseCommit,
            commit,
            contentAssets.map((asset) => asset.source),
          );
          plan.summary = finalAnswer;
          completion = {
            commit,
            baseCommit,
            ...changes,
            finalAnswer,
            scope,
            resolvedRequest,
            sourceReviews,
            memory: changeMemory(original, files, finalAnswer),
            plan,
            imageResults,
            webImport: imported?.evidence,
            review: null,
            tests: {
              passed: true,
              errors: [],
              checkLevel:
                !enabledChecks.technical || !enabledChecks.verification ? 'custom' : quickCheck ? 'quick' : 'full',
              enabledChecks,
              skipped: !enabledChecks.technical,
              browserTests,
              static: tests,
              browser: { ...browser, screenshots: undefined },
              publication,
              analysis: verified,
              imageCleanup,
              warnings: outcome,
            },
          };
          try {
            emit({ stage: 'final-answer', status: 'completed', message: finalAnswer, agentResponse: true });
            emit({
              stage: 'ready',
              message: outcome.length
                ? 'Návrh je připravený s upozorněním. Můžeš jej publikovat.'
                : 'Návrh je připravený. Můžeš jej publikovat.',
              commit,
              baseCommit,
              ...changes,
              warnings: outcome,
            });
          } catch {
            /* The confirmed result and prepared answer remain authoritative. */
          }
          return completion;
        }
      }
    } finally {
      try {
        await (options.cleanup
          ? options.cleanup(path)
          : rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
      } catch {
        const warning = 'Úklid dočasné pracovní kopie se nepodařil. Výsledek kontrol ani uložený návrh to nemění.';
        if (completion) {
          completion.tests.warnings = outcomeWarnings(completion.tests.warnings, [warning]);
          try {
            emit({
              stage: 'ready',
              message: 'Návrh je připravený s upozorněním. Můžeš jej publikovat.',
              commit: completion.commit,
              baseCommit,
              warnings: completion.tests.warnings,
            });
          } catch {
            /* Confirmed mutation and prepared answer remain available. */
          }
        } else emit({ stage: 'test', status: 'warning', warnings: [warning] });
      }
    }
    feedback = {
      requiredFixes: [...tests.errors, ...browser.errors, ...(verified?.requiredFixes || [])],
      failedStep: !tests.passed ? 'static' : !browser.passed ? 'browser' : 'verify',
      verification: verified,
      testResults: { static: tests, browser: { ...browser, screenshots: undefined } },
      diff: changed.map((path) => ({
        path,
        before: (path.startsWith('site/cms/') ? contentBase?.files[path] : original[path]) || null,
        after: files[path] || null,
      })),
    };
    if (!tests.passed || !browser.passed)
      emit({
        stage: 'test',
        status: 'rejected',
        // Invalid content (structure, rows) can never be saved, so it is checked even with the technical check off.
        message: enabledChecks.technical
          ? 'Technická kontrola našla nutné opravy.'
          : 'Obsah nejde uložit, je potřeba ho opravit.',
        errors: [...tests.errors, ...browser.errors],
      });
    failures++;
    if (failures >= 3 || (role === 'escalation' && escalationCalls >= 2))
      throw Error('Změna neprošla kontrolou ani po eskalaci. Původní náhled zůstal zachován.');
    if (failures === 2) {
      role = 'escalation';
      needsVerification = true;
    }
    // Keep the same implementer for the first repair; escalation is resolved from configuration.
    if (
      !requestedEffort &&
      team.primary.reasoningEffort === 'auto' &&
      role === 'primary' &&
      failures &&
      effort === 'low'
    )
      effort = 'medium';
  }
  throw Error('Úloha překročila limit modelových volání. Původní náhled zůstal zachován.');
}
