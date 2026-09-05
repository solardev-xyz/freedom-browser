# Changelog Process Playbook

Use this playbook when asked to update `CHANGELOG.md` for a new version.

## Procedure

1. Find the baseline commit. Prefer the previous release's tag, which is unambiguous regardless of dev-suffix bookkeeping:
   - `git rev-list -n 1 v<prev>` (e.g. `v0.7.0`).
   - Fallback if the tag is unavailable: `git log --oneline -p -- package.json` and pick the most recent version-line edit _before_ the current release branch's "promote dev version" commit. With the dev-suffix workflow, the baseline is normally the `chore(release): open <current>-dev cycle` commit on `main`.
2. Gather all commits since baseline:
   - `git log --pretty=format:"%H%n%s%n%b%n---" <baseline>..HEAD`
3. Get the release date from git history:
   - `git show -s --format="%ad" --date=short HEAD`
4. Categorize entries using Keep a Changelog headings, in this order:
   - `### Added`
   - `### Changed`
   - `### Deprecated` (when applicable)
   - `### Removed` (when applicable)
   - `### Fixed`
   - `### Security`

   The order matches Keep a Changelog and the project's prior releases. Do not reorder — `Security` last keeps the heaviest, most prose-dense section out of the reader's path when they're scanning for what changed for them. Omit any heading that has no entries.

5. Skip housekeeping commits:
   - TODO/changelog commits
   - version-bump commits, including `chore(release): open <next>-dev cycle` and `chore(release): bump version to <version>`
   - dependency lock-only updates
   - README/docs rewrites
   - internal refactors without user impact
   - test-only commits
   - **developer-only fixes**: console-noise cleanup on `npm start`, dev-server bugs, build/lint/CI issues, anything whose impact is only visible to people running from source. The changelog audience is the binary user — if the fix doesn't affect them, drop the entry.
   - **in-release polish**: fixes and refactors on functionality that didn't ship in the previous release. A "fix" to a feature first introduced in this release is part of how the feature shipped, not a regression a user would have hit. Drop the entry, or fold the user-visible aspect into the relevant `Added` parent.
6. Merge related commits into a single user-facing entry.
7. Inspect PR merge commits by reviewing underlying commits.
8. Re-run the git log before editing to catch late commits.
9. Prepend the new version section above the previous one. If a `## [Unreleased]` heading is present, replace it with `## [<version>] - <YYYY-MM-DD>`. If it is absent (rare, since the dev cycle on `main` accumulates entries under `[Unreleased]`), add the new version heading directly. When writing the first user-facing change in the next dev cycle, re-introduce a `## [Unreleased]` heading above the latest released version.

## Output Style

The shipped releases (e.g. `0.6.x`, `0.7.0`) are the canonical voice. When drafting a new release, read the most recent shipped entry first and match its density. Drift is easy and shows up immediately in side-by-side comparison.

### Density budget (check before the review gate)

The voice rules below are descriptive of the `0.6.x` / `0.7.x` shipped entries, not aspirational. Before presenting a draft for review, read it side-by-side with the previous shipped release in the same file. If your entries are visibly longer, or your sub-bullets are full sentences where the previous release used noun phrases, you've drifted — tighten until the comparison stops looking lopsided.

Mechanical sanity checks:

- Top-level bullets: aim ≤ 25 words.
- Sub-bullets: aim ≤ 15 words.
- Sub-bullets across the whole release: aim ≤ 10 total, excluding the per-package dependency sub-bullets (see Structure rules). If you're over, fold related surfaces into the parent or drop them.

Drift patterns to cut on sight (every one of these has shipped into a draft and had to be trimmed later):

- **Mechanism in user-facing copy.** RPC method names (`eth_call`), protocol terms ("Universal Resolver", "sync committee"), helper-function names — the reader doesn't need the protocol step. Leave it in the commit message and PR description.
- **"so X" tails justifying the change.** `Forward and reverse lookups are both verified, so the wallet's recipient-name display carries the same guarantee` — the parent bullet already conveys it; drop the tail.
- **Em-dash explanations expanding into mechanism.** `X keeps working — the prover does Y, ethers does Z, the final callback is independently proven`. The `X keeps working` half is the entry; drop the expansion.
- **Consecutive sub-bullets repeating their subject.** Two bullets both opening with `Wallet send review screen shows…` — open each with the distinct surface (`Green ✓ next to a verified name`, `Amber ⚠ next to a spoofed name`) and let the parent carry the shared context.
- **Defensive parentheticals.** `(zk-proven sync bootstrap by default)`, `(stale record or spoofing attempt)` — drop unless the reader genuinely can't infer the case.
- **Thin sub-bullet groups.** If a parent has only 1–2 sub-bullets and they add no surface variety, fold them into the parent.

If a sub-bullet runs past 20 words, opens with the same noun phrase as a sibling, or names an internal helper, rewrite it before committing.

### Voice rules (apply across all sections)

- **One thought per bullet.** If you joined two ideas with `;` or `. `, split into two bullets. Bullets are not paragraphs.
- **No bold lead-ins.** Every entry opens with plain prose. Bold is for inline emphasis only. Plain-text labels on explainer sub-bullets (e.g. `Reasoning: …` on a "why this matters" sub-bullet) are fine — the rule is about bold marketing emphasis, not structural clarity.
- **No trailing periods** on bullet entries.
- **No cross-references between sections.** Don't write "see Added" or "as in the Security entry above" — each bullet stands alone.
- **State user impact, not implementation.** Mechanism lives in the code, not the changelog. `Tab spinner stays on through ENS link clicks` — not `Tab spinner stays on because handler now awaits the resolver promise before clearing state`.
- **Warm, not selling.** The register of the shipped sections is plain description with room for a short tagline on the headline entry and the occasional friendly comparison: `Native x402 payment support — pay as you browse, straight from the built-in wallet:` (`0.7.4`), `shown in the bottom-left like Chrome and Firefox` (`0.7.2`), `Node data and Swarm identity migrate in place on first launch` (`0.8.0`). What does not belong is evaluation: adjectives that would fit a landing page (`honest`, `fully`, `real`, `the key never leaves it`, `at their own pace`). Say what it does and, on the headline, what it is for.
- **Explain the non-obvious with a `Reasoning:` sub-bullet**, as `0.7.1` (CID canonicalisation) and `0.8.0` (in-house Rust nodes) do. One line, plain-text label, for changes whose "why" a reader cannot infer from the "what". Verify the reasoning against the code or README before writing it.
- **Removed entries say why**, in a dash clause, as `0.8.0` does: `Local Kubo API and gateway ports (5001, 8080) — the embedded IPFS node exposes no local endpoints`. A bare "X was removed" leaves the reader guessing whether they lost something.
- **Drop internal commentary.** `(already latest)` next to a version, `(precautionary)` qualifiers, project-internal context: noise.
- **Migration guidance points to README**, doesn't duplicate it. Use a conversational pointer like `(see README for site-author migration)` rather than inlining the migration content.
- **Click paths use `Settings > Submenu > Item`.** Space-separated `>` matches the project's prior changelogs (e.g. `Settings > Experimental` from `0.7.0`). Do not use arrows (`→`) or breadcrumb glyphs, and don't backtick the path. The bare `Settings > …` form reads as a UI location, not a code identifier.
- **Contributor credits are inline, on the entry.** Credit external contributors as `(thanks @handle!)` on their most significant entry; further entries from the same contributor in the same release use the shorter `(also @handle)`. No separate thanks section, no credits for maintainers.
- **No decorative Unicode glyphs in entry prose.** Symbols like `✓`, `⚠`, `↳`, `→`, or emoji don't belong inline as visual emphasis. Describe UI affordances in plain words (`verification mark`, `warning`, `spinner`) and let the user encounter the glyph in the app. For version transitions, write `Bee 2.7.0 to 2.7.1`, not `Bee 2.7.0 → 2.7.1` — even technical from-to arrows count as decorative here.

### Per-section voice

| Section  | Lead pattern                                                         | Example                                                               |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Added    | noun phrase (the _thing_ added)                                      | `Verification shield in the address bar`                              |
| Changed  | noun phrase or subject-led                                           | `Speculative gateway prefetch during ENS quorum waves`                |
| Security | imperative verb-led for actions taken, subject-led for state changes | `Pinned uuid to ^14.0.0`; `Multi-RPC quorum required for ENS lookups` |
| Fixed    | subject-led "X now does Y" / "X no longer does Y"                    | `Tab loading spinner stays on through ENS link clicks`                |

### Structure rules

- **Lead `Added` with the release's defining feature.** Every shipped section opens with its headline (`0.7.0` wallet, `0.7.2` Colibri verification, `0.7.4` x402, `0.8.0` Rust nodes); readers take the first bullet as the release's identity. Protocol, wallet and node features rank above browser-chrome conveniences unless the release really is about the chrome. `package.json`'s `description` is a fair signal of what the maintainers consider headline.
- **Multi-surface features = one parent bullet + sub-bullets**, not multiple top-level entries. The `0.7.0` `Experimental Identity & Wallet system:` block is the model.
- **A bundled component shipping for the first time is named with its version and an upstream link** in its `Added` parent, as `0.8.0` did for `[Ant](https://github.com/freedom-hq/ant) 0.5.33` and `[freedom-ipfs](https://github.com/solardev-xyz/freedom-ipfs) 0.4.3`. Take the version from the pin in the matching `scripts/fetch-*.js` at the release head, not from memory. Later cycles then have a baseline for `name old to new`.
- **Update lines carry no feature summaries.** `Updated bundled nodes:` / `Updated runtime dependencies:` sub-bullets are `name old to new` and nothing else (the one exception is Electron's Chromium/Node detail, below). If a node update changes something the user can see — peers counting up at launch, an upload that no longer stalls, a clearer error — that is its own `Changed` or `Fixed` entry, where `0.8.0` put `Radicle peer discovery follows the community seeds' move to radicle.network`. Packing it into a parenthetical on the version line hides it from anyone scanning for what changed for them.
- **Dependency updates are one-per-line sub-bullets under a category lead.** Group by category (`Updated runtime dependencies:`, `Updated dev dependencies:`, `Updated bundled nodes:`) as the top-level bullet, then list each package on its own sub-bullet as `name old to new`. This keeps long Electron version strings (with their Chromium/Node detail) readable instead of buried mid-line. Example:

```
- Updated runtime dependencies:
  - Electron 41.7.0 to 41.7.1 (Chromium 146.0.7680.216, Node 24.15.0 — same as 41.7.0; Electron-side patches only)
  - `@corpus-core/colibri-stateless` 1.1.26 to 1.1.28
- Updated dev dependencies:
  - `eslint` 10.4.0 to 10.4.1
```

### Section choice and deduplication

Each shipped change appears exactly once. **Before placing an entry in `Changed`, `Fixed`, or `Security`, run the previous-release test: did the affected surface ship in the previous release?**

- **No** — the entry belongs in `Added` (as a sub-bullet of the parent feature, or as the parent itself), or is dropped entirely. Fixes and refactors on functionality that never shipped to users are part of how the new feature was developed, not regressions a user would have hit. A bug introduced and fixed within the same release cycle never reached users; describing it in `Fixed` would falsely advertise a regression that didn't exist for them. Fold the user-visible property into the relevant `Added` bullet, or drop it if it's just "the feature works as expected".
- **Yes, and it now behaves differently** — `Changed` / `Fixed` / `Security` depending on the kind of difference.
- **Yes, unchanged** — no entry.

Common deduplication failures:

- **Added ↔ Security**: a new feature with security motivation belongs in `Added`, not in both. Don't restate the threat-model framing as a separate `Security` bullet — the `Added` entry's user-facing surface (toggle name, settings page, interstitial) already conveys the property.
- **Added ↔ Fixed**: polish on a feature that ships in this release is part of `Added`, not a separate `Fixed` entry. "X consistently with Y" or "X tightens its CSP" on a brand-new X is how it shipped, not a regression fix.

### Security is not only version bumps

Every shipped `Security` section except `0.7.3` lists at least one actual hardening besides dependency updates — CSP headers (`0.6.1`), IPC input validation (`0.6.2`), permission prompts keyed on the committed page URL (`0.7.2`). Before finalising, sweep the cycle specifically for hardening a user or dApp author would notice (origin checks, consent models, isolation, validation) and add it in `0.7.2`'s subject-led form. If the sweep finds nothing, say so in the review note with the PRs checked; a `Security` section that is only bumps should be a finding, not an omission.

### Categorising dependency updates

Dependency updates inside an active major series almost always carry upstream security fixes. Default to **Security** for these (matching `0.6.1`'s `Updated dependencies: Electron 39 to 40, …` placement). Use Changed only when the bump is purely a feature pickup with no security content.

**Electron updates always state the bundled Chromium and Node versions.** Security-aware users track CVE coverage by Chromium and Node version, not by Electron version. Look them up in `https://releases.electronjs.org/releases.json` (one entry per Electron version, with `chrome` / `node` / `v8` fields).

Format: `Updated Electron <old> to <new> (Chromium <old> to <new>, Node <old> to <new>)`. Use the full upstream version strings, not the marketing-major (`Chromium 146.0.7680.216`, not `Chromium 146`). If Chromium or Node did not change between the two Electron versions, still name the version that's bundled — knowing which Chromium/Node ships is the point, regardless of whether it moved this cycle:

- Both moved: `Updated Electron 41 to 42 (Chromium 146.0.7680.216 to 148.0.7778.97, Node 24.15.0 unchanged)`
- Neither moved: `Updated Electron 41.5.0 to 41.7.0 (Chromium 146.0.7680.216, Node 24.15.0 — same as 41.5.0; Electron-side patches only)`

The vague historical phrasing (`Chromium and Node patches`, used in `0.7.1`'s `Electron 41.2.1 to 41.5.0`) is **not enough** — it doesn't let a reader confirm which Chromium they're getting, and in `0.7.2`'s case it was even inaccurate (Chromium/Node didn't actually change between 41.5.0 and 41.7.0).

**Skip in-release version drift for dependencies first added in this release.** If `foo` is added at `1.0.0` mid-cycle and bumped to `1.0.2` before the release ships, users only ever see `1.0.2` — listing `foo 1.0.0 to 1.0.2` in `Security` misrepresents in-release iteration as a security update on a previously shipped surface. Mention the dep once, in the `Added` parent for the feature it backs, and let its shipping version stand on its own. Same logic as the in-release polish rule for fixes (Procedure step 5).

### Review gate

An agent draft is a starting point, not a final. After drafting, diff the new section against the previous shipped release and trim/restructure until per-entry density matches. Compare more than word counts: lead patterns per section, whether first-shipped components carry version and link, whether update lines stay bare, and register (a `0.8.5` draft matched `0.8.0`'s headings and bullet counts while drifting on all four).

**Nothing disappears silently.** When a draft trims or replaces entries that were already in `[Unreleased]` (or in an earlier agent draft), the PR or review note lists what was dropped and why — "Ant internals with no Freedom UI surface", "duplicate of the Added parent" — so the releaser decides, not the compressor. Restoring a dropped capability requires checking in `src/` that a user can actually reach it in this build; the old text is not evidence.

**Do not land the changelog edits until the releaser has reviewed them.** Two equivalent ways to hold the gate: leave the `CHANGELOG.md` changes unstaged on the release branch and present the diff, creating the `docs(changelog): …` commit only after explicit approval; or, when the draft comes from an agent working on its own branch, open a PR **against the release branch** (not `main`) that touches only `CHANGELOG.md` — the PR is the presentation and the releaser's merge is the approval. Either way, keep `## [Unreleased]` as the heading while the release is still in candidates; the rename to `## [<version>] - <date>` happens when the bare version is cut. See `release-process.md` for how the gate sequences against verify / build / upload / tag.
