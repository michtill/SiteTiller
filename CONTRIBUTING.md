# Contributing

Use Node.js 24+ and pnpm 11.19.0. Install Chromium with pnpm exec playwright install chromium, then run pnpm test. Tests use fake providers and must not require real API keys. Keep machine contracts in English, add both Czech and English UI labels, and preserve snapshot/publication guards. Submit a pull request with the concrete problem, changes and validation. Never commit provider keys, passwords, real user sites or data volumes.

The example workflow is in docs/ci-test.yml. To enable GitHub Actions, copy it to .github/workflows/test.yml using credentials with workflow permission. The initial CLI authorization did not include that additional scope.
