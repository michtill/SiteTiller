# Architecture

The studio controls a private Git repository. Every accepted edit is a commit. A dedicated preview service reads those commits and isolates user website scripts from the authenticated studio. The publisher has read-only access to studio data and write access only to a fixed production target.

Web Lead combines routing, implementation and basic design. Small edits do not run a fixed team pipeline. Large creative or complex work can use the UI/Code specialist; image capabilities are tools. Deterministic file/browser checks run before accepting work. A read-only verifier judges required criteria for significant changes. One repair precedes bounded escalation; failed changes leave HEAD intact.

Role/model mappings are in `src/team.ts` and configurable in Settings. Agent contracts are in `src/instructions.ts`, `src/orchestrator.ts` and `src/workflow.ts`. Models communicate with concise English JSON. Human-facing fields follow the original user's request language; English specialist task descriptions must not change it. User content is not treated as system instructions.

Conversation memory is bounded to six active recent turns and targeted older lookup. The manifest supplies a compact file map; models load only relevant files. Website content, API keys and raw provider transcripts are not sent between all roles by default.

Publication selects a fixed approved commit and performs technical checks again. It is separate from creating or loading drafts. Major versions increment the number. Subversions append a record with `minor`, preserving the original version and immutable tags. The UI groups publications by major number and collapses older subversions.

The English UI catalog is in `public/translations.js`; Czech source strings are the canonical keys. `public/i18n.js` translates fixed UI text, never arbitrary website content. Language selection is browser-local, with an installation default. Historic model replies keep their original language. The model prompt language is independent of the UI setting.

The system edits static files, not server infrastructure or arbitrary dependency builds. Deterministic browser tests run in an isolated local context with external services blocked. Hosting-level TLS, network policy and production credentials remain administrator responsibilities.
