# Changelog

Versions follow [semantic versioning](https://semver.org). Each release is tagged `v<version>`.

## 1.3.0

- Completeness check (documentation 4.11): before every publication the AI Studio shows what a finished website is expected to have, as ✓ or ⚠ in six groups – face of the website (icon, titles, descriptions), search engines (one h1, lang, sitemap.xml, robots.txt, canonical, readable addresses), sharing (Open Graph), accessibility (alt, contrast, heading order), EU rules (contact, personal data information for forms, consent to tracking cookies) and function (404 page, image sizes). It only reports and never blocks; Fix in AI Studio prefills the request. An AI part (the Verifier of the default team) judges whether the texts fit the content; the result is kept per commit. Without an AI key only the rules run.
- Completeness check is also a third check of a request (off by default) and an MCP tool check_completeness; publish_step returns the result.
- Check external links too: on a click, HEAD/GET to the public addresses the website links to, with the same protection as loading a website; nothing is kept.
- Prepare the website icon: a fixed host step makes favicon.ico, favicon-32.png and apple-touch-icon.png from one square image and links them in every page. The Website elements template has a prepared Website icon entry.

## 1.2.0

- One header for the Content editor, AI Studio, Settings and the Structure editor: the studio switch as two icons (document, sparkles) beside the website name; the menu holds Settings and Log out. Settings and the Structure editor have a side band with their own icon, Back and their sections.
- Colour mode Light / Dark for the whole application (Settings → Interface → Default colour mode) instead of the environment colours; all colours are one set of CSS variables. The sun/moon in AI Studio and the new toggle above the Content editor's form switch every part until the next opening.
- Content editor: a toolbar above the form and the files (colour mode, Live website); the form scrolls inside its own frame like the AI Studio preview; no width limit; clicking an image in a folder or in the form shows it large, modally.
- Structure editor: the field table fits without sideways scrolling; Unique key is a checkbox in the table; Displayed item name and Filters and grouping are checkboxes in the field detail; fields are reordered by dragging; Add field under the table.
- AI Studio: the tabs Edits / Saved / Published; the preview's scrollbar follows the colour mode; an image of the content the agent reads is shown to it and can be the source of an image edit (the result goes back to the content as a new file).
- The SiteTiller icon and the tab title "SiteTiller · <website name>" in every part of the application.
- A preview of the website opened on its own shows the website's icon, or an empty one when the website has none, never the SiteTiller icon.
- A new installation has an English interface; `language: "cs"` in deployment.json for Czech. Existing instances keep their language.

## 1.1.1

- MCP: every tool is listed even without its permission (an assistant reads the list once when it connects, so a permission turned on later still finds its tool); the description says which permission it needs. get_overview says what the public preview shows (the live preview of the latest step) and offers the private preview_link.

## 1.1.0

- A new website or a redesign whose Web Lead leaves out the acceptance criteria: the Web Lead is asked for them again (at most twice) with the candidate kept; only then the request ends with a reason the user can act on.
- The bundled recommendation sets follow the published ones (SiteTiller-advice).

## 1.0.9

- The supervised services run with a small V8 young generation (`--max-semi-space-size=1`): 10–16 MB less each while working.
- The Shell logs when a service is woken, how long it took to be ready, and when it falls asleep.

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
