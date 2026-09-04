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

     **This check no longer covers `better-sqlite3`.** Since the v13 bump it is deliberately excluded from the `install-app-deps` pass: it ships Node-API prebuilds for every target we package and `scripts/better-sqlite3-prebuilds.js` deletes its unused `binding.gyp` from `postinstall`, so `@electron/rebuild` never classifies it as native and never touches it. A clean `install-app-deps` therefore says **nothing** about better-sqlite3 — do not read it as a pass. That is safe by construction (Node-API is ABI-stable across Node/V8 majors, which is exactly why upstream ships one addon per platform instead of one per Electron version, and why the 0.7.2-era `PropertyCallbackInfo::Holder()` breakage cannot recur), but the bump still has to be validated at _runtime_ rather than at rebuild time: on the new Electron, run the harness e2e specs that exercise the SQLite-backed stores — `npx playwright test --project=harness private-windows.spec.js --reporter=list` (prefix with `xvfb-run -a` on Linux; the mac release host of §5 has no `xvfb-run`), which writes and reads back real history and downloads-history rows — plus `npm test` (the `src/main/history.test.js`, `payment-history.test.js` and `downloads/*` suites open real databases). Same rule for any other dependency that ships Node-API prebuilds and gets pruned out of the rebuild pass.

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

The remaining fetch scripts use their pinned upstream release metadata.

| Binary                                                | Authoritative source the fetch script reads                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Ant (`scripts/fetch-ant.js`)                          | `https://api.github.com/repos/freedom-hq/ant/releases/tags/<PINNED_RELEASE_TAG>` (pinned in the script; `ANT_RELEASE_TAG` overrides) |
| freedom-ipfs (`scripts/fetch-freedom-ipfs-native.js`) | pinned GitHub release in the fetch script                                                                                            |
| libradicle (`scripts/fetch-radicle-addon.js`)         | pinned GitHub release in the fetch script                                                                                            |

To check whether the bundled binary is stale, compare its self-reported version against the source above:

```
./ant-bin/<arch>/antd --version
```

For native addons, compare the pinned release in its fetch script against the release you intend to ship, then update the asset name/checksum together.

For each binary/addon that's behind, re-run its fetch script (`npm run ant:download` / `ipfs:download` / `radicle:download`) and verify the result still passes `npm run check-binaries`. Downloaded binary directories are gitignored, so the refresh usually produces no file-tree change. Document versions in the changelog and the matching build commit.

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

**License check.** `NOTICES`, `LICENSE_AUDIT.md`, and `licenses-audit.json` attribute the bundled Ant binary as MIT OR Apache-2.0, matching the `LICENSE-MIT` / `LICENSE-APACHE` that `https://github.com/freedom-hq/ant` now publishes. Before building release artifacts, confirm the upstream license is unchanged and update those three files if it differs.

Spot-check the app once (`npm start`) and confirm the About/version surface reflects the new number.

## 5. Build distributables

Run from the release branch. All builds read the version from `package.json`.

### macOS (signed + notarized, inline)

```
npm run dist -- --mac
```

`build.mac.notarize: true` in `package.json` makes `electron-builder` submit and staple the notarization in the same invocation. The command blocks until Apple finishes notarizing — expect several minutes. This is the default mac release flow.

That inline pass notarizes and staples **`Freedom.app` only**. `dmg-builder` then wraps the already-stapled app in a disk image but never notarizes the image itself, so the `.dmg` this command produces has no ticket of its own (`xcrun stapler validate` on it fails, and Gatekeeper has to check it online when a user opens it). If you hand out that disk image, notarize and staple it too:

```
xcrun notarytool submit dist/Freedom-<version>-arm64.dmg \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple dist/Freedom-<version>-arm64.dmg
```

Stapling rewrites the image, so the `.dmg` entry in `dist/latest-mac.yml` no longer matches the file you upload — refresh its `sha512`/`size` (the release workflow below does this automatically). The macOS updater only reads the `.zip` entry, so this affects the checksum manifest, not updates. The async fallback below already submits and staples the `.dmg` for you.

**Fallback — async notarization.** If notarization is slow or flaky and you need to do it out-of-band (for example to retry or to free the terminal), use the split scripts instead:

```
npm run dist:mac:prepare-notary     # builds with --no-notarize
npm run dist:mac:submit-notary      # uploads to Apple
npm run dist:mac:notary-status      # polls status
npm run dist:mac:notary-log         # fetch log if it fails
npm run dist:mac:staple-notary      # staple once accepted
```

These require `.env` credentials via `dotenv-cli` and are implemented in `scripts/macos-notary.js`.

### All platforms via GitHub Actions

`.github/workflows/release.yml` builds every distributable on GitHub-hosted runners, so a release does not depend on one maintainer's Mac or on the Docker recipes above:

| Job           | Runner             | Output                                                                                  |
| ------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `mac-arm64`   | `macos-14`         | signed + notarized `.dmg` / `-mac.zip`, `latest-mac.yml`                                |
| `linux-x64`   | `ubuntu-latest`    | `Freedom-<v>.AppImage`, `freedom-browser_<v>_amd64.deb`, `latest-linux.yml`             |
| `linux-arm64` | `ubuntu-24.04-arm` | `Freedom-<v>-arm64.AppImage`, `freedom-browser_<v>_arm64.deb`, `latest-linux-arm64.yml` |
| `windows-x64` | `windows-latest`   | `Freedom Setup <v>.exe`, `Freedom-<v>-win.zip`, `latest-win-x64.yml` (unsigned)         |
| `release`     | `ubuntu-latest`    | tag pushes only: attaches all of the above to one GitHub Release                        |

Windows arm64 is intentionally not built (it was never shipped on `freedom.baby` and Myotis publishes no addon for it). No Windows code-signing certificate exists, so the installer is unsigned and SmartScreen prompts on first run — same as every manual release so far. Linux jobs install `fpm` from RubyGems (`USE_SYSTEM_FPM=true`) exactly like the Docker recipes, and build Arti with the runner's cargo.

- **Tag push (`v*`)** — all four build jobs run in parallel; the macOS leg is signed, then the `.dmg` is notarized and stapled in its own step (electron-builder's inline pass covers the `.app` only, see above) and `latest-mac.yml`'s `.dmg` entry is refreshed to the stapled bytes. The result is verified with `codesign` / `spctl` / `stapler` — the staple check now covers both `Freedom.app` and every `.dmg` — and, once **every** platform job has succeeded, the `release` job attaches all artifacts (installers, portable archives, `.blockmap`s and every `latest-*.yml`) to a GitHub Release for that tag. A failed leg means no release; fix and "Re-run failed jobs", which re-runs `release` too. A final tag (`v0.8.1`) produces a **draft**; publish it only after the §6 smoke test passes. A pre-release tag (`v0.8.1-rc.1`, anything with a hyphen) is published as soon as its assets are uploaded and flagged **Pre-release** — see "Release candidates" below. Re-running the job on a tag whose release is already published fails rather than overwriting the live files; tags are never moved, so a bad published build means a new version. With the Actions build, the tag is the build trigger — push it before §6 (see §8 for the reordered flow). The job fails fast if `package.json` does not match the tag (step 1) or if any signing secret is missing. `freedom.baby/downloads` (§7) remains the updater channel, so still upload final artifacts there.
- **Manual run** (Actions → "Release" → Run workflow) — builds every platform from any branch and uploads one workflow artifact per platform, no release. Untick `signed` for an unsigned macOS pipeline test that needs no secrets; untick `bundle_tor` to skip the cargo build of Arti on macOS and Linux.

Signed runs need these repository secrets (Settings → Secrets and variables → Actions): `CSC_LINK` (the Developer ID Application certificate exported from Keychain as a password-protected `.p12`, then base64-encoded), `CSC_KEY_PASSWORD`, and the same `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` as `.env.example`. `electron-builder` imports the certificate into a temporary keychain for the run.

### Linux

```
npm run dist:linux:x64:docker
npm run dist:linux:arm64:docker
```

Both run `electron-builder` inside a Linux container and download the matching Radicle addon for the target arch.

### Windows

```
npm run radicle:download -- --win --x64
npm run dist -- --win --x64

npm run radicle:download -- --win --arm64
npm run dist -- --win --arm64
```

`electron-builder` cross-builds the Windows NSIS installer and zip from the mac host — no Windows machine required. Windows x64 and ARM64 builds include the architecture-matched embedded Radicle node.

> **Known breakage (pre-existing):** from the mac **arm64** release host this command currently dies before packaging, at `keccak` — `⨯ node-gyp does not support cross-compiling native modules from source`. `@electron/rebuild` never looks at keccak's existing `win32-x64` prebuild, and its `.forge-meta` cache key is arch-only, so an arm64 host targeting x64 always misses it. Tracked in [#204](https://github.com/solardev-xyz/freedom-browser/issues/204); until it is fixed, produce the Windows artifacts from an x64 host. This is unrelated to `better-sqlite3` (see below), which is out of the rebuild pass entirely.

Cross-building no longer disturbs the host's `better-sqlite3`. Since v13 the package ships prebuilt addons for every supported target in `node_modules/better-sqlite3/prebuilds/` (`darwin`/`linux`/`linuxmusl`/`win32` x `x64`/`arm64`) and its loader (`lib/binding.js`) prefers those over `build/Release/`, selecting the one matching the _running_ process — so a `--win` build never leaves a Windows DLL where the mac host expects a Mach-O one. `scripts/build.js` used to snapshot and restore a host-built `build/Release/better_sqlite3.node` and print a `→ Restored host better-sqlite3 binary` line; that file is no longer produced at all, so the protection — and that log line — are gone. Do not expect them, and invoking `electron-builder --win` directly is now harmless to local dev.

That only holds because better-sqlite3 is kept out of the `@electron/rebuild` pass. v13 dropped `prebuild-install` and its `prebuilds/` layout is flat files rather than the `prebuilds/<platform>-<arch>/` directories `prebuildify` emits, so `@electron/rebuild` recognises neither tool and would fall through to node-gyp purely because a (never-used) `binding.gyp` sits at the package root — and node-gyp refuses to cross-compile, failing the command above with `node-gyp does not support cross-compiling native modules from source`. `scripts/better-sqlite3-prebuilds.js` deletes that stale `binding.gyp`. The prune normally happens at **`npm ci` time**, from `postinstall`, which prints:

```
→ better-sqlite3: removed the unused binding.gyp (8 prebuilt addons available); @electron/rebuild will leave it alone
```

`scripts/build.js` re-checks before every build purely as a safety net (for an install that skipped `postinstall` — `npm ci --ignore-scripts` — or a hand-restored file; note `npm rebuild better-sqlite3` does **not** restore `binding.gyp`, it only re-runs lifecycle scripts), and only logs — `→ Pruned better-sqlite3's unused binding.gyp (prebuilt addons in use)` — if it actually had to remove something. In the normal flow above it is a **silent no-op, so expect no better-sqlite3 line at `npm run dist` time**; its absence is not a problem. (Running the script by hand on an already-pruned tree prints `→ better-sqlite3: nothing to do (binding.gyp already removed)`.) If you ever see the node-gyp cross-compiling error for `moduleName=better-sqlite3`, `npm install` restored the file and the prune did not run — `node scripts/better-sqlite3-prebuilds.js` fixes it.

`scripts/build.js` also verifies the _target's_ prebuild exists before invoking `electron-builder`, and aborts with `Error: better-sqlite3 ships no prebuilt addon for this target` if it does not — with `binding.gyp` gone there is no source-build fallback, so an unprebuilt target would otherwise package silently and throw at startup.

If you ever need to package a target upstream ships no prebuild for, use the source-build escape hatch. `npm rebuild better-sqlite3` does **not** restore the pruned `binding.gyp` (it re-runs lifecycle scripts and never re-extracts the package), so the supported path is `FREEDOM_BS3_SOURCE_BUILD=1`, set for **both** the install (which re-extracts the package with the prune skipped) and the build (which skips the per-target guard):

```
FREEDOM_BS3_SOURCE_BUILD=1 npm ci
FREEDOM_BS3_SOURCE_BUILD=1 npm run build -- --linux --x64   # or the target you need
```

Both legs log that the override is active. It requires the node-gyp toolchain (Python + a C++ compiler; MSVC on Windows) and only works for a **same-platform** build — node-gyp still refuses to cross-compile.

Each packaged app carries only the prebuild for its own target: the `mac`/`linux`/`win` blocks in `package.json` each exclude `**/node_modules/better-sqlite3/prebuilds/!(<platform>-${arch}).node`, which keeps ~15 MB of foreign-platform addons out of every installer. If you add a target platform or arch, add the matching exclusion, and sanity-check the packaged `app.asar.unpacked/node_modules/better-sqlite3/prebuilds/` holds exactly one `.node` file.

## 6. Manual cross-platform smoke testing

Cross-built artifacts have **never been run** by the time §5 finishes. The Linux container can package the AppImage and `.deb`, and the mac host can cross-build the Windows NSIS installer, but neither can execute the result on its actual target platform. Smoke testing each artifact on a real instance of its target OS catches packaging-class bugs that `npm test` and the on-host `npm start` smoke (§4) cannot:

- Wrong native-module ABI for the target arch (e.g. `better-sqlite3.node` linked for the wrong NODE_MODULE_VERSION, or a x64 binary in an arm64 package)
- Missing or wrong-arch bundled binary/addon in `extraResources` (`antd.exe`, freedom-ipfs, `libradicle.node`)
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

| Test OS              | Command                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Linux                | `wget http://<build-host-ip>:8000/<filename>`                    |
| Windows (PowerShell) | `iwr http://<build-host-ip>:8000/<filename> -OutFile <filename>` |
| Any (GUI)            | Browse to `http://<build-host-ip>:8000/` and click the file      |

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
5. **Bundled nodes**: confirm Ant, native IPFS, and Radicle start cleanly (Radicle ships on macOS, Linux, and Windows). The nodes manager or the relevant `freedom://` settings page surfaces this — a "node failed to start" red badge or a missing native addon/API port is the failure mode
6. **Persistence**: change one trivial setting (e.g. theme), close the app fully, reopen, confirm the change stuck

If any platform fails:

- Fix on the release branch. The other platforms' artifacts in `dist/` are not invalidated by a fix that only changes that platform's build.
- Re-run only the affected `npm run dist:<platform>:...`.
- Re-test the regenerated artifact.
- Proceed to §7 only when every platform you intend to ship passes.

This step is intentionally separate from §4 — §4 verifies the source tree (`npm test`, `npm start` from source); §6 verifies the **packaged artifact** that end users will install. They catch different classes of bugs.

## Release candidates (optional loop between §5 and §7)

When a release needs testing on machines or by people who do not build from source, cut pre-release builds from the release branch instead of sharing ad-hoc artifacts. The version string is the marker: use semver pre-release identifiers, never a separate branch or tag scheme.

1. On `release/<version>`, set the version in `package.json` and `package-lock.json` (same two files as §1) to `<version>-alpha.1` for early builds or `<version>-rc.1` once you believe it is shippable.
2. Commit (`chore(release): cut <version>-rc.1`), tag `v<version>-rc.1`, and push both. The GitHub Actions job (§5) builds, signs, and publishes it as a **Pre-release** on GitHub — visible to testers, excluded from "Latest release".
3. Fix issues with normal PRs against the release branch (or land them on `main` and cherry-pick). When a fix set is in, bump to `rc.2` and tag again. Never move or reuse a tag; the number always goes up. The final release is the bare `<version>` with no suffix, which sorts higher than every candidate.
4. Do **not** upload candidate artifacts or manifests to `freedom.baby/downloads`. The in-app updater auto-downloads whatever that manifest advertises, so only finals go there. A tester on `rc.N` is upgraded to the final automatically once it is published, because `<version>` is newer than `<version>-rc.N`.

Testing a candidate: it shares the app id and profile directory with the installed release, so launch the binary directly (`open -a` does not forward shell environment variables) against a separate profile to keep migrations and node data from touching your real one:

```
FREEDOM_TEST_USER_DATA="$HOME/freedom-rc-test" /Applications/Freedom.app/Contents/MacOS/Freedom
```

Run the §6 checklist twice per candidate — as a fresh install and as an upgrade from the last final (copy a real profile into the test directory first). For quick private iteration between tagged candidates, trigger the workflow manually on the PR branch; the artifact needs a GitHub login to download and expires, so it is for your own testing, not for handing out.

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

Tag format is `v<version>` (lowercase `v`), matching `v0.6.2`.

When to push the tag depends on which build is the release build:

- **GitHub Actions build (default).** The tag is the build trigger, so push it from the release branch as soon as the release commit (version bump + changelog) is final — before §6. Wait for the "Release (macOS arm64)" run, download the assets from the draft release it creates, and use _those_ files for the §6 smoke test and the §7 upload to `freedom.baby`, so GitHub and `freedom.baby` serve byte-identical binaries and a single `latest-mac.yml`. Publish the draft in §10. A tag is never moved: a final that fails §6 becomes the next patch version, not a retag — which is why a final should only be tagged after an `rc.N` from the same workflow has already passed §6 ("Release candidates" above).
- **Local build (fallback).** If you built on your own Mac (§5, inline or async flow), keep the original order: do not push the tag until the §9 merge, so `main` and the tag move as one. The Actions run that tag triggers produces a _second_ signed build whose hashes differ from what you uploaded; delete that draft instead of publishing it, so GitHub never advertises files that do not match `freedom.baby`.

## 9. Merge the release branch into main

Optionally open a PR from `release/<version>` into `main` for review. Otherwise merge directly:

```
git checkout main
git pull --ff-only
git merge --no-ff release/<version>
git push origin main
git push origin v<version>   # no-op if the tag was already pushed for the Actions build (§8)
```

The `--no-ff` is deliberate — it preserves the release branch as a visible bubble in `main`'s history, which matches how earlier releases landed.

## 10. Post-release housekeeping

- Publish the draft GitHub Release created by the Actions build (or delete it if the release was built locally, see §8), and confirm the release page lists the correct artifacts and release notes.
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
