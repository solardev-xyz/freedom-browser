# Release Process Playbook

Use this playbook when cutting a new Freedom release (any `MAJOR.MINOR.PATCH` bump).

It complements `changelog-process.md` — that playbook covers the mechanics of writing `CHANGELOG.md`; this one covers the surrounding branch, version-bump, build, tag, and publish steps.

## 0. Create a release branch first

All release work happens on a dedicated branch off `main`, never on `main` directly.

Naming convention (matches prior releases like `release/0.6.2`):

```
release/<version>
```

For example, for 0.7.0:

```
git checkout main
git pull --ff-only
git checkout -b release/0.7.0
```

Rationale:

- Keeps `main` unblocked while the release is being stabilized.
- Gives a clear target for last-minute build/changelog fixups without polluting feature history.
- The artifacts you build, upload, and tag all come from this branch, so a broken build can be fixed here before anything lands on `main`.

## 1. Promote the dev version

Between releases, `main` carries a `<next>-dev` version (see Step 11). On the release branch, strip that suffix so the build advertises the real release number.

Update the version string in exactly these two files:

- `package.json` — top-level `"version"`.
- `package-lock.json` — the two top-level `"version"` entries (root object and the `""` package entry). Ignore any `0.X.Y` strings inside transitive dependency version ranges (e.g. `iconv-lite`).

No other source file hard-codes the version — the renderer, `electron-builder`, and `electron-updater` all read it from `package.json` at runtime/build time.

If the release version differs from the in-flight `<next>-dev` (for example, the cycle was opened as `0.7.1-dev` but is being shipped as `0.8.0`), set the new version directly here — the dev suffix exists to make local builds self-identify, not to commit you to a specific number.

Commit style (matches prior releases):

```
chore(release): bump version to <version>
```

## 2. Refresh dependencies

On the release branch, before finalizing the changelog, bring npm packages and bundled binaries to their current stable versions. Per `AGENTS.md` rule 9, **this requires explicit releaser approval per bump** — agents working through this step should triage and propose, not unilaterally upgrade.

### npm dependencies

Run `npm outdated --json` and triage:

- **In-range bumps** (`wanted == latest`): patch and minor updates that semver guarantees back-compat for. Default to taking them all unless one has a known regression.
- **Out-of-range bumps** (`wanted < latest`): a new major (or a constrained range still pointing at an older line). Default to deferring to a dedicated release cycle. Before deciding whether to defer or bundle, run these three checks:
  1. **Own-API check**: read the release's breaking-changes notes and `grep` the codebase for each removed/deprecated API. Zero hits is necessary but **not sufficient** on its own — see #2.
  2. **Native-module compatibility check** (mandatory for Electron majors and anything else that brings a new V8 / Node major): run `npm install --save-dev <pkg>@<target>` followed by `npm ci` and watch `electron-builder install-app-deps` rebuild every native module against the new headers. If **any** rebuild fails, the bump is **blocked by upstream**, regardless of how clean #1 came out. Check the failing module's GitHub issues for a `<bump>` compatibility tracker — there is usually a public one. **The 0.7.2 cycle hit this**: `better-sqlite3@12.10.0` could not compile against Electron 42's V8 14.8 because V8 removed `PropertyCallbackInfo::Holder()`; upstream had explicitly rolled back Electron 42 prebuilds ([WiseLibs/better-sqlite3#1470](https://github.com/WiseLibs/better-sqlite3/pull/1470)). The Electron 41 `grep` audit showed zero affected APIs in our own code — the breakage surface was entirely in the native-module ecosystem.
  3. **Build-pipeline check**: for changes that alter install behavior (e.g. Electron 42 removed its own `postinstall` in favor of lazy download), verify the docker linux build pipeline still produces working artifacts. `npm ci` inside a container can behave differently from a local install.

  Only bundle the bump if all three checks pass **and** the verification budget for manual cross-platform smoke testing (mandatory for Chromium-level changes, since `npm test` will not catch web-platform behavior shifts) is available. Otherwise defer to a dedicated release cycle — Electron majors in particular are usually large enough to lead their own release ("`Upgraded Electron 41 to 42 (Chromium 148, Node 24.15)`" as a top-line `Changed` entry, matching `0.7.0`'s "Upgraded Electron to 41").

Apply approved bumps with `npm update` (matches `0.7.1`'s `chore(deps): refresh in-range bumps` commit). This updates `package-lock.json` to the resolved versions without touching the declared `^` ranges in `package.json`, because the ranges already permit those versions. Use `npm install <pkg>@<version>` only when you need to widen a `^` range or pin an exact version. Re-run `npm ci && npm run lint && npm test` before committing to catch regressions.

### Audit warnings

After updating, run `npm audit` and decide per advisory:

- **Auto-fixable, non-breaking**: take `npm audit fix`.
- **Auto-fixable but `--force` required** (downgrades a top-level dep across a major): do **not** take the auto-fix. Add an `overrides` block in `package.json` pinning just the transitive to a non-vulnerable version. `0.7.1` did exactly this for `uuid` under `@metamask/utils`; the same pattern applies to anything where the auto-fix would regress a direct dependency.
- **Not exploitable in our usage**: document why in the commit body (`0.7.1`'s commit explains the `uuid.v3/v5/v6` advisory is unreachable from our import graph).

### Bundled binaries (Ant, freedom-ipfs, Radicle)

Ant is the exception to the "resolve latest" rule: `scripts/fetch-ant.js` pins a known-good tag (`PINNED_RELEASE_TAG` in the script) so CI and releases install the exact version that was tested. To bump Ant, change the pin in the script **together with** `PINNED_SHA256SUMS_DIGEST` (the sha256 of the new release's `SHA256SUMS` asset — the in-repo trust root that makes a later swap of the release assets detectable; compute it with `shasum -a 256` on the freshly downloaded file) and let CI validate it; `ANT_RELEASE_TAG` (a tag, or `latest`) overrides for local testing only and skips the digest check. Every bump must also keep the real-binary integration test green (`src/main/identity/__tests__/integration/bee-to-ant-migration.test.js`, run in the `e2e-onboarding-identity` CI job) — it guards the invariant that antd never self-creates `keys/swarm.key`, which the upgrade-path identity migration depends on.

`freedom-ipfs` is pinned the same way: desktop intentionally consumes a pinned GitHub release asset with a checked checksum, so updating it means changing the pinned release metadata in `scripts/fetch-freedom-ipfs-native.js`.

The other fetch scripts resolve the latest from a **vendor-specific** upstream — do **not** use GitHub tags as a stand-in, they can lag the actual release pointer (Radicle in particular publishes new releases to `files.radicle.xyz` first; GitHub `/tags` showed `1.7.1` as the latest stable while `1.9.1` was already shipping).

| Binary                                                | Authoritative source the fetch script reads                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ant (`scripts/fetch-ant.js`)                          | `https://api.github.com/repos/solardev-xyz/ant/releases/tags/<PINNED_RELEASE_TAG>` (pinned in the script; `ANT_RELEASE_TAG` overrides) |
| freedom-ipfs (`scripts/fetch-freedom-ipfs-native.js`) | pinned GitHub release in the fetch script                                                                                  |
| Radicle main (`scripts/fetch-radicle.js`)             | `https://files.radicle.xyz/releases/latest`                                                                                |
| Radicle httpd (same script)                           | `https://files.radicle.xyz/releases/radicle-httpd/latest`                                                                  |

To check whether the bundled binary is stale, compare its self-reported version against the source above:

```
./ant-bin/<arch>/antd --version
./radicle-bin/<arch>/rad --version
./radicle-bin/<arch>/radicle-httpd --version
```

For `freedom-ipfs`, compare the pinned release in `scripts/fetch-freedom-ipfs-native.js` against the release you intend to ship, then update the asset name/checksum together.

For each binary that's behind, re-run its fetch script (`npm run ant:download` / `ipfs:download` / `radicle:download` — each fetches every supported arch) and verify the result still passes `npm run check-binaries`. Note: downloaded binary directories are gitignored, so the binary refresh usually produces no file-tree change. The build pipeline (§5) re-fetches at artifact-build time — Ant and freedom-ipfs install their pinned versions, while Radicle ships whatever upstream `latest` resolves to then — document the versions in the changelog and in the `chore(build): update bundled <name> to <version>` commit body.

### Commit style

Match `0.7.1`'s grouping: one commit for npm refresh (lockfile + any `overrides`), a separate commit per bundled-binary group only if the upstream version changed. Body lists the bumps as `name old -> new` lines (no decorative arrows) and documents any audit decisions taken (see Audit warnings above).

```
chore(deps): refresh in-range bumps[ and clear <advisory> audit advisory]
chore(build): update bundled <binary> to <version>
```

### Changelog placement

Per `changelog-process.md` § Categorising dependency updates, dependency updates inside an active major series default to `Security` (they almost always carry upstream security fixes). The next step (§3 Finalize the changelog) is where this lands.

## 3. Finalize the changelog

Follow `changelog-process.md` in full. Key points for release branches:

- The baseline for `git log` is the last `package.json` version bump commit.
- Replace the `## [Unreleased]` heading with `## [<version>] - <YYYY-MM-DD>` using the date from `git show -s --format="%ad" --date=short HEAD`.
- Do **not** leave an empty `## [Unreleased]` section behind. The first user-facing change after the release re-introduces the heading above the latest version.

Commit style:

```
docs(changelog): add user-facing <version> release notes
```

**Review gate (when drafted by an agent).** If the changelog entries were drafted by an agent — or by anyone other than the releaser — **do not create the `docs(changelog): …` commit yet**. Leave the `CHANGELOG.md` edits unstaged (or staged, but uncommitted) on the release branch, present the diff to the releaser, and wait for explicit approval before committing. Iterating in the working tree is cheaper than amending a commit, and avoids the `git commit --amend` ambiguity for agents whose tooling discourages amending without an explicit user request. `CHANGELOG.md` is not read by §4 (verify), §5 (build distributables), or §6 (manual cross-platform smoke testing), so those steps can run in parallel with the review. §7 (upload + website) and §8 (tag) freeze the changelog state visible to end users and must wait until the commit lands.

If the changelog is already committed when a correction is requested (e.g. the releaser drafted it themselves, or this gate was missed), amend the existing `docs(changelog): …` commit rather than stacking a second changelog commit.

## 4. Verify before building

On the release branch, with a clean working tree:

```
npm ci
npm run lint
npm test
npm run check-binaries
```

**License check.** `NOTICES`, `LICENSE_AUDIT.md`, and `licenses-audit.json` attribute the bundled Ant binary as MIT OR Apache-2.0, matching the `LICENSE-MIT` / `LICENSE-APACHE` that `https://github.com/solardev-xyz/ant` now publishes. Before building release artifacts, confirm the upstream license is unchanged and update those three files if it differs.

Spot-check the app once (`npm start`) and confirm the About/version surface reflects the new number.

## 5. Build distributables

Run from the release branch. All builds read the version from `package.json`.

### macOS (signed + notarized, inline)

```
npm run dist -- --mac
```

`build.mac.notarize: true` in `package.json` makes `electron-builder` submit and staple the notarization in the same invocation. The command blocks until Apple finishes notarizing — expect several minutes. This is the default mac release flow.

**Fallback — async notarization.** If notarization is slow or flaky and you need to do it out-of-band (for example to retry or to free the terminal), use the split scripts instead:

```
npm run dist:mac:prepare-notary     # builds with --no-notarize
npm run dist:mac:submit-notary      # uploads to Apple
npm run dist:mac:notary-status      # polls status
npm run dist:mac:notary-log         # fetch log if it fails
npm run dist:mac:staple-notary      # staple once accepted
```

These require `.env` credentials via `dotenv-cli` and are implemented in `scripts/macos-notary.js`.

### Linux

```
npm run dist:linux:x64:docker
npm run dist:linux:arm64:docker
```

Both run `electron-builder` inside a Linux container and download the matching Radicle binaries for the target arch.

### Windows

```
npm run dist -- --win --x64
```

`electron-builder` cross-builds the Windows NSIS installer and zip from the mac host — no Windows machine required. Windows builds intentionally ship without Radicle (see `README.md`).

Cross-building rebuilds `better-sqlite3` in `node_modules` for the *target* platform, which would leave a Windows DLL on the mac host and silently break history/favicons/payment-history in local dev (symptom: `[History] Opening database:` repeating in the log with no `Current schema version:` line after it). `scripts/build.js` handles this automatically — it snapshots the host binary before any cross-target build and restores it afterward (falling back to `npx electron-builder install-app-deps`, our postinstall command), so expect a `→ Restored host better-sqlite3 binary` line after Windows builds. This protection only exists in `scripts/build.js`: never invoke `electron-builder --win` directly; if you do, run `npx electron-builder install-app-deps` afterward.

## 6. Manual cross-platform smoke testing

Cross-built artifacts have **never been run** by the time §5 finishes. The Linux container can package the AppImage and `.deb`, and the mac host can cross-build the Windows NSIS installer, but neither can execute the result on its actual target platform. Smoke testing each artifact on a real instance of its target OS catches packaging-class bugs that `npm test` and the on-host `npm start` smoke (§4) cannot:

- Wrong native-module ABI for the target arch (e.g. `better-sqlite3.node` linked for the wrong NODE_MODULE_VERSION, or a x64 binary in an arm64 package)
- Missing or wrong-arch bundled binary in `extraResources` (`antd.exe`, `ipfs`, `rad`, `radicle-httpd`)
- `electron-builder` configuration mistakes (asar unpack rules, `extraResources` paths, NSIS installer flags, Gatekeeper / SmartScreen interaction)
- Platform-specific code paths (file system paths, native menus, IPC permissions, system trust store, default-browser hooks)

### Test environments

- **Linux**: a VM or bare-metal Linux machine matching the target arch — **not the build host**. `Freedom-<version>.AppImage` runs without install (`chmod +x` then double-click or launch from a terminal); `freedom-browser_<version>_amd64.deb` installs via `sudo apt install ./freedom-browser_<version>_amd64.deb`. Repeat for the arm64 artifacts on an arm64 Linux instance (e.g. a Raspberry Pi or a UTM arm64 VM on Apple Silicon).
- **Windows**: a Windows VM (UTM, Parallels, VMware Fusion) or a separate Windows host. The NSIS installer (`Freedom Setup <version>.exe`) runs unprivileged; the portable `Freedom-<version>-win.zip` extracts and runs without install. Confirm Windows SmartScreen prompts behave as expected for the signed installer (a "Don't run" with an unblock-on-second-prompt is normal for newly-signed builds; outright "blocked by your administrator" is not).
- **macOS**: the dev host is fine — install the `.dmg` locally (or open the staged `.app` from `dist/mac-arm64/`) and run the same checklist. Confirm Gatekeeper accepts the artifact (`spctl --assess --type execute --verbose dist/mac-arm64/Freedom.app` should print `accepted, source=Notarized Developer ID`).

### Transferring artifacts to test machines

**Default step: as soon as the §5 artifacts are complete, launch Python's built-in HTTP server over `dist/` on the build host** — zero setup on the test side, no SSH server required, doesn't bounce the unreleased build off any third party. It serves an auto-generated directory index, so on each test machine you just browse to the URL and click the artifact you need:

```
python3 -m http.server 8000 --directory dist/
```

Get the build host's LAN IP with `ipconfig getifaddr en0` (macOS, primary interface) or `ip -4 addr show scope global | awk '/inet / { print $2 }'` (Linux). Then download from the test machine:

| Test OS | Command |
|---|---|
| Linux | `wget http://<build-host-ip>:8000/<filename>` |
| Windows (PowerShell) | `iwr http://<build-host-ip>:8000/<filename> -OutFile <filename>` |
| Any (GUI) | Browse to `http://<build-host-ip>:8000/` and click the file |

Filenames with spaces (e.g. `Freedom Setup <version>.exe`) need URL-encoding when used in `wget` / `iwr` (`%20` for each space). The GUI browser path handles encoding automatically.

Verify the transfer matches the manifest in `dist/latest-<platform>*.yml` (each file's `sha512:` field is base64):

- Linux / macOS test host: `openssl dgst -sha512 -binary <file> | base64 -w0` — should print the base64 hash from the manifest verbatim
- Windows test host: `(Get-FileHash -Algorithm SHA512 <file>).Hash` returns hex; either compare against `shasum -a 512 <file>` run on the build host (also hex), or decode the manifest's base64 once with `echo "<base64>" | base64 -d | xxd -p -c 256` on the build host

Kill the HTTP server (`Ctrl+C`, or `pkill -f "http.server"` if backgrounded) once transfers are done — it serves everything in `dist/` to anything on the LAN with no auth.

Alternatives if the HTTP server doesn't fit:

- **USB stick** — air-gapped, no network involved. Best when the test machine is offline or on a hostile network
- **scp** — `scp dist/<file> user@test-host:` (needs `openssh-server` on the test host)
- **KDE Connect / LocalSend / Snapdrop** — GUI options if both ends have the app
- Cloud storage and the `freedom.baby/downloads` URL itself both work, but bounce the file off a third party — slower, exposes the unreleased build outside your LAN, and (for `freedom.baby`) inverts the playbook order by uploading before §6 testing has signed off

### Per-platform smoke checklist

For each platform, run through:

1. **Launch**: the app opens cleanly — no crash dialog, main window appears
2. **Version**: About / `freedom://settings` shows `<version>` from `package.json`
3. **Navigation**: type `https://example.com`, confirm a basic HTTPS page renders and the address-bar shield is in its default state
4. **Headline feature**: spot-check whatever the release leads with. For releases that touch ENS / Swarm / IPFS / Radicle, that means opening an `ens://`, `bzz://`, `ipfs://`, or `rad://` URI and confirming the documented behaviour (e.g. for `0.7.2`: Colibri verification surfaces in the address-bar shield popover)
5. **Bundled nodes**: confirm Ant, native IPFS, and (Linux only) Radicle start cleanly. The nodes manager or the relevant `freedom://` settings page surfaces this — a "node failed to start" red badge or a missing native addon/API port is the failure mode
6. **Persistence**: change one trivial setting (e.g. theme), close the app fully, reopen, confirm the change stuck

If any platform fails:

- Fix on the release branch. The other platforms' artifacts in `dist/` are not invalidated by a fix that only changes that platform's build.
- Re-run only the affected `npm run dist:<platform>:...`.
- Re-test the regenerated artifact.
- Proceed to §7 only when every platform you intend to ship passes.

This step is intentionally separate from §4 — §4 verifies the source tree (`npm test`, `npm start` from source); §6 verifies the **packaged artifact** that end users will install. They catch different classes of bugs.

## 7. Upload binaries and update the website

1. Push the release branch to GitHub so the pinned changelog link (step 3) resolves — the `release/<version>` blob URL 404s until the branch exists on the remote:

   ```
   git push -u origin release/<version>
   ```

   This is a plain branch push, not the `main` merge (that stays in §9). The branch is meant to live on after the release anyway (§10), so publishing it now costs nothing and unblocks the website update.
2. Upload the generated artifacts from `dist/` to `https://freedom.baby/downloads`, including the `latest*.yml` manifests so existing installs pick up the update via `electron-updater` (which is configured with `publish.provider = generic` pointing at that URL).
3. Update the Freedom website to point at the new version:
   - Download links and per-platform file-size metadata.
   - Version string in the downloads intro (e.g. `Alpha release (<version>)`).
   - `Changelog` link — pin to the release branch so the page shows the CHANGELOG state that matches the binaries being served: `https://github.com/solardev-xyz/freedom-browser/blob/release/<version>/CHANGELOG.md`. Do not link to `main`, which will absorb future releases' in-progress notes.

Do this **before** tagging — if an upload reveals a broken artifact, you want to be able to fix it on the release branch without already having a tag pointing at a broken commit.

## 8. Tag the release

On the release branch, from the commit you actually built and shipped:

```
git tag -a v<version> -m "Release <version>"
```

Tag format is `v<version>` (lowercase `v`), matching `v0.6.2`. Do not push the tag yet — push it together with the merge in the next step so `main` and the tag move as one.

## 9. Merge the release branch into main

Optionally open a PR from `release/<version>` into `main` for review. Otherwise merge directly:

```
git checkout main
git pull --ff-only
git merge --no-ff release/<version>
git push origin main
git push origin v<version>
```

The `--no-ff` is deliberate — it preserves the release branch as a visible bubble in `main`'s history, which matches how earlier releases landed.

## 10. Post-release housekeeping

- Confirm the GitHub release page lists the correct artifacts and release notes.
- Keep the `release/<version>` branch around (do not delete) — it matches the historical pattern and is the natural base for a `hotfix/<version>.<patch>` branch later if needed.
- Any build-only fixes that land after the version bump should be committed on the release branch with `fix(build): ...` messages, same as the `0.6.2` cycle did.

## 11. Open the next dev cycle on `main`

Immediately after the merge, bump `main` to the next dev version so local/CI builds and the About dialog stop advertising the just-shipped release.

Default to a patch bump — e.g. after shipping `0.7.0`, set `main` to `0.7.1-dev`. If the next cycle later turns out to be a minor or major (or you decide upfront), re-bump to `0.8.0-dev` / `1.0.0-dev`; nothing downstream depends on the suffix's exact `MINOR.PATCH`.

Update the same two files as Step 1:

- `package.json` — top-level `"version"`.
- `package-lock.json` — both top-level `"version"` entries.

Commit on `main` (not on the release branch):

```
chore(release): open <next>-dev cycle
```

Why a `-dev` suffix rather than a bare `<next>`:

- The About dialog (`app.getVersion()`) and the updater User-Agent in `src/main/updater.js` are the only surfaces that show the version. With the suffix, a screenshot or bug report from a local build self-identifies as unreleased, instead of falsely claiming the previous release.
- Per semver, `<next>-dev` sorts strictly below `<next>`, so the eventual release will always look like an upgrade to a dev install (never a downgrade).
- Note: a `-dev` suffix does **not** rescue dev installs from missing a hotfix on the previous line. By semver, `0.8.0-dev > 0.7.1` (major/minor/patch dominate; pre-release tags only break ties within the same triple). This is acceptable here because dev builds are run by developers from source, not via `electron-updater`. If you ever hand pre-release builds to non-developer testers, revisit this.
