# Contributing to Freedom Browser

Thanks for helping build a browser for the decentralized web. Contributions to code, tests, documentation, issue triage, and reproducible bug reports are welcome.

## Before you start

- Search the [issue tracker](https://github.com/solardev-xyz/freedom-browser/issues) before opening a report or proposing work.
- For a bug fix, comment on the relevant issue or open a structured bug report.
- For a feature, major refactor, dependency change, or architectural change, open an issue first so maintainers and contributors can agree on scope.
- Keep changes focused. Unrelated cleanup makes review and regression analysis harder.

## Set up the project

Freedom uses Node.js 24 LTS. Follow the [development guide](docs/development.md) to install the pinned version, dependencies, and native node binaries.

Create a branch from an up-to-date `main` branch. Match the naming and organization of nearby code, and read the repository's [architecture boundaries](docs/agent-playbooks/architecture-boundaries.md) before changing process responsibilities or IPC.

Do not add or upgrade dependencies without maintainer approval. Dependencies affect the browser's attack surface, native builds, package size, and license obligations.

## Make and verify changes

- Add or update tests for behavior changes and regressions.
- Run `npm run lint` after code changes and fix introduced errors or warnings.
- Run `npm test` when modifying files with corresponding `.test.js` files.
- Run the relevant Playwright or live smoke suite when the change affects UI flows, protocols, or native nodes.
- Run `npx prettier --check` on the files you touched (the repo-wide `npm run format:check` currently fails on pre-existing formatting drift) and `git diff --check` before submitting.
- Never commit secrets, API keys, tokens, private keys, seed phrases, unredacted personal data, or signing credentials.

The cross-platform CI matrix runs additional native and integration checks. If you cannot run one of those locally, state that clearly in the pull request rather than marking it as completed.

## Commits and pull requests

Use Conventional Commit subjects:

```text
<type>(<scope>): <imperative summary>
```

The allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `perf`, and `revert`. Explain why a non-trivial change is needed in the commit body.

Pull requests should:

- Link the relevant issue.
- Explain the problem and the chosen approach.
- Describe user-visible impact and risk.
- List the checks actually run.
- Include screenshots or recordings for visible UI changes. For anything under
  `src/renderer/`, before/after screenshots in **both** themes are required —
  see the pull request template and
  [docs/agent-playbooks/ui-consistency.md](docs/agent-playbooks/ui-consistency.md).
- Remain available for review questions and follow-up changes.

Draft pull requests are welcome for early feedback. Maintainers decide whether and when a contribution fits the product roadmap.

## AI-assisted contributions

AI assistance is allowed, but a human must remain accountable for every submission. You must review and understand everything you submit, verify generated claims and tests, and be able to explain and maintain the result. Disclose material AI assistance in the pull request. Unreviewed automated submissions or bot-only conversations may be closed.

## Licensing

Freedom Browser is licensed under the [Mozilla Public License 2.0](LICENSE). Unless explicitly agreed otherwise, submitted contributions are made available under MPL-2.0. Only submit work you have the right to contribute, preserve applicable notices, and do not copy material with incompatible license terms.

If a report may expose a security vulnerability, do not include exploit details, keys, credentials, or sensitive user data in a public issue. Contact `browser@freedom.baby` before public disclosure.
