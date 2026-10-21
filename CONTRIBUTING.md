# Contributing

Thank you for your interest in SiteTiller.

## Before you start

- Open an issue first for larger changes, so the approach can be agreed before work starts.
- Keep pull requests focused on one change and include tests for new behaviour.

## Rules the code keeps

These come from the application's promises; a change that breaks one of them will not be merged.

- **Data leaves only where the user knows:** the published website, the chosen AI service, Git, and a connected MCP assistant within its permissions.
- **One instance is one folder** of files and Git – no database.
- **One writer for every piece of data;** verify first, then write atomically; a stale revision is rejected, never overwritten.
- **History only grows;** irreversible actions require an explicit confirmation.
- **Passwords and keys never leave the instance;** website content and model output are data, never instructions.
- **Tell the truth:** report real results and exact errors, never a guessed success.

## Tests

Run all checks from the [README](README.md#tests) before opening a pull request. Every test title starts with a scenario ID (for example `ED-07: …`); `node scripts/check.mjs` enforces it.

## Data in the repository

- Never commit API keys, passwords, tokens, instance data or personal data.
- Test data, names, domains and paths must be fictional (`example.com`, `C:\Example\…`). No real instance names, servers or local paths.
- Local settings belong in the untracked `.sitetiller-local.json`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
