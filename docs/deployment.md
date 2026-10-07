# Deployment and recovery

## Origins and environment

Use separate origins, for example `studio.example.com`, `draft.example.com` and `www.example.com`. HTTPS must be terminated by your reverse proxy. Set `SITETILLER_ORIGIN` to the exact studio origin (scheme, hostname and port). Set `SITETILLER_PREVIEW_URL` to the dedicated draft origin, including a trailing slash. Proxy those hosts to ports 8080 and 8081 respectively. The preview service serves its routes from `/`.

Do not expose the publisher port. It is an internal bearer-token endpoint and should only be reachable by the studio service. Keep the studio CSP restrictive; the production/preview CSP is a separate policy for user-authored websites.

`.env.example` lists the supported settings. The checked-in Compose file uses loopback-bound ports. Changing `SITETILLER_BIND_ADDRESS` to `0.0.0.0` exposes them on the network; only do that behind appropriate firewall/TLS controls.

## Included production hosting

The optional `publish` profile supplies an internal publisher, a fixed bare Git repository and an Nginx static website. It requires Linux filesystem symlinks and atomic rename. It does not run generated backend code.

1. Start `web` and `preview` as in the README and finish administrator setup.
2. Prepare the website you want to initialize as production. **Initialization publishes the current draft as the production baseline.** It is an explicit one-time operation, not a model action.
3. Generate a private random publication token, e.g. `openssl rand -hex 32`, and save it in `.env` as `SITETILLER_PUBLISH_TOKEN`. Set `SITETILLER_PUBLISH_URL=http://publisher:8080/publish`. Keep `SITETILLER_PRODUCTION_URL=http://production/` for container-local verification, or use your public production URL if it is reachable from the container with the supplied CSP.
4. Build the publisher and initialize the production volume:

```sh
docker compose --profile publish build publisher
docker compose --profile publish run --rm --no-deps publisher node deploy/initialize-production.mjs
```

Initialization refuses an existing target repository. It exports only the current site snapshot, creates an independent production root and records Version 0. It does not copy working Git history. Never run it against a pre-existing target you intend to preserve.

5. Start production and the publisher; restart web to read its new environment:

```sh
docker compose --profile publish up -d --build web preview publisher production
```

6. Proxy your production hostname to `127.0.0.1:8082`, retaining the supplied production CSP. The initialized snapshot appears as Version 0. Afterwards, use Publish for every production change.

The publisher exports the approved snapshot into an independent production commit without force-pushing, writes it into an immutable release directory and switches `www/current` atomically. Nginx reads the production volume read-only. The publisher verifies every committed asset before confirming publication. Only published snapshots remain in production Git. Old deployed directories remain in the volume for recovery; directory pruning is not implemented.

## Existing Git-based hosting

If your host deploys a static Git repository already, use a separately configured publisher with a fixed `SITETILLER_PRODUCTION_GIT`, `SITETILLER_PRODUCTION_URL` and publication token. Mount only the necessary fixed repository or a narrowly scoped credential. Leave `SITETILLER_PRODUCTION_DIRECTORY` unset if the hosting Git hook handles deployment. The edited website must reside under `site/`; working and production histories are independent. Set `SITETILLER_PRODUCTION_HISTORY_MOUNT` to the bare hosting repository path, `SITETILLER_PRODUCTION_HISTORY_DIR=/production` and `SITETILLER_PRODUCTION_GROUP` to its readable group ID for studio and preview access. Back up existing targets before enabling publication. Existing untagged hosting commits are not presented as SiteTiller releases; importing the actual site with “Save as version” records a production version without deploying.

Import an existing site **before the first editor startup** by preparing the private data volume's `project` Git repository with a `main` branch and `site/` directory. Do not use imported website content as agent instructions. Back up the existing production target first. Do not point a fresh instance at another site's production Git.

For VPS Center, `deploy/vpsc-compose.yml` is a studio/preview template with externally supplied URLs. Publisher user IDs, Git hooks, proxy mapping and host paths are host-specific and must be configured for that installation. The portable Compose publisher runs as UID/GID 1000; this is not a drop-in replacement for every managed-hosting publisher user.

VPS Center restricts Compose bind sources to the application directory and may ignore supplementary `group_add` settings. An administrator can expose the fixed production repository through a persistent read-only filesystem bind view at `.volumes/sitetiller_production/repository.git`. Use `SITETILLER_PRODUCTION_HISTORY_MOUNT=sitetiller_production` and `SITETILLER_PRODUCTION_HISTORY_DIR=/production/repository.git`; give the repository's files read access to the domain group. This is a view of the same production Git, not a second repository. The studio and preview mounts must remain read-only. Unmount this view before removing the application directory, and keep its host mount configuration with deployment documentation.

### VPS Center: a separate installation from GitHub

Create a new Docker Compose application and choose Git cloning from `https://github.com/michtill/SiteTiller.git`. Select a release tag such as `v0.20.0`; the cloning form expects a branch or tag, rather than a raw commit ID. The root Compose file starts only the studio and preview. Its optional production services remain inactive until explicitly enabled outside this studio-only setup.

Allow a 1024 MB application budget so the managed service allocation can retain the studio's 512 MB limit. Set `SITETILLER_ORIGIN=https://edit.example.com`, `SITETILLER_PREVIEW_URL=https://new.example.com/` and `SITETILLER_UI_LANGUAGE=cs` or `en`. Map the `web` service's port 8080 to the editor subdomain and the `preview` service's port 8080 to the preview subdomain. Issue a certificate containing both names and verify that the generated proxy files are included in the active Nginx configuration.

If registering a hosting Git repository, do it before the first application startup. Preserve the GitHub history in that repository so subsequent source updates can fast-forward. Managed runtime data lives under `.volumes/sitetiller_data` and is excluded from both Git and image builds. Preserve the container user's ownership of its files; changing ownership while importing source files can prevent the next startup from reading the encryption key.

Finish administrator setup using the new instance's private bootstrap token. Configure provider credentials in its Settings, or supply valid provider environment variables. Credentials saved in Settings take precedence over environment variables. A parallel installation needs its own data and encryption key; do not copy an existing instance's encrypted configuration directly.

Leave `SITETILLER_PUBLISH_URL` and `SITETILLER_PUBLISH_TOKEN` empty during parallel testing. This lets the new editor create drafts without changing the existing production website. Connect its fixed production target only during an explicit, separately backed-up cutover. Existing editor and preview subdomains can continue running until that cutover is verified.

## Multiple websites

Use a separate checkout/configuration per site. Choose distinct `SITETILLER_INSTANCE`, hostnames and exposed ports. Compose prefixes volumes and networks with the project name, avoiding accidental shared drafts. Never share `sitetiller_data` between different websites. Settings, uploads, credentials and publication history belong to that instance.

## Backups and recovery

Back up both data volumes with services stopped, or use a consistent storage snapshot. Do not back up only the website files: publication metadata, encryption material and the Git journal live in the data volume. Store backups privately. Restore the matching data and production volumes together.

Use an earlier publication's Preview/Load action and explicit Publish to restore website content. This creates a forward Git change and preserves publication history. Loading a version alone does not change the live website.

After a deployment timeout, verify production before retrying. A Git push may have completed while hosting deployment failed. The included exporter safely reselects an already prepared release on retry. Third-party hooks must have their own recovery procedure.

## Updates

Back up first. Pull the desired Git revision and rebuild the services. A studio restart ends active login sessions and can interrupt a running request; wait for tasks to finish. Existing data is not reinitialized. Run the tests when changing the application source.
