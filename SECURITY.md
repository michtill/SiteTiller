# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** in this repository. You will get an answer as soon as possible; please give us reasonable time to fix the issue before you disclose it.

## Supported versions

Security fixes are made for the latest released version only.

## Scope notes

- An instance is meant for one owner (occasionally two people at once). Previews of steps and versions are not confidential; a shared preview link (`/s/…`) is unguessable but visible to anyone who has it until it expires or is revoked.
- All services listen on loopback; only the Shell (4540), the website (4512) and the optional public preview (4541) are meant to be exposed, behind a reverse proxy with TLS.
- API keys are stored encrypted with the instance's master key and are never returned to the browser or to MCP clients.
