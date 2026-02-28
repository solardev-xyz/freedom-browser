# Commit Messages Playbook

Use Conventional Commit style:

`<type>(<scope>): <summary>`

## Types

Allowed types:

`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `perf`, `revert`

## Scope Guidance

Use meaningful scopes from this repository, such as:

`radicle`, `ipfs`, `renderer`, `main`, `github-bridge`, `build`, `docs`

## Summary Guidance

- Use imperative mood (for example: "add", "fix", "normalize").
- Keep it specific and user-impact focused.
- Avoid trailing punctuation.

## Body Guidance

Add a body for non-trivial changes:

- Explain why the change was needed.
- Mention visible behavior impact or risk reduction.

## Breaking Changes

Mark breaking changes with `!` (for example `feat(api)!:`) and/or include a `BREAKING CHANGE:` footer in the body.

## Examples

- `fix(radicle-ui): normalize node menu loading placeholders`
- `feat(github-bridge): add preflight validation for imports`
- `docs(agents): add commit message guidelines`
