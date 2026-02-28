# Code Style and Linting Playbook

Use this playbook for all code edits.

## Workflow

1. Read `eslint.config.js` before writing code.
2. Implement the smallest change that satisfies the request.
3. Run `npm run lint` after substantive code changes.
4. Fix introduced lint errors/warnings before finalizing.

## Style Priorities

- Match existing naming and file conventions in nearby code.
- Prefer clear code over clever code.
- Keep comments minimal and only where context is not obvious from code.

## Scope Control

- Do not reformat unrelated files.
- Do not change behavior outside the requested scope unless needed for correctness.
