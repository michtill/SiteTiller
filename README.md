# SiteTiller Muse

SiteTiller Muse is a self-hosted tool for running a small website: edit its content, let AI propose changes, check them in a preview and publish a frozen release.

It consists of several local services behind one login:

- **Shell** (`apps/shell`) – login, navigation and shared settings.
- **Content editor** (`apps/cmstudio`) – structured content, media and publication.
- **AI Studio** (`apps/aistudio`) – AI-assisted changes to the website with checks, preview and history.
- **Website** (`apps/website`) – serves the published release.

## Requirements

- Node.js 24 or newer
- pnpm 11 (`corepack enable` or `npm install -g pnpm@11`)
- Git on `PATH`

## Install and build

```sh
pnpm install --frozen-lockfile
cd apps/cmstudio && pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts && cd ../..
node scripts/build.mjs
```

## Playground

The Playground is a local, disposable instance with a small example site. It is created outside the repository.

```sh
node scripts/playground.mjs init
node scripts/playground.mjs start
node scripts/playground.mjs status
node scripts/playground.mjs stop
```

- Open the shell at http://127.0.0.1:4540/. The generated password is stored in `<instance>/settings/playground-password.txt`; it is never printed.
- Instances are created in `~/sitetiller-instances/<name>` (your home directory) by default. Set `SITETILLER_INSTANCES` (base directory) or put `{ "instances": "<directory>" }` into the untracked file `.sitetiller-local.json` at the repository root to use a different location; `SITETILLER_INSTANCE_NAME` sets the name (default `playground`).
- `init` refuses an existing instance and never resets it.
- AI features need an OpenAI or Anthropic API key, entered in the AI Studio settings.
- The Playground scripts are currently developed and tested on Windows.

## Tests

```sh
node scripts/check.mjs
node --test test/*.test.mjs
pnpm test:aistudio
cd apps/cmstudio && pnpm test && pnpm test:browser
```

Browser tests use Playwright's Chromium (`pnpm exec playwright install chromium`) or the browser set in `SITETILLER_BROWSER_EXECUTABLE`.

## License

[MIT](LICENSE) © 2026 Michal Tiller
