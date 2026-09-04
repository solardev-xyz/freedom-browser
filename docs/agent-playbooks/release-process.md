# Release Process Playbook

Use this playbook when cutting a new Freedom release (any `MAJOR.MINOR.PATCH` bump).

It complements `changelog-process.md` — that playbook covers the mechanics of writing `CHANGELOG.md`; this one covers the surrounding branch, version-bump, build, tag, and publish steps.

**Builds are made by CI, not on a laptop.** Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds every platform on GitHub-hosted runners, signs and notarizes macOS, and attaches the artifacts to a GitHub Release. A release therefore needs no `.env`, no Mac, no Docker and no Windows VM to _build_ — only to _test_ (§6). The version string is the marker for what a build is: `<version>-rc.N` tags become public **Pre-releases** for testing, the bare `<version>` tag becomes a **draft** that is published after the smoke test. Tags are never moved; a bad build means a new number. Building locally remains possible as a fallback (Appendix A).

The flow at a glance:

1. Branch `release/<version>` off `main` (§0), set the version to `<version>-rc.1` (§1), refresh dependencies (§2), draft the changelog (§3), verify (§4).
2. Tag `v<version>-rc.1` and push (§5). CI publishes a pre-release. Smoke-test it on every platform (§6). Fix on the release branch, bump to `rc.2`, tag again — until a candidate is clean.
3. Set the bare `<version>`, finalize the changelog, tag `v<version>` (§5). CI produces a draft release from the same tree that just passed. Re-check the draft's assets (§6, short form).
4. Upload the draft's assets to `freedom.baby`, update the website, publish the draft (§7). Merge the branch into `main` (§8) and open the next dev cycle (§9).

## 0. Create a release branch first

All release work happens on a dedicated branch off `main`, never on `main` directly.

Naming convention (matches prior releases like `release/0.6.2`):

```
release/<version>
```

For example, for 0.8.5:

```
git checkout main
git pull --ff-only
git checkout -b release/0.8.5
```

Rationale:

- Keeps `main` unblocked while the release is being stabilized.
- Gives a clear target for last-minute build/changelog fixups without polluting feature history.
- Every tag — candidates and the final — is created on this branch, so CI builds exactly the tree you stabilized here, and a broken build is fixed here before anything lands on `main`.

Push the branch as soon as it exists (`git push -u origin release/<version>`): the changelog link on the website (§7) points at it, and fixes during the candidate loop arrive as PRs against it.

## 1. Set the version

Between releases, `main` carries a `<next>-dev` version (see §9). On the release branch the version goes through candidates and ends at the bare release number:

- `<version>-rc.1`, `<version>-rc.2`, … for each candidate build (use `-alpha.N` for builds you do not yet believe are shippable);
- `<version>` for the final.

Each bump touches exactly two files:

- `package.json` — top-level `"version"`.
- `package-lock.json` — the two top-level `"version"` entries (root object and the `""` package entry). Ignore any `0.X.Y` strings inside transitive dependency version ranges (e.g. `iconv-lite`).

`npm version <value> --no-git-tag-version` edits both; check the diff, because it also normalises unrelated escapes in `package.json` (it rewrote the `\u2013` in `description` once — revert that). No other source file hard-codes the version: the renderer, `electron-builder` and `electron-updater` all read it from `package.json` at runtime/build time, and the release workflow refuses to build a tag that does not match it.

If the release version differs from the in-flight `<next>-dev` (for example, the cycle was opened as `0.8.1-dev` but is being shipped as `0.8.5`), set the new version directly — the dev suffix exists to make local builds self-identify, not to commit you to a specific number. Rename the matching GitHub milestone at the same time so its issues stay attached.

Commit style:

```
chore(release): cut <version>-rc.1
chore(release): bump version to <version>      # the final
```

Why semver pre-release identifiers and not a separate branch or tag scheme: they show up in every artifact name, in About, and in the update manifests; electron-updater orders them correctly (`<version>` is newer than `<version>-rc.N`, so a tester on a candidate is upgraded to the final automatically); and the release workflow keys its behaviour on them (a hyphen in the tag means "public pre-release", none means "draft").

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

**Review gate (when drafted by an agent).** If the changelog entries were drafted by an agent — or by anyone other than the releaser — **do not create the `docs(changelog): …` commit yet**. Leave the `CHANGELOG.md` edits unstaged (or staged, but uncommitted) on the release branch, present the diff to the releaser, and wait for explicit approval before committing. Iterating in the working tree is cheaper than amending a commit, and avoids the `git commit --amend` ambiguity for agents whose tooling discourages amending without an explicit user request. `CHANGELOG.md` is not read by §4 (verify) or by candidate builds (§5, `rc.N` tags), so those can run in parallel with the review. The **final** tag (§5) and the website update (§7) freeze the changelog state visible to end users and must wait until the commit lands.

If the changelog is already committed when a correction is requested (e.g. the releaser drafted it themselves, or this gate was missed), amend the existing `docs(changelog): …` commit rather than stacking a second changelog commit.

## 4. Verify before tagging

CI covers what `npm test` and `npm run lint` used to cover here: every push to the release branch runs the full CI matrix, and the release workflow runs `check-binaries` itself before packaging. What remains manual:

**License check.** `NOTICES`, `LICENSE_AUDIT.md`, and `licenses-audit.json` attribute the bundled Ant binary as MIT OR Apache-2.0, matching the `LICENSE-MIT` / `LICENSE-APACHE` that `https://github.com/freedom-hq/ant` now publishes. Before tagging, confirm the upstream license is unchanged and update those three files if it differs.

**Source-tree spot check.** `npm ci && npm start` once on the release branch and confirm the About/version surface shows the number you just set. This catches a broken tree before you spend a 25-minute CI run on it.

**CI is green** on the release branch head you are about to tag (`gh pr checks` on the branch's PR, or the Actions tab). The release workflow does not gate on CI, so a red branch produces a red release.

## 5. Build with CI: candidates and the final

Every build is triggered by pushing an annotated tag from the release branch. The tag must equal `v` + the `package.json` version, or the workflow fails in its first minute.

```
git tag -a v<version>-rc.1 -m "Release candidate <version>-rc.1"
git push origin release/<version> v<version>-rc.1
```

What `.github/workflows/release.yml` then does:

| Job                 | Runner             | Output                                                                                                                     |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `mac-arm64`         | `macos-14`         | signed + notarized `.dmg` / `-mac.zip`, `latest-mac.yml`                                                                   |
| `linux-x64`         | `ubuntu-latest`    | `Freedom-<v>.AppImage`, `freedom-browser_<v>_amd64.deb`, `latest-linux.yml`                                                |
| `linux-arm64`       | `ubuntu-24.04-arm` | `Freedom-<v>-arm64.AppImage`, `freedom-browser_<v>_arm64.deb`, `latest-linux-arm64.yml`                                    |
| `windows-x64`       | `windows-latest`   | `Freedom-Setup-<v>.exe`, `Freedom-<v>-win.zip`, `latest-win-x64.yml` (unsigned)                                            |
| `smoke-mac-arm64`   | `macos-14`         | §6 steps 1/2/6 against the app from the `.dmg` and from the `-mac.zip`                                                     |
| `smoke-linux-x64`   | `ubuntu-latest`    | §6 steps 1/2/6 against the installed `.deb` and the extracted AppImage                                                     |
| `smoke-linux-arm64` | `ubuntu-24.04-arm` | the same two legs on arm64 hardware                                                                                        |
| `smoke-windows-x64` | `windows-latest`   | §6 steps 1/2/6 against the silently installed NSIS package and the portable zip                                            |
| `release`           | `ubuntu-latest`    | after **all four builds and all four smoke jobs** succeeded: one GitHub Release with every file above and the `.blockmap`s |

- **Candidate tag** (`v<version>-rc.N`, anything with a hyphen): the release is created as a draft, the assets are uploaded, then it is flipped to a published **Pre-release**. Public, direct download links, excluded from "Latest release". Hand these to testers.
- **Final tag** (`v<version>`): the release stays a **draft** until you publish it in §7. Drafts are visible and downloadable only to people with write access to the repo.
- A failed leg means no release. Fix the cause, then "Re-run failed jobs" on that run: the successful legs' artifacts are kept and the `release` job runs again. If the fix needs a code change, it lands on the release branch as a PR and the next candidate (`rc.N+1`) picks it up; never move a tag.
- Re-running onto a tag whose release is already published fails on purpose rather than overwriting files people may have downloaded.
- Expect 20–30 minutes per run, plus a few minutes for the smoke job that follows each build. macOS takes longest (two notarizations: electron-builder staples the `.app`, a dedicated step then notarizes and staples the `.dmg` and refreshes its hash in `latest-mac.yml`). Arti (Tor) is compiled from crates.io on the macOS and Linux runners.

Windows arm64 is intentionally not built (never shipped on `freedom.baby`, no Myotis addon). No Windows code-signing certificate exists, so the installer is unsigned and SmartScreen prompts on first run. The installer is named `Freedom-Setup-<v>.exe` (`build.nsis.artifactName`), not electron-builder's default with spaces, because GitHub rewrites spaces in release-asset names to dots, which would break the `url:` in `latest-win-x64.yml`.

**The candidate loop.** Cut `rc.1` as soon as the branch is set up (§1–§4). Fix issues with PRs against `release/<version>` (or land them on `main` and cherry-pick), bump to `rc.2`, tag, push. Repeat until a candidate passes §6 with nothing left to fix. Only then set the bare version (§1), finalize the changelog commit (§3), and tag `v<version>` from that commit. The final build is then the same tree as the last candidate plus the version and changelog commits, which is the point: a final that fails §6 becomes the next patch version, not a retag.

**Manual runs** (Actions → "Release" → Run workflow) build every platform from any branch and upload one workflow artifact per platform, without creating a release. Untick `signed` for a macOS pipeline test that needs no secrets; untick `bundle_tor` to skip the Arti build. Workflow artifacts are zipped, need a GitHub login, and expire — they are for your own checks, not for handing out.

## 6. Manual cross-platform smoke testing

CI now launches every artifact it packages (steps 1, 2, 3, 5 and 6 below), but only on a runner and only through those checks. The automated legs already block a wrong native-module ABI (the launch leg fails), a missing or wrong-arch bundled binary or addon (`antd`, freedom-ipfs, `libradicle.node`, and Arti where bundled — the node legs fail naming the node), and the `extraResources` / asar-unpack mistakes those imply. Smoke testing each artifact on a real instance of its target OS still catches what a runner cannot:

- Gatekeeper and SmartScreen interaction on a real first launch (the runner only asks `spctl`; Windows is unsigned and prompts)
- Platform-specific code paths the specs do not exercise (native menus, system trust store, default-browser and URL-scheme hooks, file dialogs)
- Real-network retrieval over the bundled nodes (`bzz://`, `ipfs://`, `rad://`, onion) — CI asserts the nodes start, not that they fetch
- Upgrade in place from the previous final with a real profile

Test the **candidate** pre-releases in full; re-check the **final** draft in short form (launch + version on each platform), since it is the same tree plus the version and changelog commits.

### Getting the artifacts onto test machines

Download straight from the GitHub Release page — no LAN server, no `scp`, no USB stick. Candidates are public:

```
https://github.com/solardev-xyz/freedom-browser/releases/download/v<version>-rc.N/<file>
```

The final's draft is only visible to repo collaborators; download it while logged in, or use `gh release download v<version> --pattern '<file>'`.

Verify the download against the matching `latest-*.yml` in the same release (each file's `sha512:` field is base64):

- Linux / macOS: `openssl dgst -sha512 -binary <file> | base64 -w0` — should print the base64 hash from the manifest verbatim
- Windows (PowerShell): `(Get-FileHash -Algorithm SHA512 <file>).Hash` prints hex; compare it with the manifest's hash decoded once on any Unix host: `echo "<base64>" | base64 -d | xxd -p -c 256`

### Use a separate profile

A candidate shares the app id and profile directory with whatever Freedom is installed on the test machine. Run it against a scratch profile so migrations and node data cannot touch a real one — launch the binary directly, `open -a` does not forward environment variables:

```
# macOS
FREEDOM_TEST_USER_DATA="$HOME/freedom-rc-test" /Applications/Freedom.app/Contents/MacOS/Freedom
# Linux
FREEDOM_TEST_USER_DATA="$HOME/freedom-rc-test" ./Freedom-<version>.AppImage
# Windows (PowerShell)
$env:FREEDOM_TEST_USER_DATA="$env:USERPROFILE\freedom-rc-test"; & "$env:LOCALAPPDATA\Programs\freedom-browser\Freedom.exe"
```

The Windows install directory is `freedom-browser` (the package `name`), not `Freedom`: electron-builder only uses the product name for the install folder of an assisted or per-machine installer, and ours is one-click per-user. `smoke-windows-x64` finds it rather than assuming it, and prints the path it found.

Run the checklist twice per candidate where it matters: as a fresh install (empty scratch profile) and as an upgrade from the last final (copy a real profile into the scratch directory first).

### Test environments

- **Linux**: a VM or bare-metal Linux machine matching the target arch. `Freedom-<version>.AppImage` runs without install (`chmod +x` then double-click or launch from a terminal); `freedom-browser_<version>_amd64.deb` installs via `sudo apt install ./freedom-browser_<version>_amd64.deb`. Repeat for the arm64 artifacts on an arm64 Linux instance (e.g. a Raspberry Pi or a UTM arm64 VM on Apple Silicon).
- **Windows**: a Windows VM (UTM, Parallels, VMware Fusion) or a separate Windows host. The NSIS installer (`Freedom-Setup-<version>.exe`) runs unprivileged; the portable `Freedom-<version>-win.zip` extracts and runs without install. The installer is unsigned (no Windows certificate exists), so SmartScreen shows "Windows protected your PC" — More info → Run anyway is the expected path; outright "blocked by your administrator" is not.
- **macOS**: any Apple Silicon Mac — install the `.dmg` and run the same checklist. The workflow already ran `spctl` / `stapler` on the runner; on the test Mac just confirm the app opens with no Gatekeeper warning.

### Per-platform smoke checklist

For each platform, run through:

1. **Launch**: the app opens cleanly — no crash dialog, main window appears
2. **Version**: About / `freedom://settings` shows `<version>` from `package.json`
3. **Navigation**: type `https://example.com`, confirm a basic HTTPS page renders and the address-bar shield is in its default state
4. **Headline feature**: spot-check whatever the release leads with. For releases that touch ENS / Swarm / IPFS / Radicle, that means opening an `ens://`, `bzz://`, `ipfs://`, or `rad://` URI and confirming the documented behaviour (e.g. for `0.7.2`: Colibri verification surfaces in the address-bar shield popover)
5. **Bundled nodes**: confirm Ant, native IPFS, and Radicle start cleanly (Radicle ships on macOS, Linux, and Windows). The nodes manager or the relevant `freedom://` settings page surfaces this — a "node failed to start" red badge or a missing native addon/API port is the failure mode
6. **Persistence**: change one trivial setting (e.g. theme), close the app fully, reopen, confirm the change stuck

**Every platform runs steps 1, 2, 3, 5 and 6 automatically.** The four `smoke-*` jobs in `.github/workflows/release.yml` drive the run's own artifacts with two Playwright projects (`npm run test:e2e:packaged` runs both), each on a runner of the target OS and arch, and each twice because every platform ships two things a user can install: macOS the app copied out of the mounted `.dmg` and the app from the `-mac.zip`; Linux (x64 and arm64) `/opt/Freedom/freedom` from the installed `.deb` and the binary inside the extracted AppImage; Windows `%LOCALAPPDATA%\Programs\freedom-browser\Freedom.exe` from the silently installed NSIS package and `Freedom.exe` from the portable zip. `packaged` covers steps 1, 2 and 6 (launch, version, persistence) with the app's nodes and network stubbed out; `packaged-live` launches the same artifact without the test harness and covers steps 3 and 5 — a local page and `https://example.com` render with the shield in its default state, and the bundled Ant (including a `/health` call on the port the app publishes), native IPFS and Radicle each reach "running". Tor is asserted the same way wherever the build bundles Arti — the shipped `arti` binary must run (`arti --version`) and the node must reach "running" — and is reported as a skip with its reason where the build bundles none (Windows, and any build made without `npm run tor:download`) or where Arti cannot bootstrap a circuit inside `tor-manager`'s own ~120s budget, which is a property of the runner's network path rather than of the artifact. `release` depends on all four jobs, so an artifact that cannot launch, reports the wrong version, cannot render a page, cannot start its nodes, or loses a setting across a restart never reaches a release page. Each job passes the tag version as `FREEDOM_E2E_EXPECTED_VERSION`, which is exactly the step-2 check; a signed mac run additionally asserts `spctl` accepts the app copied out of the disk image. Step 4 (headline feature), the wallet, and the upgrade-from-previous-version pass are **not** automated on any platform and are still done by hand as described above. To run the automated legs yourself against any packaged build:

```bash
FREEDOM_E2E_EXECUTABLE="$PWD/dist/linux-unpacked/freedom" \
  FREEDOM_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e:packaged
```

If any platform fails: fix on the release branch (PR), bump to the next `rc.N`, tag, push, and re-test that candidate. Do not proceed to §7 until every platform you intend to ship passes on the **same** candidate — one green build, not a patchwork of legs from different runs.

This step is intentionally separate from §4 — §4 verifies the source tree; §6 verifies the **packaged artifact** that end users will install. They catch different classes of bugs.

## 7. Publish

Order matters: `freedom.baby/downloads` is what existing installs poll for updates, so it goes live together with the GitHub release, never before the smoke test and never with candidate files.

1. Download the final's assets from its draft release (`gh release download v<version> --dir dist-release`). These are the bytes to publish everywhere — do **not** rebuild locally, or GitHub and `freedom.baby` would serve two different signed builds of one version with different hashes.
2. Upload them to `https://freedom.baby/downloads`: every installer / archive / `.blockmap` plus all four manifests (`latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`, `latest-win-x64.yml`) so existing installs pick up the update via `electron-updater` (`publish.provider = generic` pointing at that URL). Never upload `rc.N` files or manifests there — the updater auto-downloads whatever the manifest advertises.
3. Update the Freedom website:
   - Download links and per-platform file-size metadata. The Windows installer is `Freedom-Setup-<version>.exe` (with hyphens) since releases moved to Actions.
   - Version string in the downloads intro (e.g. `Alpha release (<version>)`).
   - `Changelog` link — pin to the release branch so the page shows the CHANGELOG state that matches the binaries being served: `https://github.com/solardev-xyz/freedom-browser/blob/release/<version>/CHANGELOG.md`. Do not link to `main`, which will absorb future releases' in-progress notes.
4. Publish the draft GitHub Release (`gh release edit v<version> --draft=false`, or the Publish button). Give it the release notes from the changelog section; the workflow only wrote a one-line placeholder. Confirm the page lists every artifact from the table in §5.

Candidate pre-releases can stay on the Releases page; they are marked Pre-release and sort below the final. Delete them only if they are known-broken and you do not want anyone to keep installing them.

## 8. Merge the release branch into `main`

Optionally open a PR from `release/<version>` into `main` for review. Otherwise merge directly:

```
git checkout main
git pull --ff-only
git merge --no-ff release/<version>
git push origin main
```

The `--no-ff` is deliberate — it preserves the release branch as a visible bubble in `main`'s history, which matches how earlier releases landed. The tag is already on the remote (it triggered the build), so there is nothing else to push.

Housekeeping:

- Keep the `release/<version>` branch around (do not delete) — it matches the historical pattern, the website's changelog link points at it, and it is the natural base for a `hotfix/<version>.<patch>` branch later if needed.
- Any build-only fixes that landed after the version bump should have been committed on the release branch with `fix(build): ...` messages, same as the `0.6.2` cycle did.

## 9. Open the next dev cycle on `main`

Immediately after the merge, bump `main` to the next dev version so local/CI builds and the About dialog stop advertising the just-shipped release.

Default to a patch bump — e.g. after shipping `0.7.0`, set `main` to `0.7.1-dev`. If the next cycle later turns out to be a minor or major (or you decide upfront), re-bump to `0.8.0-dev` / `1.0.0-dev`; nothing downstream depends on the suffix's exact `MINOR.PATCH`.

Update the same two files as §1:

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

## Appendix A: building locally (fallback)

Use this only when the workflow cannot be used — for instance to debug a packaging problem the runner logs do not explain, or if GitHub Actions is down. Everything here reads the version from `package.json`; run it from the release branch.

If you publish a locally built artifact, **do not also publish the Actions build of the same tag**: the two are different signed builds with different hashes. Delete the workflow's draft instead, and note in the release which build shipped.

### macOS (signed + notarized, inline)

```
npm run dist -- --mac
```

`build.mac.notarize: true` in `package.json` makes `electron-builder` submit and staple the notarization in the same invocation. The command blocks until Apple finishes notarizing — expect several minutes. This was the release flow before the workflow existed.

That inline pass notarizes and staples **`Freedom.app` only**. `dmg-builder` then wraps the already-stapled app in a disk image but never notarizes the image itself, so the `.dmg` this command produces has no ticket of its own (`xcrun stapler validate` on it fails, and Gatekeeper has to check it online when a user opens it). If you hand out that disk image, notarize and staple it too:

```
xcrun notarytool submit dist/Freedom-<version>-arm64.dmg \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple dist/Freedom-<version>-arm64.dmg
```

Stapling rewrites the image, so the `.dmg` entry in `dist/latest-mac.yml` no longer matches the file you upload — refresh its `sha512`/`size` (the release workflow does this automatically). The macOS updater only reads the `.zip` entry, so this affects the checksum manifest, not updates. The async fallback below already submits and staples the `.dmg` for you.

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

## Appendix B: the release workflow, for maintainers

`.github/workflows/release.yml`. Things a releaser needs to know that are not obvious from the run page:

- **Secrets** (Settings → Secrets and variables → Actions): `CSC_LINK` (Developer ID Application certificate exported from Keychain Access as a password-protected `.p12`, base64-encoded), `CSC_KEY_PASSWORD`, and `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` (the same values as `.env.example`). Only the macOS job reads them. electron-builder imports the certificate into a temporary keychain for the run. When the certificate is renewed, re-export and replace `CSC_LINK` + `CSC_KEY_PASSWORD`; nothing else changes. A signed run with any secret missing fails in its first step with the list of missing names.
- **Guards**: the tag must match `package.json`; a release lookup that fails for a transient API reason fails the run instead of creating a duplicate draft; more than one release on a tag aborts; re-running onto a published release aborts.
- **Ordering inside a run**: create draft → upload every asset → (candidates only) flip to published pre-release. Watchers never see an empty release.
- **Re-runs**: "Re-run failed jobs" keeps the successful legs' artifacts and re-runs `release`. "Re-run all jobs" rebuilds everything, including a fresh macOS signature and notarization — the bytes and hashes change, which is fine for a draft and forbidden for a published release (the guard above).
- **Update channel**: `build.publish.channel` is pinned to `latest` in `package.json`; without it electron-builder derives the channel from the version's pre-release suffix and would name the manifest `rc-mac.yml`. `scripts/build.js` pins the Windows channel to `latest-win-x64` on the command line.
- **Known first-run fixes** worth remembering when a leg breaks: the adblock list download uses a retrying `https` client because the EasyList server drops connections; the Ant and IPFS fetch scripts extract archives with Windows' own bsdtar and relative paths because the Windows job runs in Git Bash, where GNU tar misreads `D:\...` as a remote host.
- **Smoke gate**: `smoke-linux` (a matrix over x64/arm64), `smoke-mac-arm64` and `smoke-windows-x64` each run after their build job and before `release` (§6). They need no secrets and rebuild nothing — `npm ci --ignore-scripts`, then Playwright against the run's own artifacts. A failure in any of them blocks the release job; each uploads its Playwright traces as `smoke-<platform>-report` (deliberately not matching the `freedom-*` pattern the `release` job downloads, so traces can never become release assets). The mac job reads the signing state off the artifact name it downloaded (`freedom-mac-arm64-signed` / `-unsigned`) and only assesses Gatekeeper when there is a signature to assess, so an unsigned dispatch run still passes.
- **Cost**: the repo is public, so runner minutes are free. A full run is four parallel build jobs of 10–25 minutes, plus a smoke job per platform of a few minutes each (also in parallel, each waiting only on its platform's build job (the two Linux smoke legs wait on the whole Linux build matrix, since `needs` cannot target one matrix leg)).
