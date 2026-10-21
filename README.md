# SiteTiller

> **Say it. SiteTiller builds it.**

*Version 1 – Muse*

**Build any website in three layers: Structure → Content → Presentation.**
A self-hosted CMS, an AI design studio and an MCP server in one application, for one website.

- **Structure** – you define what the website is made of: collections (albums, products, team, events…), their fields and folders for files.
- **Content** – people fill it in a friendly Content editor: records, texts, images, documents. No code.
- **Presentation** – the website itself: HTML, CSS, JavaScript and templates rendered from your data.

A team of AI agents – or your own AI assistant through MCP – works on **all three layers**: it designs the structure, fills in content (from your instructions, or from a public web page you point it to – every value must match a quote verified in that page) and builds the presentation. Every change goes through the layer's owner and is checked like an edit in the Content editor; content changes wait as unpublished edits until you publish them. What gets published is a frozen, static release – fast, safe and easy to host anywhere.

## Why it works

- **The layers stay separate.** Content lives in structured records, the presentation is code in its own Git history. A redesign never loses a single record; new content never needs a developer; the AI can change any layer, but always through the same validated path as a person.
- **Any kind of website.** The structure is yours: a band with albums and concerts, a company with products and references, a portfolio, a club. The AI builds the presentation for whatever structure you define.
- **Every change is a step you can see.** Each AI request becomes a step with its own preview. Compare steps, go back, save a draft under a name, share a preview link, publish when you are happy.
- **Nothing gets lost.** History only grows. Every write is verified first, then stored atomically; conflicting edits are rejected instead of overwritten. Irreversible actions always ask first.
- **The whole instance is one folder.** Files and Git, no database. Back it up by copying a folder; move it between your laptop and a server unchanged – only the settings differ.
- **Your data goes only where you send it:** the published website, the AI service you chose, your Git hosting, and – if you switch it on – the AI assistant you connect. API keys and passwords never leave the instance.
- **It tells the truth.** Checks run before publishing (templates, forms, hosting rules, rendering in a real browser). If something is not certain, the application says so instead of reporting success.

## What is inside

| Part | What it does |
| --- | --- |
| **Shell** | One login, navigation, Settings (interface, e-mail, AI models, MCP, addresses and sharing, password) and the MCP server. |
| **Content editor** | Structure editor (collections, fields, folders), records, files, publishing of content, optional live editing. |
| **AI Studio** | Conversation with a team of AI agents that edits the website draft – presentation, and on request also structure and content; steps with previews, saved drafts, numbered published versions, loading of an existing live website. |
| **Preview** | Isolated, sandboxed rendering of any step, draft or version; optional public preview and shareable links (`/s/…`) with an expiry. |
| **Publisher** | Exports the chosen version, deploys it, verifies it and records the version. |
| **Website** | Serves the published release (internal mode). |

The user interface is available in Czech and English. AI Studio works with OpenAI or Anthropic models (your API keys, stored encrypted in the instance).

## MCP server: bring your own AI assistant

Switch on **Settings → Connect external AI** and the instance offers a [Model Context Protocol](https://modelcontextprotocol.io) server at `https://<editor address>/mcp`. Claude, ChatGPT, Claude Code or any other MCP client can then work on your website exactly like AI Studio does – read the website and its content, change the draft, change the structure, upload files, share previews and publish – using **your own subscription**, not the instance's API keys.

- **Sign-in:** OAuth 2.1 with dynamic client registration and PKCE (the assistant never sees your password), or a personal access token for tools like Claude Code.
- **Permissions you choose:** Read (always), Edit the draft, Delete steps and drafts, Publish.
- **Checks you choose:** Strict technical checks (default), Key checks and warnings, or No checks. Data validity, permissions and secrets are protected at every level.
- **One writer for every piece of data:** the assistant's changes become ordinary steps labelled with the assistant's name, with a preview, in the same history as everything else. Every call is logged.

## Internal or external presentation

- **Internal** (default): SiteTiller serves the published website itself.
- **External:** SiteTiller pushes only the finished static website (pages, assets, a copy of the content, PHP scripts for contact forms) to the Git repository of your web hosting. The website runs **without SiteTiller**; SiteTiller only hosts the studios and the preview. All versions and history stay inside the instance. If someone else changes the website's Git, SiteTiller notices and asks before publishing over it.

## Quick start (local Playground)

Requirements: Node.js 24+, pnpm 11 (`corepack enable`), Git.

```sh
pnpm install --frozen-lockfile
cd apps/cmstudio && pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts && cd ../..
node scripts/build.mjs

node scripts/playground.mjs init
node scripts/playground.mjs start
```

Open http://127.0.0.1:4540/. The generated password is in `<instance>/settings/playground-password.txt` (it is never printed). Stop with `node scripts/playground.mjs stop`; `status` shows the running services.

- The Playground is a local instance with a small example website. It is created in `~/sitetiller-instances/playground`; set `SITETILLER_INSTANCES` and `SITETILLER_INSTANCE_NAME` (or `{ "instances": "<directory>" }` in an untracked `.sitetiller-local.json`) to use another place or name.
- `init` refuses an existing instance and never resets it.
- New instances start offline. Enter an OpenAI or Anthropic API key in **Settings → AI Studio models** and allow AI Studio to reach them with `node scripts/playground.mjs network providers` followed by `node scripts/playground.mjs restart aistudio`.
- The Playground scripts are developed and tested on Windows; the server deployment runs on Linux.

## Run it on a server

The whole application runs as **one container** with the instance data in one volume – the repository's [`compose.yml`](compose.yml) is all a hosting panel or Docker Compose needs:

| Port | Map it to |
| --- | --- |
| 4540 | the editor address, e.g. `edit.example.com` (studios, settings, MCP) |
| 4512 | the website domain (internal presentation only) |
| 4541 | the public preview address, e.g. `pre.example.com` (optional) |

Create a new, empty instance once inside the container with `node scripts/instance-create.mjs <deployment.json>` (or take over an existing one with `scripts/instance-adopt.mjs`); see [`deploy/`](deploy/) and the comments at the top of both scripts. Serve the studios over HTTPS through a reverse proxy and pass `/.well-known/oauth-*` paths through to the application, otherwise MCP clients cannot sign in.

## Tests

```sh
node scripts/check.mjs
node --test --test-concurrency=1 test/*.test.mjs
pnpm test:aistudio
cd apps/cmstudio && pnpm test && pnpm test:browser
```

Browser tests use Playwright's Chromium (`pnpm exec playwright install chromium`) or the browser set in `SITETILLER_BROWSER_EXECUTABLE`. The same suites run in CI on every push.

## Project layout

```
apps/shell       login, settings, proxy and the MCP server
apps/cmstudio    Content editor (Vue 3 + Vite)
apps/aistudio    AI Studio, preview and publisher (Node, Vue 3 + Vite)
apps/website     the published website server
packages/        shared settings, UI components, translations (cs, en)
scripts/         Playground, server start, instance creation and takeover
deploy/          Dockerfile and compose files
```

Node runs the TypeScript servers directly (type stripping, no server build). There is no database: all state is files and Git.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Michal Tiller
