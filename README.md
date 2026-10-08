# SiteTiller — AI Web Editor

[Český návod](docs/README.cs.md) · [Deployment guide](docs/deployment.md) · [Architecture](docs/architecture.md)

SiteTiller is a self-hosted editor that creates and changes static websites from natural-language requests. Start from an empty website, redesign an existing draft, edit images, or add browser-side features. Preview each change, return to an earlier step, and publish only when you are ready.

To copy a public website, name its address in your request, for example: “Load https://example.com and copy it into my draft.” Web Lead retrieves actual public HTML, CSS, JavaScript, linked pages and supported images. The import becomes a reversible draft only after technical checks and independent verification. It does not modify the source website. Limits: 12 pages, 100 discovered resources, 20 MB total, 300 KB per text file and 5 MB per image. Server backends, authenticated content and private network addresses are not imported. Unsupported resources can remain external links, and coverage warnings are reported.

Set the live website address in Settings or `SITETILLER_SITE_URL`. The welcome panel offers to load it. “Compare with the live website” compares whichever draft step or saved version is currently displayed, without editing it. Results distinguish draft changes and external website changes against the last saved live version, with text excerpts and image previews. Confirming an import always creates a previewable editing step. You may remove earlier editing steps and optionally save the imported state as a numbered version: the first suggested number is 0, later numbers follow existing versions. This records an externally observed live state; it does not publish anything. Saved versions are retained when editing steps are removed.

The interface supports **English and Czech**. Choose the interface language in Settings; it is saved in your browser. Agents answer in the language of your request, independently of the interface language. Internal agent tasks remain concise English JSON.

## What it does

- One Web Lead handles routine work; specialists are invoked when useful.
- Static HTML, CSS, JavaScript, SVG and PNG/JPEG/WebP assets.
- Image uploads, image generation and edits; original uploads remain intact.
- Short follow-ups such as “a little more”, using bounded conversation memory.
- Isolated browser checks before accepting changes and before publication.
- Read-only previews of earlier steps and publications; explicit load/return actions.
- Publication versions and subversions (`12`, `12.1`, `12.2`), preserving earlier publications.
- Light/dark editor themes; separate studio, preview and production origins.

**Current scope:** static websites. SiteTiller does not run arbitrary backend code, install website dependencies or build Next.js/Vue/React projects. A newsletter can use an existing HTTPS endpoint; server-side integration must be provided separately. External services are blocked during automated smoke checks, so a local check cannot certify a real payment, subscription or third-party API operation.

## Quick start: Docker Compose

Requirements: Docker Engine with Compose, an x86-64 or ARM64 Linux server supported by the base images, and enough memory for Node/Chromium (at least 1 GB for a small installation; allow additional build and browser headroom).

```sh
git clone https://github.com/michtill/SiteTiller.git
cd SiteTiller
cp .env.example .env
docker compose up -d --build web preview
```

By default, the studio is at `http://127.0.0.1:8080` and the draft at `http://127.0.0.1:8081`. Ports bind to loopback. For remote use, configure HTTPS and three separate hostnames as described in the deployment guide. Set `SITETILLER_ORIGIN` to the exact public studio origin and `SITETILLER_PREVIEW_URL` to the preview origin.

Retrieve the one-time installation token privately:

```sh
docker compose exec web cat /data/bootstrap-token
```

Enter it in the login page and choose an administrator password of 12–256 characters. Add your OpenAI and, if using an Anthropic specialist, Anthropic API keys in Settings. Keys are never returned to the browser. API usage is billed by the model providers.

Default UI language is configurable with `SITETILLER_UI_LANGUAGE=en` or `cs`. Each browser can override it in Settings. Changing UI language preserves unsent text and already uploaded attachments. Finish an upload before switching languages.

English is the default when no supported language is configured. Additional interface languages need a dictionary and one entry in the shared language registry; see [Adding a language](docs/localization.md).

### Optional production publishing

The default installation edits and previews only. To enable the included static hosting/publisher, follow [the production setup](docs/deployment.md#included-production-hosting). You can also connect a fixed existing Git deployment target. Publication never happens just because an agent finishes an edit.

### Local development

Use Node.js 24+ and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm start
```

The default local studio is on port 8080. The installation token is in `data/bootstrap-token`. Start `src/preview.ts` separately if using a dedicated preview origin. Run `pnpm test` for deterministic tests; the suite uses fake providers and does not make paid model calls.

## Configuration and multiple websites

Use one instance per website. Give each Compose project a unique `SITETILLER_INSTANCE`, ports, URLs and volumes. Each has its own administrator and credentials. Working Git stores the current draft and active steps; independent production Git stores published versions and their numbers, dates and descriptions. Publishing closes older working steps and removes their Git objects while preserving any newer draft steps. This is not a multi-tenant SaaS installation.

Model mapping is configurable in Settings. Defaults are in `src/team.ts`; usable model availability depends on your provider account. Web Lead selects capabilities rather than arbitrary model IDs. See the architecture document for verification and escalation behavior.

## Data, backups and updates

Back up `sitetiller_data` (configuration, encryption material, uploads and the draft Git repository) and, when enabled, `sitetiller_production`. Treat backups as private: they contain website history and provider credentials. Preserve both together before updates. Never add `.env`, `data/`, logs or backups to GitHub.

To update, pull the desired release, back up volumes, then rebuild/restart the services. Existing projects are not reinitialized. Publication history is retained. Read [deployment and recovery instructions](docs/deployment.md) before deploying to an existing website.

## Security and contributions

Website scripts execute on a separate preview origin, outside the authenticated studio. The same-origin fallback uses an opaque sandbox. Public previews are marked `noindex`, but a draft URL is not an access-control mechanism. Use upstream access protection if drafts are confidential. Never grant the editable website access to studio credentials.

The included production CSP permits website scripts, styles and HTTPS embeds; the studio keeps a separate restrictive policy. Keep TLS and server updates under your hosting administrator's control.

Report bugs with the app version, reproduction steps and sanitized logs. Do not include API keys, passwords, private draft contents or backups. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

