# Agent Playbooks

This directory contains task-specific guidance referenced by `AGENTS.md`.

Use these files on demand:

- `architecture-boundaries.md`: guardrails for architectural changes.
- `bundled-binaries.md`: bundled node binaries (Ant, freedom-ipfs, Radicle, Arti) — what they are, where they land, and how to bump a pin.
- `code-style-and-linting.md`: lint-aware implementation workflow.
- `commit-messages.md`: commit title/body conventions.
- `changelog-process.md`: changelog fragments day to day, and assembling them at release.
- `merge-process.md`: landing one or a batch of approved pull requests on `main`.
- `release-process.md`: release branch, version bump, tag, build, and publish steps.
- `ui-consistency.md`: conventions and checks for renderer/UI changes; pairs with the `run-freedom` skill in `.claude/skills/`.
- `security-checklist.md`: pre-commit and pre-PR security checks.
- `windows-utm-build.md`: build and run a native Windows build in a UTM VM on macOS.

Keep `AGENTS.md` short and stable. Put detailed examples and process notes here.
