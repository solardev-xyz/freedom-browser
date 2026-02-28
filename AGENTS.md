# Agent Instructions

This file defines mandatory constraints for automated agents and contributors. In case of conflict or ambiguity, this file takes precedence over `README.md`.

## Core Rules (Always Apply)

1. Never delete files unless the user specifically asks for it or confirms it.
2. Do not commit secrets, credentials, API keys, or tokens.
3. Do not comment out code to disable it; remove code instead.
4. Before writing code, read `eslint.config.js` and follow active linting conventions.
5. After code changes, run `npm run lint` and fix any introduced errors or warnings.
6. Do not change top-level package boundaries or module responsibilities described in `README.md` unless explicitly instructed.

## Task Routing (Read On Demand)

Before executing task-specific work, read the corresponding playbook:

- Architecture-sensitive changes: `docs/agent-playbooks/architecture-boundaries.md`
- Code style and linting workflow: `docs/agent-playbooks/code-style-and-linting.md`
- Commit message conventions: `docs/agent-playbooks/commit-messages.md`
- Changelog updates: `docs/agent-playbooks/changelog-process.md`
- Security checklist before commit/PR: `docs/agent-playbooks/security-checklist.md`

If multiple categories apply, read all relevant playbooks.
