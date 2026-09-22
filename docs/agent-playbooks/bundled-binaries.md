# Bundled Node Binaries (Ant, freedom-ipfs, Radicle, Arti)

Day-to-day operator guide for the node binaries and native addons Freedom ships:
what they are, where they come from, and how to bump a pin. Release-time checks
stay in [`release-process.md` § Bundled binaries](release-process.md) — this file
links there rather than restating it.

## Glossary — read this first

- **Ant / `antd`** — Freedom's bundled Swarm node: a Bee-API-compatible
  implementation published at <https://github.com/freedom-hq/ant> (formerly
  `solardev-xyz/ant`). It replaced Bee in
  [#98](https://github.com/solardev-xyz/freedom-browser/pull/98). A task that
  says "ant", "antd" or "the Swarm node" in this repo means **this**. It is
  **not** Apache Ant (the Java build tool) and **not** Autonomi/MaidSafe's
  `ant` CLI. Fetch script `scripts/fetch-ant.js`; pin `PINNED_RELEASE_TAG` +
  `PINNED_SHA256SUMS_DIGEST` in that script.
- **freedom-ipfs** — the native IPFS addon (`freedom_ipfs_native.node`) from
  <https://github.com/solardev-xyz/freedom-ipfs>, loaded in the Electron main
  process instead of running a loopback Kubo daemon. Fetch script
  `scripts/fetch-freedom-ipfs-native.js`; pin = `releaseTag` plus the
  per-asset `sha256` entries in `prebuiltAssets` in that script.
- **Radicle / libradicle** — the native Radicle addon (`libradicle.node`) from
  <https://github.com/solardev-xyz/libradicle>; since
  [#194](https://github.com/solardev-xyz/freedom-browser/pull/194) there is no
  `radicle-node`/`radicle-httpd`/CLI path at all. Fetch script
  `scripts/fetch-radicle-addon.js`; pin = `RADICLE_ADDON_VERSION` in
  `src/shared/radicle-addon-version.js` plus `PINNED_SHA256SUMS` in the fetch
  script.
- **Arti** — the Tor client, bundled where the build carries one (macOS arm64,
  Linux x64/arm64, Windows x64). Unlike the others it is **compiled from
  crates.io**, host-only, not downloaded. Fetch script `scripts/fetch-arti.js`;
  pin `PINNED_ARTI_VERSION` (and `MIN_RUST_VERSION`) in that script.

Adjacent but out of scope here: **Myotis** (the experimental Ethereum light
client addon, `scripts/fetch-myotis.js`, `npm run myotis:download`) follows the
same shape and is covered by `npm run check-binaries` too.

## Where each binary lands, and how to fetch it

| Binary       | Lands at (source build)                                                                                                                            | Fetch command              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Ant          | `ant-bin/<os>-<arch>/antd` (`antd.exe` on Windows)                                                                                                 | `npm run ant:download`     |
| freedom-ipfs | `native/freedom-ipfs-node/build/Release/freedom_ipfs_native.node` (prebuilds cached under `native/freedom-ipfs-node/prebuilds/<platform>-<arch>/`) | `npm run ipfs:download`    |
| Radicle      | `radicle-bin/<platform>-<arch>/libradicle.node`                                                                                                    | `npm run radicle:download` |
| Arti         | `arti-bin/<platform>-<arch>/arti` (`arti.exe` on Windows)                                                                                          | `npm run tor:download`     |

`os`/`arch` are this repo's own names (`mac`/`linux`/`win` × `arm64`/`x64`), not
Node's. Packaged builds drop the `<os>-<arch>/` level (only the target's own
binaries ship), so `ant-bin/`, `radicle-bin/` and `arti-bin/` land at
`<resources>/ant-bin/`, `<resources>/radicle-bin/` and `<resources>/arti-bin/`
— `extraResources` in `package.json`, read back by `getAntBinaryPath()`
(`src/main/ant-manager.js`), `candidatePaths()` (`src/main/radicle-embedded.js`)
and `getArtiBinaryPath()` (`src/main/tor-manager.js`); see also
`docs/features.md` § the node table. These directories are gitignored, so a
refresh usually produces no file-tree change.

After any fetch, `npm run check-binaries` checks that every binary/addon a
target needs is actually on disk (plus, for Myotis, its checkpoint provenance).
It is a presence check, not a version check — compare self-reported versions
against the pins as described in `release-process.md` § Bundled binaries.

### How the app starts Ant

`src/main/ant-manager.js` owns the lifecycle. It writes a Bee-compatible
`config.yaml` into the profile's `ant-data/` directory and spawns
`antd --config=<path> --no-control-socket`; `config/ant.yaml` is the **dev
sample** of that file (used by `npm run ant:init` / `npm run system-ant:start`),
not the file the app runs from.

Ports matter when you are judging evidence:

- A Freedom-managed profile gets its own port — base **11633** in packaged
  builds, **21633** in dev (`PACKAGED_PORT_BASE` / `DEV_PORT_BASE` in
  `src/main/profile-catalog.js`), plus the profile slot. `getManagedPorts()`
  also adds a per-checkout offset, but **in dev only** — it is hard-coded to
  `0` when `dev` is false, so a packaged build's first profile is 11633 flat,
  while a dev checkout sits anywhere in 21633–22623 (offset up to +990, so
  parallel checkouts do not collide). Either way the manager walks upward if
  the port is busy. `npm run ant:status` defaults to
  `http://127.0.0.1:11633` — correct for a packaged build, never right for a
  dev run.
- **1633** is the ecosystem default, i.e. a _system_ Ant/Bee node
  (`DEFAULTS.ant.apiPort` in `src/main/service-registry.js`;
  `npm run system-ant:start` / `system-ant:status` drive it). If something is
  already answering there, the manager **adopts** it and reports
  `mode: "reused"` — see the trap in the checklist below.

## Bumping the Ant pin — step-by-step checklist

This is the sequence [#387](https://github.com/solardev-xyz/freedom-browser/pull/387)
(v0.5.44 → v0.5.45) actually followed.

1. **Find the latest tag.**

   ```
   gh api repos/freedom-hq/ant/releases/latest --jq .tag_name
   ```

2. **Read the release notes and judge whether `antd` behaviour changes.** Read
   the compare view and the PRs it names, and say explicitly which changes
   reach the code Freedom's bundled node runs — Freedom launches `antd` as a
   separate process and never calls `ant-ffi`, so FFI-only or mobile-host-only
   changes are inert here. "No behavioural change" is a claim that needs
   checking against the specific crates this repo ships, not a default.

3. **Re-derive the trust root.** Download the release's `SHA256SUMS` asset
   yourself and hash it — never copy a digest out of a task description:

   ```
   gh release download <tag> -R freedom-hq/ant -p SHA256SUMS -D /tmp/ant-sums
   sha256sum /tmp/ant-sums/SHA256SUMS      # shasum -a 256 on macOS
   ```

4. **Update `scripts/fetch-ant.js`:** `PINNED_RELEASE_TAG` and
   `PINNED_SHA256SUMS_DIGEST` together, in the same commit.

5. **Update `scripts/fetch-ant.test.js`:** `PINNED_TAG` and every
   tag-carrying fixture (redirect `Location` values, asset names). These are
   not tag-agnostic — the suite fails until they move, which is the
   `PINNED_TAG === PINNED_RELEASE_TAG` drift guard doing its job.

6. **Update the license audit:** the Ant rows in `LICENSE_AUDIT.md` and
   `licenses-audit.json`, and re-check upstream's license at the new tag
   (`gh api repos/freedom-hq/ant/contents?ref=<tag>` — `LICENSE-MIT` and
   `LICENSE-APACHE` are what `MIT OR Apache-2.0` rests on).

7. **Add a changelog fragment**, not a `CHANGELOG.md` edit: one new file,
   `changelog.d/security--ant-<new-version>.md`, whose body is the entry as it
   should read under that heading. Pull requests no longer touch
   `CHANGELOG.md` — that is what keeps two of them from conflicting over it —
   and the release assembles the fragments (see `changelog-process.md` and
   `changelog.d/README.md`).

   The whole of `changelog.d/security--ant-0.5.45.md` is the entry itself:

   ```
   - Updated bundled nodes:
     - [Ant](https://github.com/freedom-hq/ant) 0.5.44 to 0.5.45 — <what changes for a user>
   ```

   Nothing above that — no heading, no file name — goes in the file: the body
   is spliced into `## [Unreleased]` verbatim, so a stray heading line lands
   there as a heading. `npm run changelog:assemble` refuses a fragment that is
   not a bullet list, and the `changelog.d/` guard in
   `scripts/assemble-changelog.test.js` runs that check on every pull request.

   Writing the same `- Updated bundled nodes:` lead as the last bump is
   correct, not a duplicate: the assembler folds the sub-bullets under the one
   lead, whether it comes from another fragment or is already under
   `## [Unreleased]`.

   The file name's `<section>--` prefix is what picks the heading. `security`
   vs `changed` follows `changelog-process.md`: a hardening fix to code that
   shipped in a _previous tagged release_ is `security`.

8. **Grep the tree for the old tag and the old digest**, so no stale pin
   survives:

   ```
   grep -rn '0\.5\.44\|<old-digest-prefix>' --exclude-dir=node_modules --exclude-dir=ant-bin --exclude-dir=.git .
   ```

   The check is "no stale **pin** survives", not "zero hits" — several hits are
   expected and must be left alone:

   - `changelog.d/security--ant-<new-version>.md` — the fragment you just
     wrote in step 7 names the "from" version. It is your own new entry, not a
     stale pin.
   - `CHANGELOG.md` — the "from" version in any entry already assembled there,
     plus older released sections.
   - **This playbook** — the worked example named at the top of this section
     and the sample fragment in step 7 both carry a concrete version pair.
     They are a record of one past bump, not a pin; do not rewrite them to make
     the grep look clean. (Re-word them only when you are deliberately
     re-basing this checklist onto a newer bump.)

   Anything outside those three is a real stale pin. The old digest should
   be gone entirely — zero hits.

9. **Run the checks.** All of these, not a subset:

   ```
   node scripts/fetch-ant.js            # every target, not just the host
   ./ant-bin/<os>-<arch>/antd --version
   npx jest scripts/fetch-ant.test.js
   npx jest src/main/identity/__tests__/integration/bee-to-ant-migration.test.js
   npx jest licenses-audit.test.js
   npm run test:unit
   npm run lint
   npx prettier --check <touched files>
   ```

   Mutation-test the drift guard rather than trusting a green run: point
   `PINNED_RELEASE_TAG` at a tag that is not `PINNED_TAG`, confirm the suite
   fails, revert. `bee-to-ant-migration.test.js` spawns the **real** binary and
   guards the invariant the upgrade-path identity migration depends on — `antd`
   never self-creates `keys/swarm.key`.

10. **Run the new `antd` for real.** Start it against a copy of
    `config/ant.yaml` on a `mktemp -d` data dir and a **non-default** API port,
    and record `/health`, `/status` and `/addresses` (look for
    `"version":"antd/<new>"`, `chainReady: true`, a non-trivial
    `connectedPeers`, and `lastSyncedBlock` advancing). Shut it down with
    SIGTERM and delete the temp dir afterwards.

### What the PR description is expected to contain

- **Real command output**, pasted — not a summary of what passed.
- **No throwaway scripts committed.** Ad-hoc drivers live under `/tmp`;
  `git status` should show only the intended files.
- **A screenshot of the Nodes menu's Swarm section** showing the new
  `Version: Ant vX.Y.Z` row, in **both dark and light** themes (per
  `ui-consistency.md`; the `run-freedom` skill in `.claude/skills/` drives it).
  The version row is painted by `src/renderer/lib/ant-ui.js`
  (`fetchAntVersionOnce()` reads `GET <ant api>/health`), so the pin bump _is_
  user-visible in exactly one place.

  **The trap:** assert `mode: "bundled"` on the profile's own port before
  trusting the pixels. If any foreign `antd` is listening on **1633**, the
  manager adopts it (`mode: "reused"`) and the menu would show the right
  version no matter what this PR pinned. Give the app its own managed dev
  profile (e.g. `FREEDOM_DEV_HOME` at a temp dir) so the reuse probe is
  skipped, and read the service registry's `mode`/port back before
  screenshotting. `test-e2e/packaged-live/nodes.spec.js` documents the same
  hazard for the packaged smoke legs. A test-mode run cannot be used for this:
  the harness stubs all `http://`, so the row can only ever read `Unknown`.

## Bumping the other binaries

Same shape, different pin location:

- **freedom-ipfs** — bump `releaseTag` and add the release's per-target
  `sha256` entries to `prebuiltAssets` in
  `scripts/fetch-freedom-ipfs-native.js`, then `npm run ipfs:download` and
  `npm run check-binaries`. Prebuilts are Electron-ABI-specific, so an Electron
  bump can require a new upstream release.
- **Radicle** — bump `RADICLE_ADDON_VERSION` in
  `src/shared/radicle-addon-version.js` **and** the `tag`/`digest` pair in
  `PINNED_SHA256SUMS` in `scripts/fetch-radicle-addon.js`, then
  `npm run radicle:download`. CI's `radicle-addon-load` matrix then loads the
  addon on every runner-available target and checks it against
  `RADICLE_ADDON_REQUIRED_EXPORTS` (`scripts/check-radicle-addon.js`); win-arm64
  has no hosted runner, so its asset is only verified against the pinned sums.
- **Arti** — bump `PINNED_ARTI_VERSION`, and `MIN_RUST_VERSION` in the same
  commit when the release raises its MSRV. Arti is compiled, so its bump has
  extra steps (CLI/`arti.toml` key changes read against
  `src/main/tor-manager.js`, and `cargoFeatures()`'s Windows `static-sqlite`
  feature) — those are written up in
  [`release-process.md` § Bundled binaries](release-process.md), not repeated
  here.

**Trust roots differ, so check which one you are updating.** Ant and libradicle
each pin the sha256 of the release's own `SHA256SUMS` asset in-repo
(`PINNED_SHA256SUMS_DIGEST` / `PINNED_SHA256SUMS`), because that file ships
from the same mutable GitHub release as the binaries and proves nothing on its
own. freedom-ipfs skips the sums file and pins each asset's sha256 directly.
Arti pins a crates.io version only — cargo does the fetching and verification.
All the downloaders share one retry/timeout/redirect policy,
`scripts/lib/fetch-with-retry.js`; `release-process.md` § Bundled binaries has
the full policy and the per-binary authoritative-source table.

## See also

- [`release-process.md`](release-process.md) § "Bundled binaries" — the
  authority on release-time checks (staleness comparison, commit style,
  changelog placement, the Arti bump's extra steps). Where this playbook and
  that one would say the same thing, that one wins.
- [`changelog-process.md`](changelog-process.md) — categorising a bump.
- [`ui-consistency.md`](ui-consistency.md) — the both-themes screenshot rule.
- `docs/features.md` — the user-facing node/port/data-directory table.
