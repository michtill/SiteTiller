# Changelog

Versions follow [semantic versioning](https://semver.org). Each release is tagged `v<version>`.

## 1.0.8

- Same application as 1.0.7. Stopping the Playground works outside Windows too (the recorded process is checked in /proc and stopped with SIGTERM), which made the CI of 1.0.7 fail.

## 1.0.7

- Unused parts sleep and free their memory: the Shell supervises the instance, holds the ports of the other services and starts each with its first request (browser, MCP or another service); after the idle time it stops them for real. A working AI Studio, a service with an open connection and the Website of an internal presentation never sleep. Settings → Interface → Operation: after 5, 15 (default), 30 or 60 minutes, or never. A sleeping studio shows Waking up and loads again.
- The container launcher becomes the Shell itself (one process less); the Playground starts only the Shell.
- The status point for an outside waker (1.0.5) is removed.

## 1.0.6

- Same application as 1.0.5. The MCP tests wait and try again when the server answers 429 (the per-minute call limit), which made the CI of 1.0.5 fail.

## 1.0.5

- More AI teams: recommended teams from named recommendation sets (e.g. Performance, Eco) and any number of named own teams; a default team; every team is valid. Settings → AI Studio models shows a tab per team in place, with Make default, Update, New team (a copy), rename, Save and Delete (not the default team). An older team becomes the own team "Vlastní tým".
- The team is chosen for each request in the AI Studio, in one choice with the two checks (technical check, verification); it is frozen for the whole request and the step shows which team made it.
- Recommendation sets are read from SiteTiller-advice `models/v2.json`; the newer file is told by its revision number, the date is the real day of publication.
- After sign-in without a target the home page with both studios is shown.
- MCP: the structure templates of the Content editor (`list_structure_templates`, `apply_structure_templates`).
- Settings: a new website name shows in the side band at once after Save, in plain letters.
- Instance status for a waker in front of a stopped instance: `GET /__sitetiller/status` with the token from `settings/status.token`.

## 1.0.4

- AI models: one AI team group with tabs Recommended team / Own team; a tab switches at once in place, the team in use has a green dot and a line under the tabs; Update checks the newest recommendation; the own team comes back as it was.
- Recommendations are read from the separate repository [SiteTiller-advice](https://github.com/michtill/SiteTiller-advice) (`models/v1.json`, `images/v1.json`), so a release never overwrites them; a new shape gets a new file.
- The Verifier is recommended from another provider than the Web Lead first.
- Model options read "provider · model"; Google's models show as "Google · Gemini …" (no Gemini twice).
- The API key field is no password field: the browser no longer offers to save the key.

## 1.0.3

- Google Gemini auth keys (`AQ.…`, created by Google AI Studio since 2026) are recognised next to the standard `AIza…` keys; both are checked with Gemini's model list and sent in the `x-goog-api-key` header.

## 1.0.2

- Google Gemini image models in the image tools (precise edits, fast generation); results are converted to the requested format (WebP/JPEG), otherwise the PNG stays with an exact note; a transparent background is available with OpenAI only.
- Separate recommendation for the image tools (`packages/models/recommended-images.json`); automatic team set-up follows it too. A change of a recommendation's format gets a new file, so older instances keep reading theirs.
- Recommended model IDs checked against the providers' public pages.

## 1.0.1

- Google Gemini as a third AI provider for all four text roles of the AI Studio team.
- One field for API keys: the provider is recognised from the key; table of saved keys, replace with confirmation, remove.
- Recommended models shipped with each release (`packages/models/recommended.json`); optional automatic team set-up from the current recommendation (off by default).
- Structure templates in the Content editor (Contacts, Website elements, Images, Pages); parent links never form a cycle; renaming a key updates links; a folder used by a field cannot be removed.
- One confirmation dialog for the whole application, colours per part.
- AI Studio: Share next to Open, Live website as a button, permanent live preview link in the share dialog, preview info corner also in opened and shared previews.
- Settings: buttons to the studios instead of Back; the Content editor keeps its write token across restarts.

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
