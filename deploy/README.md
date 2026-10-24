# Deployment

One SiteTiller instance runs as one container (`scripts/serve.mjs` runs the Shell, which starts the other five services when they are needed and lets the unused ones sleep, documentation 2.6); its data is the volume mounted at `/instance`. The image never contains instance data.

## Files

- [`instance.Dockerfile`](instance.Dockerfile) – the image (Node 24, Git, SSH client, Chromium for the checks, PHP for hosting hooks).
- [`../compose.yml`](../compose.yml) – for a hosting panel or plain Docker Compose: one service, named volume `instance`, ports 4540, 4512 and 4541.
- [`instance-compose.yml`](instance-compose.yml) – manual deployment with a mounted production Git and a hardened container.

## New instance

1. Build and start the container with an empty `/instance` volume.
2. Write a `deployment.json`, for example:

   ```json
   {
     "editOrigin": "https://edit.example.com",
     "siteUrl": "https://www.example.com",
     "previewOrigin": "https://pre.example.com",
     "adminEmail": "admin@example.com"
   }
   ```

   For external presentation add `"presentation": "external"`, `"websiteGit"` (SSH address of the hosting's Git) and the files with its private key and known hosts (`productionGitKey`, `productionGitKnownHosts`). All fields are described at the top of `scripts/instance-adopt.mjs` and `scripts/instance-create.mjs`.
3. Run once inside the container: `node scripts/instance-create.mjs deployment.json`. The random password is printed once; only its hash is stored.
4. Map the ports: 4540 → editor address, 4512 → website domain (internal presentation), 4541 → public preview (optional). Use HTTPS and let `/.well-known/oauth-*` through to the application so MCP clients can sign in.

## Existing instance

Copy the instance folder (for example a local Playground) into the volume and run `node scripts/instance-adopt.mjs deployment.json` once before the first start. The draft, saved drafts, content and settings stay; the publication history comes from the server.
