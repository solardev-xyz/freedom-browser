# Agent Instructions

This file defines mandatory constraints for automated agents and contributors. In case of conflict or ambiguity, this file takes precedence over `README.md`.

## Core Rules (Always Apply)

1. Never delete files unless the user specifically asks for it or confirms it.
2. Do not commit secrets, credentials, API keys, or tokens.
3. Do not comment out code to disable it; remove code instead.
4. Before writing code, read `eslint.config.js` and follow active linting conventions.
5. After code changes, run `npm run lint` and fix any introduced errors or warnings.
6. Do not change top-level package boundaries or module responsibilities described in `README.md` unless explicitly instructed.
7. Match existing naming and file conventions in nearby code. Do not reformat or change behavior outside the requested scope.
8. Run `npm test` after modifying files that have corresponding `.test.js` files.
9. Do not add or upgrade dependencies without user approval.

## Task Routing (Read On Demand)

Before executing task-specific work, read the corresponding playbook:

- Architecture-sensitive changes _(adding files to `src/main/` or `src/renderer/`, creating new IPC channels, moving logic between processes)_: `docs/agent-playbooks/architecture-boundaries.md`
- Renderer/UI changes _(anything under `src/renderer/`: chrome, sidebar, settings, internal pages; and reviewing such changes)_: `docs/agent-playbooks/ui-consistency.md`
- Commit message conventions _(any git commit)_: `docs/agent-playbooks/commit-messages.md`
- Changelog updates _(version bumps, release prep)_: `docs/agent-playbooks/changelog-process.md`
- Cutting a release _(release branch, version bump, tag, build, publish)_: `docs/agent-playbooks/release-process.md`
- Security checklist _(before commit or PR)_: `docs/agent-playbooks/security-checklist.md`
- Windows build in a UTM VM _(building/running a native Windows build on macOS for testing)_: `docs/agent-playbooks/windows-utm-build.md`

If multiple categories apply, read all relevant playbooks.
