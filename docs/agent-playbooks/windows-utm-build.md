# Windows-in-UTM Build Playbook

Use this playbook to produce and run a **native Windows build** of Freedom on a
UTM virtual machine running on an Apple Silicon Mac — for example to manually
verify a Windows-specific fix, or to smoke-test the packaged artifact on real
Windows (see `release-process.md` §6).

## When to use this (vs. cross-building)

Release builds come from CI (`release-process.md` §5, `windows-latest` runner,
x64 only). `release-process.md` Appendix A still documents cross-building the
Windows installer from the mac host (`npm run dist -- --win --arm64` for this
playbook's target) as a fallback. `better-sqlite3` is no longer a reason that
artifact would fail to launch: it is a native module `require`d at startup
(`src/main/payment-history.js` → `src/main/index.js`), but since v13 it ships a
`win32-<arch>` prebuild that a `--win` build packages regardless of the build host,
so the old "packaged on macOS ships the darwin `.node` and crashes under Windows"
failure no longer applies.

Build **natively inside the VM** when you want to validate on real Windows rather
than trust the cross-build — it exercises the other native dependencies and the
correct-arch Ant/IPFS binaries and Radicle addon on their actual target. Running the
cross-built installer on a Windows VM (`release-process.md` §6) covers the same
ground and is cheaper; reach for a native in-VM build when that smoke test fails and
you need to tell a packaging bug from a cross-build one.

## Prerequisites

- UTM installed with a Windows VM. The CLI lives at
  `/Applications/UTM.app/Contents/MacOS/utmctl`.
- The VM's **QEMU guest agent** must be running (it ships with UTM's Windows
  guest tools). All automation below goes through it.
- Native ARM64 Node.js + npm + git installed inside the guest. Verify with the
  probe in the cheat sheet below.

### Obtaining the Windows VM

A UTM Windows VM on Apple Silicon must be **Windows 11 on ARM (arm64)**. Get the
image from an official Microsoft source:

- Microsoft publishes the Arm64 disk image directly:
  <https://www.microsoft.com/en-us/software-download/windows11arm64> (multi-edition
  Arm64 ISO; use Firefox/Chrome — Microsoft's page is flaky in Safari).
- UTM's recommended route is **CrystalFetch** (free, Mac App Store), which builds
  the ISO by downloading the files straight from Microsoft's servers. See UTM's
  [Windows guide](https://docs.getutm.app/guides/windows/).

### Activation is a non-issue for build/testing

A fresh install from the multi-edition ISO comes up **unactivated** — `slmgr.vbs
/dli` reports `License Status: Notification` (reason `0xC004F034`) using the
generic edition-selector key (`…8HVX7` for Home). This is expected and **does not
block anything** we need: Windows runs indefinitely in this state (cosmetic
watermark + locked personalization only), and building/running/testing Freedom is
unaffected. Do not treat the watermark as a build problem, and don't apply a
product key unless the box is being kept as a long-lived environment with a valid
license.

## utmctl cheat sheet

```
UTMCTL=/Applications/UTM.app/Contents/MacOS/utmctl
"$UTMCTL" list                              # UUIDs, names, status
"$UTMCTL" start "<VM>"                       # boot (no-op if running)
"$UTMCTL" ip-address "<VM>"                  # guest IPs
"$UTMCTL" exec "<VM>" --cmd <prog> [args…]   # run an executable in the guest
"$UTMCTL" file push "<VM>" '<guest\path>'    # uploads stdin  -> guest file
"$UTMCTL" file pull "<VM>" '<guest\path>'    # guest file -> stdout
```

## Hard-won gotchas (read before automating)

These are the failure modes that waste the most time:

1. **`exec` runs an executable directly — not a shell.** `echo`, `dir`, `if`,
   `mkdir`, `where`, redirection, `&`, `%VAR%` are all `cmd.exe` builtins. Always
   wrap shell-ish commands:

   ```
   "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' '<command line>'
   ```

2. **`exec` does not stream stdout, and for long commands it returns before the
   process finishes.** Redirect to a log file and poll it; optionally append an
   exit sentinel:

   ```
   ... '/c' 'npm ci > C:\freedom-build\npmci.log 2>&1 & echo EXIT=%ERRORLEVEL%>>C:\freedom-build\npmci.log'
   ```

   Then `file pull` the log on a timer. A log that is **locked** on pull
   (`cannot access the file because it is being used by another process`) means
   the command is still running — wait and retry. Use a plain `tasklist` dump to
   confirm whether `node.exe`/`git.exe` is still alive.

3. **The guest agent runs as `NT AUTHORITY\SYSTEM`.** `%USERPROFILE%` is
   `C:\WINDOWS\system32\config\systemprofile`, not the interactive user. To place
   files for the human tester, write to an explicit path like
   `C:\Users\<user>\Desktop` or `C:\Users\Public\Desktop`.

4. **Nested quoting through bash → utmctl → cmd is fragile.** Anything with
   spaces or inner quotes (e.g. `"Freedom Setup 0.7.4-dev.exe"`, `findstr /C:"…"`,
   `tasklist /FI "IMAGENAME eq node.exe"`) tends to get mangled — `eq` becomes an
   "invalid argument", quoted paths lose their quotes. **Fix:** write a `.bat`
   locally, `file push` it, and `exec` the `.bat`. Let the batch file own all the
   quoting. Avoid `tasklist` filters; dump everything and filter on the mac side.

5. **`file push`/`pull` go through the guest agent and are slow (~0.2 MB/s).**
   A 55 MB binary ≈ 4 min; 78 MB ≈ 5.5 min. Run pushes in the background and
   parallelize independent work (e.g. kick off `npm ci`, which does not need the
   bundled binaries, while the binaries upload).

## Architecture: it's Windows-on-ARM

A UTM Windows VM on Apple Silicon is **Windows on ARM (arm64)**. Two traps:

- `%PROCESSOR_ARCHITECTURE%` may report `AMD64` because the guest-agent/`cmd.exe`
  process is an emulated x64 process. **Do not trust it.** The authoritative
  signal is Node:

  ```
  "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' 'node -p "process.platform+process.arch" > C:\freedom-build\arch.txt 2>&1'
  ```

  Expect `win32arm64` → build `--arm64`.

- Since v13, `better-sqlite3` ships Node-API prebuilds for every supported target
  _inside its own tarball_ (`node_modules/better-sqlite3/prebuilds/win32-arm64.node`
  and friends) rather than downloading an Electron-version-specific binary. On its
  own that is not enough to keep node-gyp out of `npm ci`: `@electron/rebuild`
  classifies the package by its leftover `binding.gyp` and would run a node-gyp
  configure that compiles nothing but still fetches Electron headers and invokes
  `find-visualstudio`. `postinstall` therefore runs
  `node scripts/better-sqlite3-prebuilds.js` _before_ the
  `electron-builder install-app-deps` step, deleting that stale `binding.gyp` —
  which is what actually lets `npm ci` finish without Visual Studio Build Tools and
  without a network fetch for this module.

  Note the prune is **unconditional in practice**: its guard is package-wide
  (`prebuilds.length === 0`) because `postinstall` runs long before any build
  target is known, and v13 always ships eight prebuilds — so `binding.gyp` is
  always removed, and there is no per-target source-build fallback left. All six
  targets we package (`{darwin,linux,win32}-{x64,arm64}`) do have a prebuild, and
  `scripts/better-sqlite3-prebuilds.test.js` guards that; targeting an arch
  without one would produce an app with no addon that throws at startup, so
  `scripts/build.js` checks the target's prebuild before packaging and fails
  loudly (`Error: better-sqlite3 ships no prebuilt addon for this target`)
  instead. To build such a target, use the source-build escape hatch — note
  `npm rebuild better-sqlite3` does **not** bring `binding.gyp` back (it only
  re-runs lifecycle scripts; only an install that re-extracts the package
  restores the file, and that immediately re-prunes it). Instead set
  `FREEDOM_BS3_SOURCE_BUILD=1` for both the install and the build, which skips
  the prune and the per-target guard:

  ```
  set FREEDOM_BS3_SOURCE_BUILD=1 && npm ci
  set FREEDOM_BS3_SOURCE_BUILD=1 && npm run build -- --win --x64
  ```

  That path needs the node-gyp toolchain in the guest: Python and MSVC (Visual
  Studio Build Tools) — the very prerequisites the prune otherwise removes.

## End-to-end build

All commands run via the `cmd.exe /c '… > log 2>&1'` + poll pattern from above.

1. **Clone the branch under test into the guest** (the repo is public):

   ```
   git clone --branch <branch> --depth 1 https://github.com/solardev-xyz/freedom-browser.git C:\freedom-build\repo
   ```

   Confirm `git -C C:\freedom-build\repo log --oneline -1` is the commit you expect.

2. **Provide the Windows ARM64 binaries.**
   `npm run check-binaries -- --win --arm64` requires
   `ant-bin/win-arm64/antd.exe`,
   `native/freedom-ipfs-node/prebuilds/win-arm64/freedom_ipfs_native.node`, and
   `radicle-bin/win-arm64/libradicle.node`. Stage the Radicle addon with
   `npm run radicle:download -- --win --arm64`.
   The Ant fetch needs auth, so the reliable path is to **push the local
   Ant/IPFS binaries** rather than download them in the guest:

   ```
   "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' 'mkdir C:\freedom-build\repo\ant-bin\win-arm64 2>nul & mkdir C:\freedom-build\repo\native\freedom-ipfs-node\prebuilds\win-arm64 2>nul'
   "$UTMCTL" file push "<VM>" 'C:\freedom-build\repo\ant-bin\win-arm64\antd.exe' < ant-bin/win-arm64/antd.exe
   "$UTMCTL" file push "<VM>" 'C:\freedom-build\repo\native\freedom-ipfs-node\prebuilds\win-arm64\freedom_ipfs_native.node' < native/freedom-ipfs-node/prebuilds/win-arm64/freedom_ipfs_native.node
   ```

   Verify each pushed file's byte size matches the source (`dir` in guest vs.
   `stat -f %z` on mac) — a truncated push is a common silent failure.

3. **Install dependencies** (can run in parallel with step 2's uploads):

   ```
   cd /d C:\freedom-build\repo & npm ci
   ```

   Success looks like `added N packages`. Under v13 `better-sqlite3` no longer
   appears in the `install-app-deps` module list at all — `postinstall` prunes its
   `binding.gyp` first, so `@electron/rebuild` skips it and the prebuilt
   `win32-arm64.node` is used as shipped. A `• preparing moduleName=better-sqlite3`
   line means the prune did not run.

   Other native dependencies are still rebuilt here and are unrelated to
   `better-sqlite3`: `keccak` (via `@ledgerhq/hw-app-eth`) publishes prebuilds only
   for `darwin-x64`/`linux-x64`/`win32-x64`, so on Windows-on-ARM it is compiled
   from source and does need MSVC + Python in the guest.

4. **Build the distributable:**

   ```
   cd /d C:\freedom-build\repo & npm run dist -- --win --arm64
   ```

   `electron-builder` downloads the win32-arm64 Electron + NSIS toolchain on first
   run and emits, in `C:\freedom-build\repo\dist`:

   - `Freedom Setup <version>.exe` — one-click NSIS installer
   - `Freedom-<version>-arm64-win.zip` — portable build
   - `win-arm64-unpacked\Freedom.exe` — unpacked app

5. **Place the artifact for the tester.** Copy to the interactive user's Desktop
   via a pushed `.bat` (avoids the quoting traps with the space in the filename):

   ```bat
   @echo off
   copy /Y "C:\freedom-build\repo\dist\Freedom Setup <version>.exe" "C:\Users\<user>\Desktop\Freedom Setup <version>-arm64.exe"
   echo COPY_EXIT=%ERRORLEVEL%
   ```

## Testing notes

- The build is **unsigned**, so Windows SmartScreen/Defender shows
  "Windows protected your PC" → **More info → Run anyway**.
- It is an **arm64** build; the bundled Ant/IPFS/Radicle addons are the ARM64
  variants (Ant may use the repository's x64-emulation fallback).
- For issue-#90-class checks: onboarding → create a new wallet → "Setting up node
  identities" should complete without a "node data still in use" error.

## Cleanup / VM lifecycle

- Leave the VM in the state you found it. If you started it from `stopped`,
  offer to `"$UTMCTL" stop "<VM>"` when done.
- Remove scratch dirs you created (`C:\freedom-build`, any `C:\issue90`-style probes) once
  the tester has copied what they need — but never delete user files.
