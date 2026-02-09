# Agent Instructions

This file defines operational constraints and conventions for automated agents and contributors interacting with this repository. In case of conflict or ambiguity, this file takes precedence over README.md.

## General Rules

Never delete files unless the user specifically asks for it or you have confirmed with the user first.

## Architecture

High-level architecture and design rationale are documented in README.md. Agents should familiarize themselves with it before making structural changes.

Agents must not change top-level package boundaries or module responsibilities described in README.md without explicit instruction.

## Security

Do not commit secrets, credentials, API keys, or tokens to the repository.

## Code Changes

Do not comment out code to disable it. Remove the code entirely and add it back later if needed.

## Code Style and Linting

Before writing code, read `eslint.config.js` to understand the project's coding standards and active rules. Follow these conventions in all code you produce.

After making code changes, run `npm run lint` to check the entire project for ESLint errors. Fix any errors or warnings you introduced before considering the task complete.

## Generating a Changelog Entry

When asked to update the changelog for a new version (e.g. 0.6.1):

1. **Find the baseline commit** — Use `git log --oneline -p -- package.json` to find the commit where the version was last bumped. That commit (or the changelog update commit for the previous version) is your baseline.
2. **Get all commits since then** — Run `git log --pretty=format:"%H%n%s%n%b%n---" <baseline>..HEAD` to see commit hashes, subjects, and bodies. Read the commit bodies carefully — they often contain the most useful detail (bullet points, rationale).
3. **Get the date** — Use `git show -s --format="%ad" --date=short HEAD` or the most recent non-housekeeping commit for the release date. Don't assume today's date.
4. **Categorize changes** into `### Added`, `### Changed`, `### Fixed`, and `### Security` sections following [Keep a Changelog](https://keepachangelog.com/) conventions. Use `### Security` for CSP, dependency updates, vulnerability fixes, and access control changes. Also use `### Deprecated` and `### Removed` when applicable.
5. **Skip housekeeping commits** — TODO updates, changelog updates, version bumps, dependency lock file changes, README/docs rewrites, internal refactoring (code splits, module renames, logging infrastructure, build script reorganization), and test-only commits should not appear in the changelog.
6. **Merge related commits** — If multiple commits relate to the same feature (e.g. a feature commit followed by a fix for it), combine them into a single changelog entry.
7. **Check PR merge commits** — Merge commits are just pointers. Examine the individual commits within each merged PR to ensure nothing is missed.
8. **Re-check before applying** — Re-run `git log` immediately before writing the changelog to catch any commits added during the conversation.
9. **Prepend** the new version section (e.g. `## [0.6.1] - 2025-12-28`) above the previous version entry in `CHANGELOG.md`.
