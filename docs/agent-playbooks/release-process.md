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

## 1. Bump the version

Update the version string in exactly these two files:

- `package.json` — top-level `"version"`.
- `package-lock.json` — the two top-level `"version"` entries (root object and the `""` package entry). Ignore any `0.X.Y` strings inside transitive dependency version ranges (e.g. `iconv-lite`).

No other source file hard-codes the version — the renderer, `electron-builder`, and `electron-updater` all read it from `package.json` at runtime/build time.

Commit style (matches prior releases):

```
chore(release): bump version to <version>
```

## 2. Finalize the changelog

Follow `changelog-process.md` in full. Key points for release branches:

- The baseline for `git log` is the last `package.json` version bump commit.
- Replace the `## [Unreleased]` heading with `## [<version>] - <YYYY-MM-DD>` using the date from `git show -s --format="%ad" --date=short HEAD`.
- Do **not** leave an empty `## [Unreleased]` section behind. The first user-facing change after the release re-introduces the heading above the latest version.

Commit style:

```
docs(changelog): add user-facing <version> release notes
```

## 3. Verify before building

On the release branch, with a clean working tree:

```
npm ci
npm run lint
npm test
npm run check-binaries
```

Spot-check the app once (`npm start`) and confirm the About/version surface reflects the new number.

## 4. Build distributables

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

## 5. Upload binaries and update the website

1. Upload the generated artifacts from `dist/` to `https://freedom.baby/downloads`, including the `latest*.yml` manifests so existing installs pick up the update via `electron-updater` (which is configured with `publish.provider = generic` pointing at that URL).
2. Update the Freedom website to point at the new version:
   - Download links and per-platform file-size metadata.
   - Version string in the downloads intro (e.g. `Alpha release (<version>)`).
   - `Changelog` link — pin to the release branch so the page shows the CHANGELOG state that matches the binaries being served: `https://github.com/solardev-xyz/freedom-browser/blob/release/<version>/CHANGELOG.md`. Do not link to `main`, which will absorb future releases' in-progress notes.

Do this **before** tagging — if an upload reveals a broken artifact, you want to be able to fix it on the release branch without already having a tag pointing at a broken commit.

## 6. Tag the release

On the release branch, from the commit you actually built and shipped:

```
git tag -a v<version> -m "Release <version>"
```

Tag format is `v<version>` (lowercase `v`), matching `v0.6.2`. Do not push the tag yet — push it together with the merge in the next step so `main` and the tag move as one.

## 7. Merge the release branch into main

Optionally open a PR from `release/<version>` into `main` for review. Otherwise merge directly:

```
git checkout main
git pull --ff-only
git merge --no-ff release/<version>
git push origin main
git push origin v<version>
```

The `--no-ff` is deliberate — it preserves the release branch as a visible bubble in `main`'s history, which matches how earlier releases landed.

## 8. Post-release housekeeping

- Confirm the GitHub release page lists the correct artifacts and release notes.
- Keep the `release/<version>` branch around (do not delete) — it matches the historical pattern and is the natural base for a `hotfix/<version>.<patch>` branch later if needed.
- Any build-only fixes that land after the version bump should be committed on the release branch with `fix(build): ...` messages, same as the `0.6.2` cycle did.
