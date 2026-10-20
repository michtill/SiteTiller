// The environment of one SiteTiller instance, shared by the local Playground and the server container.
// Inside, the six services talk over 127.0.0.1 on the instance ports; `instance.public` describes how the instance is
// reached from outside (a server behind nginx), the defaults are the local Playground.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeNetworkMode } from './network-policy.mjs';
export const services = [
  ['cmstudio', 'apps/cmstudio/server/server.ts'],
  ['aistudio', 'apps/aistudio/src/server.ts'],
  ['preview', 'apps/aistudio/src/preview.ts'],
  ['publisher', 'apps/aistudio/src/publisher.ts'],
  ['website', 'apps/website/server.ts'],
  ['shell', 'apps/shell/server.ts'],
];
// A production Git given as an SSH address (ssh://user@host/path.git) is remote: the instance keeps a mirror of it
// and reaches it with its own key and the server's known host key (both in settings/, see production-remote.ts).
export const remoteGit = (address) => /^ssh:\/\//.test(address || '');
export function instancePaths(root) {
  return {
    root,
    data: join(root, '.sitetiller'),
    production: join(root, '.production'),
    settings: join(root, 'settings'),
  };
}
export async function instanceEnvironment(repo, root, instance) {
  const p = instance.ports,
    paths = instancePaths(root),
    mode = normalizeNetworkMode(instance.networkMode),
    external = instance.public || {},
    local = (port) => 'http://127.0.0.1:' + port,
    editOrigin = external.editOrigin || local(p.shell),
    siteUrl = external.siteUrl || local(p.website) + '/',
    remote = remoteGit(external.productionGit) ? external.productionGit : '',
    productionGit = remote
      ? join(paths.production, 'remote.git')
      : external.productionGit || join(paths.production, 'repository.git'),
    // External presentation (documentation 7.7): only the static website goes to the website's own Git.
    websiteGit = external.presentation === 'external' ? external.websiteGit || '' : '',
    sshGit = remote || (remoteGit(websiteGit) ? websiteGit : ''),
    // The public draft preview needs its own host name: locally localhost, on a server its own address.
    previewOrigin = instance.public ? external.previewOrigin || '' : 'http://localhost:' + p.shell;
  return {
    ...process.env,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    SITETILLER_NETWORK_MODE: mode,
    SITETILLER_OFFLINE: mode === 'offline' ? '1' : '0',
    HOST: '127.0.0.1',
    CMS_HOST: '127.0.0.1',
    CMS_PORT: String(p.cmstudio),
    CMS_ROOT: root,
    CMS_DIST: join(repo, 'apps/cmstudio/dist'),
    SITETILLER_INSTANCE_ROOT: root,
    SITETILLER_SHARED_SETTINGS_FILE: join(paths.settings, 'shared.json'),
    SITETILLER_SHARED_AUTH_FILE: join(paths.settings, 'auth.json'),
    SITETILLER_PRODUCTION_ROOT: paths.production,
    SITETILLER_DATA_DIR: paths.data,
    SITETILLER_CMS_ROOT: root,
    SITETILLER_CMS_URL: local(p.cmstudio),
    SITETILLER_ORIGIN: local(p.aistudio),
    SITETILLER_PREVIEW_URL: editOrigin + '/preview/',
    EDIT_ORIGIN: editOrigin,
    SITETILLER_PUBLIC_PREVIEW_ORIGIN: previewOrigin,
    CMSTUDIO_PORT: String(p.cmstudio),
    AISTUDIO_PORT: String(p.aistudio),
    PREVIEW_PORT: String(p.preview),
    SITETILLER_GATEWAY_TOKEN: (await readFile(join(paths.settings, 'gateway.token'), 'utf8')).trim(),
    SITETILLER_PUBLISH_TOKEN: (await readFile(join(paths.settings, 'publish.token'), 'utf8')).trim(),
    SITETILLER_PUBLISH_URL: local(p.publisher) + '/publish',
    SITETILLER_PRODUCTION_GIT: productionGit,
    SITETILLER_PRODUCTION_HISTORY_DIR: productionGit,
    SITETILLER_PRODUCTION_DIRECTORY: paths.production,
    SITETILLER_LOCAL_PRODUCTION_ROOT: paths.production,
    // The publisher verifies the deployed files on the instance's own Website service.
    SITETILLER_PRODUCTION_URL: local(p.website) + '/',
    SITETILLER_SITE_ORIGIN: new URL(siteUrl).origin,
    SITETILLER_SITE_URL: siteUrl,
    SITETILLER_WEBSITE_RUNTIME: '1',
    SITETILLER_FORMS_RUNTIME: '1',
    SITETILLER_UI_LANGUAGE: 'cs',
    EDIT_HOST: '127.0.0.1',
    ...(websiteGit
      ? { SITETILLER_WEBSITE_GIT: websiteGit, SITETILLER_WEBSITE_BRANCH: external.websiteBranch || 'main' }
      : {}),
    ...(remote ? { SITETILLER_PRODUCTION_REMOTE: remote } : {}),
    ...(sshGit
      ? {
          GIT_SSH_COMMAND: [
            'ssh',
            '-i',
            JSON.stringify(join(paths.settings, 'production-git.key')),
            '-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes',
            '-o UserKnownHostsFile=' + JSON.stringify(join(paths.settings, 'production-git.known_hosts')),
          ].join(' '),
        }
      : {}),
    ...(external.retryDeployHook && !remote ? { SITETILLER_RETRY_DEPLOY_HOOK: '1' } : {}),
    ...(external.browser ? { SITETILLER_BROWSER_EXECUTABLE: external.browser } : {}),
  };
}
// Per-service variables: only the AI controller reaches the providers; the Shell and the Website listen on
// `instance.public.listen` when the instance sits behind a proxy (a container), otherwise on loopback.
export function serviceEnvironment(env, instance, name) {
  const listen = instance.public?.listen || '127.0.0.1';
  return {
    ...env,
    ...(name === 'aistudio' ? {} : { SITETILLER_NETWORK_MODE: 'offline', SITETILLER_OFFLINE: '1' }),
    ...(name === 'shell'
      ? {
          EDIT_HOST: listen,
          // A separate port for the public draft preview (a hosting panel maps one port to one host name).
          ...(instance.ports.publicPreview ? { SITETILLER_PUBLIC_PREVIEW_PORT: String(instance.ports.publicPreview) } : {}),
        }
      : {}),
    ...(name === 'website' ? { HOST: listen } : {}),
    // A website hosted outside the instance (documentation 7.7): the Publisher checks it at its public address.
    ...(name === 'publisher' && instance.public?.presentation === 'external' && instance.public.siteUrl
      ? { SITETILLER_WWW_URL: instance.public.siteUrl }
      : {}),
    PORT: String(instance.ports[name]),
  };
}
