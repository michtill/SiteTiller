# Changelog

Versions follow [semantic versioning](https://semver.org). Each release is tagged `v<version>`.

## 1.0.0 – Muse

First stable release of SiteTiller, version 1 named **Muse**: a self-hosted CMS, AI Studio and MCP server for building any website in three layers – Structure → Content → Presentation.

- Content editor with Structure editor, records, files, content publishing and live editing.
- AI Studio with a team of AI agents, steps with previews, saved drafts, numbered versions and loading of an existing website.
- MCP server with OAuth 2.1 and access tokens, permissions (Read, Edit draft, Delete, Publish) and three levels of checks.
- Shared preview links with an expiry; optional public preview.
- Internal or external presentation (static website pushed to the hosting's Git, PHP contact forms).
- One container with one data volume; one-step creation of a new instance.

## 0.28.x

- MCP tools to list and revoke shared links; private preview links for steps, drafts and versions.
- Public preview address set in Settings; new preview indicator.
- Rejected API keys are not saved and the reason is shown; one confirmation dialog for the whole application.

## 0.27.0

- Administrator e-mail, sending e-mail and password reset.
- Settings as one area; new first step after publishing or saving; previews of content-only steps.
- AI must read a file before changing it; separate sign-in for local instances.

## 0.26.0

- Static production website on a Git branch; new empty instance with one command.
- Warning before publishing over a foreign change of the website; internal and external presentation.

## 0.25.x

- Runs as an application of a hosting panel (`compose.yml`); production Git over SSH; runs under any user.

## 0.24.0

- First public release under the MIT license.
