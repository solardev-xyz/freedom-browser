# Electron 44 compatibility audit — 2026-09

Assessment of upgrading `electron` from the declared `^43.0.0` (lockfile
`43.0.0`; latest 43.x is `43.6.0`) to the latest 44.x, **`44.2.0`**. This is the
three-check triage that `docs/agent-playbooks/release-process.md` §2 requires of
an out-of-range major before it can be bundled into a release cycle: the own-API
check, the native-module compatibility check, and the build-pipeline check.

**Verdict: no-go for now.** One hard blocker (a stale `node-abi` in the
lockfile) and one confirmed application regression (the main-process
`clipboard` API, rearchitected in 44.0) must land first. Both are small and
fully understood; neither needs anything from an upstream we do not control.
Details in [Go / no-go](#go--no-go).

Method, tooling and conventions:

- Base commit: `b0bf04e8` (`main`, "Merge pull request #266"). The only tracked
  change on the trial branch is `electron ^43.0.0 -> ^44.2.0` in `package.json`
  plus the resulting single-package `package-lock.json` hunk (`43.0.0` →
  `44.2.0`). No other dependency was touched — verified with `git diff --stat`
  (2 files, 5 insertions, 5 deletions).
- Host: Linux x64, kernel 6.14, Node 22.14.0 on `PATH`, `xvfb-run` available.
  Everything below was run on that one host; per-platform gaps are called out
  explicitly rather than assumed to generalise.
- Upstream facts (ABI numbers, Chromium/Node/V8 versions, release dates) come
  from `https://releases.electronjs.org/releases.json` and
  `https://github.com/electron/node-abi`'s `abi_registry.json`; breaking-change
  text from `docs/breaking-changes.md` at tag `v44.2.0`. Runtime numbers were
  re-derived locally rather than taken on trust.
- Upstream state is observed **as of 2026-09-08** and will drift. Every claim
  about what upstream ships today is dated in place.

---

## 1. Native modules and the new module ABI

### The ABI number

Electron 44 raises `NODE_MODULE_VERSION` from **148** to **149**.

`node_modules/electron/abi_version` after installing `electron@44.2.0`:

```
149
```

Confirmed at runtime rather than from the shipped file alone:

```
$ ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron /tmp/abi-probe.js
{ "electron": "44.2.0", "modules": "149", "node": "24.20.0",
  "v8": "15.2.124.19-electron.0", "chrome": "152.0.7977.76", "napi": "10" }
```

and again from inside the packaged linux-x64 artifact built for §2:

```
$ ELECTRON_RUN_AS_NODE=1 ./dist/linux-unpacked/freedom -p "..."
{"electron":"44.2.0","modules":"149","chrome":"152.0.7977.76"}
```

For reference, from `releases.json`:

| release                   | Chromium       | Node    | V8          | `modules` | date       |
| ------------------------- | -------------- | ------- | ----------- | --------- | ---------- |
| 43.0.0 (current lockfile) | 150.0.7871.46  | 24.17.0 | 15.0.245.13 | 148       | 2026-06-30 |
| 43.6.0 (latest 43.x)      | 150.0.7871.250 | 24.20.0 | 15.0.245.31 | 148       | 2026-09-04 |
| 44.0.0                    | 152.0.7977.54  | 24.18.1 | 15.2.124.13 | **149**   | 2026-08-24 |
| 44.2.0 (target)           | 152.0.7977.76  | 24.20.0 | 15.2.124.19 | **149**   | 2026-09-04 |

Note Chromium jumps **two** majors (150 → 152); Electron 44 skipped 151. Node is
unchanged at 24.20.0 between 43.6.0 and 44.2.0.

### Every shipped addon is Node-API, so ABI 149 is a non-event for them

This is the headline result and it is the reason the bump is cheap rather than
blocked-by-upstream. `NODE_MODULE_VERSION` only gates addons built against the
V8/Node C++ ABI. All five native modules this app loads are Node-API
(`napi_*`), which is ABI-stable across Node and Electron majors by design, so
none of them needs an upstream rebuild for 149.

Symbol check on the linux-x64 artifacts (`nm -D --defined-only`):

| module                                              | `napi_register_module_v1`                                                                                  | legacy `node_register_module_v*` |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `better-sqlite3` `prebuilds/linux-x64.node`         | 1                                                                                                          | 0                                |
| `keccak` `prebuilds/linux-x64/node.napi.glibc.node` | 0 — but exports `__napi_Init(napi_env, napi_value)` and has 39 undefined `napi_*` imports (node-addon-api) | 0                                |
| `freedom-ipfs` `freedom_ipfs_native.node`           | 1                                                                                                          | 0                                |
| `libradicle` `libradicle.node`                      | 1                                                                                                          | 0                                |
| Myotis `myotis-node.node`                           | 1                                                                                                          | 0                                |

And the load test — every addon `require()`d under the new Electron on this
host, alongside plain Node as a control:

```
########## under plain Node (modules 127) ##########
runtime abi = 127 | electron (none) | node 22.14.0
OK    better-sqlite3: loaded (function, 1 exports)
OK    keccak: loaded (function, 0 exports)
OK    freedom-ipfs: loaded (object, 17 exports)
OK    libradicle: loaded (object, 31 exports)
OK    myotis: loaded (object, 17 exports)

########## under Electron 44.2.0 (modules 149) ##########
runtime abi = 149 | electron 44.2.0 | node 24.20.0
OK    better-sqlite3: loaded (function, 1 exports)
OK    keccak: loaded (function, 0 exports)
OK    freedom-ipfs: loaded (object, 17 exports)
OK    libradicle: loaded (object, 31 exports)
OK    myotis: loaded (object, 17 exports)
```

**Nothing fails to load. No addon needs a new upstream release for ABI 149.**
The same binary loading under ABI 127 and ABI 149 is the positive control that
these are genuinely ABI-independent rather than coincidentally matching.

Per-module detail, with the state of each upstream as of 2026-09-08:

- **`better-sqlite3` 13.0.3** — ships bundled Node-API prebuilds for 8
  platform/arch targets named by platform-arch only (no ABI in the filename);
  `binding.gyp` declares `NAPI_VERSION=10`, and Electron 44 reports
  `process.versions.napi === '10'`. `scripts/better-sqlite3-prebuilds.js`
  pruned it out of the rebuild pass as designed
  (`→ better-sqlite3: removed the unused binding.gyp (8 prebuilt addons
available); @electron/rebuild will leave it alone`). Per release-process.md
  §2, a clean `install-app-deps` says **nothing** about this module, so it was
  validated at runtime instead: the SQLite-backed suites in `npm test`
  (`history.test.js`, `payment-history.test.js`, `downloads/*`) and the harness
  e2e run in §3 both pass on 44.2.0. No Electron-44 issue exists upstream, and
  the per-Electron prebuild issues stop at v43 because v13's N-API move made
  them unnecessary.
- **`keccak` 3.0.4** — transitive only (`@ledgerhq/hw-app-eth` →
  `@ledgerhq/domain-service` → `eip55` → `keccak`); no `src/` file requires it.
  Prebuilds are all `node.napi.*`, never `electron.abiNNN.*`, so "is there a
  release built for ABI 149" is the wrong question — it never keyed on ABI.
  It is nonetheless the module that **triggers** the blocker in §2, because a
  leftover package-root `binding.gyp` makes `@electron/rebuild` classify it as
  native and consult `node-abi`. Upstream is dormant (last release 2023-09-20,
  no commits since) and ships **no arm64 prebuilds** for either macOS or Linux
  — a pre-existing gap tracked in #204, unchanged by this bump and not made
  worse by it.
- **`freedom-ipfs` v0.4.3** (`scripts/fetch-freedom-ipfs-native.js`) — assets
  are named `freedom-ipfs-node-electron41-<target>.tar.gz`. **That `electron41`
  string is a build label, not an ABI gate**: the artifact exports
  `napi_register_module_v1` and loads fine on ABI 149, which is also how it
  already works on the current Electron 43 (ABI 148) despite the name. No new
  upstream release is required. The name is misleading enough to be worth
  renaming on the next bump.
- **`libradicle` v0.7.1** (`scripts/fetch-radicle-addon.js`,
  `src/shared/radicle-addon-version.js`) — napi-rs binding, assets
  `libradicle-<plat>-<arch>.node` with no ABI in the name. Loads on 149 and
  exposes all 30 `RADICLE_ADDON_REQUIRED_EXPORTS`. No new release required.
- **Myotis v0.1.7** (`scripts/fetch-myotis.js`) — napi-rs binding. Its
  `EXPECTED_ABI = 22` check in `src/main/myotis/myotis-manager.js` is the
  **Myotis engine API version, not a Node module ABI**, and is unaffected by
  Electron 44. No new release required.

`npm run check-binaries` passes on 44.2.0 once the (Electron-independent) Ant
and adblock assets are fetched:

```
Checking binaries for: linux-x64
⚠️  Arti (Tor) binary not found for linux-x64 — Tor will not be bundled.
   Optional; build it with: npm run tor:download  (requires a Rust toolchain)
✅ All required binaries found.
```

(It is a pure existence check — no checksum, no ABI, no `require()` — so it
neither confirms nor denies ABI compatibility. The load test above is what
carries that claim.)

### Coverage gap

All addon load testing above is **linux-x64 only, on one host, under Electron
44**. macOS arm64/x64 and Windows x64 artifacts were not exercised under
Electron anywhere. They come from the same napi-rs / node-addon-api builds, so
the same conclusion is _expected_ to hold — but it is **unverified**, and it is
worth being precise about why CI does not close this gap:

CI's `freedom-ipfs-native-addon` (4 targets), `radicle-addon-load` (5) and
`myotis-addon-load` (5) matrices do cover every shipped platform/arch, and all
14 legs pass on this branch. **That is not Electron 44 evidence.** All three
jobs install with `npm ci --ignore-scripts`, which never downloads Electron at
all, and then `require()` the addon under **plain Node 24**. They therefore
produce byte-identical results on this branch and on `main`; their green status
says the addons still load under Node 24, not that they load under ABI 149.

For Node-API addons that is a defensible design — the whole point of N-API is
that Node and Electron are equivalent hosts — and the linux-x64 result above
does demonstrate the equivalence directly (the same binaries loading under ABI
127 and ABI 149). But it does mean **nothing in CI asserts an Electron ABI for
any addon on any platform**, and nothing in the repo asserts a Node ABI either
(`grep -rn "NODE_MODULE_VERSION\|process.versions.modules\|node-abi"
src/ scripts/ .github/` → zero hits). The macOS and Windows Electron-44 load
path is genuinely untested and has to be covered by the manual smoke pass, or
by adding an Electron-hosted load check to those matrices.

---

## 2. The three release-process.md §2 checks

### Check 1 — own-API check (breaking changes traced to code)

Electron 44.0 has nine entries under `Breaking API Changes (44.0)`. Each was
grepped against `src/`:

| #   | 44.0 breaking change                                                              | Hits in `src/`?                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Behavior Changed: `webContents` may be null in `select-client-certificate`        | **No** — `grep -rn "select-client-certificate" src/ scripts/` → no hits. We never register the handler.                                                                                                                                                     |
| 2   | Removed: macOS 12 support                                                         | **No** — no `minimumSystemVersion`, no macOS-version claim in `src/` or `package.json`. Release/support docs may still want a note; nothing to change in code.                                                                                              |
| 3   | Behavior Changed: ANGLE statically linked, `libEGL`/`libGLESv2` no longer shipped | **No** — `grep -rn "libEGL\|libGLESv2\|swiftshader" src/ scripts/ package.json .github/` → no hits. Confirmed harmless empirically: the linux-x64 build below produced no `libEGL.so`/`libGLESv2.so` and nothing in packaging referenced them.              |
| 4   | Behavior Changed: `net.request` rejects frame destinations without navigate mode  | **No practical hit** — two `net.request` call sites, `src/main/favicons.js:88` and `src/main/ens-prefetch.js:97`, both plain GETs. `grep -rn "Sec-Fetch" src/` → no hits, so neither can send a `document`/`frame`/`iframe`/`fencedframe` `Sec-Fetch-Dest`. |
| 5   | Removed: Unity desktop support (`app.isUnityRunning`, Linux badge/progress)       | **No** — `grep -rn "isUnityRunning\|setBadgeCount\|badgeCount\|setProgressBar" src/` → no hits.                                                                                                                                                             |
| 6   | Removed: Windows ia32 and Linux armv7l                                            | **No** — `grep -rniE "ia32\|armv7\|arch.*all" package.json scripts/build.js .github/workflows/release.yml` → no hits. We ship x64/arm64 only. See the electron-builder note below, though.                                                                  |
| 7   | Removed: `clipboard` module in the renderer                                       | **No** — renderer code already uses `navigator.clipboard` (`src/renderer/lib/chrome-input-context-menu.js:97,120`, `page-context-menu.js:221`, `github-bridge-ui.js:405`). Nothing in `src/renderer/` requires `electron`.                                  |
| 8   | **API Changed: `clipboard` rearchitected to the W3C Clipboard API**               | **YES — 3 hits, one of them a hard break.** See below.                                                                                                                                                                                                      |
| 9   | Removed: pre-macOS-13 login item attributes (`openAsHidden` etc.)                 | **No** — `grep -rn "setLoginItemSettings\|getLoginItemSettings\|openAsHidden" src/` → no hits.                                                                                                                                                              |

44.0 introduced no new deprecations. Scanning 44.0.x → 44.2.0: **44.2.0 fixes
native addons deriving from `node::ObjectWrap` aborting during GC on Node
≥24.19.0** — so if this bump ever ships, it must pin **≥ 44.2.0**, never
44.1.0/44.1.1.

#### The one real own-API hit: `clipboard` in the main process

`src/main/ipc-handlers.js:8` imports `clipboard` from `electron` and uses it at
three sites, all inside `ipcMain.handle` callbacks:

```
src/main/ipc-handlers.js:953:      clipboard.writeText(text);
src/main/ipc-handlers.js:968:    return { success: true, text: clipboard.readText() };
src/main/ipc-handlers.js:985:      clipboard.writeImage(image);
```

The 44.0 rearchitecture makes `writeText`/`readText` return Promises and
**removes `writeImage`/`readImage` outright**. Verified in a real Electron 44
main process rather than from the docs:

```
$ xvfb-run -a ./node_modules/electron/dist/electron --no-sandbox /tmp/clip-probe.js
electron 44.2.0 modules 149
clipboard members: writeText=function readText=function writeImage=undefined
  readImage=undefined readHTML=undefined writeHTML=undefined
  availableFormats=undefined readBuffer=undefined writeBuffer=undefined
  has=function clear=function ... selection=object
writeText returns: Promise
readText returns: Promise
  awaited readText -> "probe-value"
writeImage THROWS: clipboard.writeImage is not a function
```

and re-confirmed inside the shipping app under the e2e harness:

```
SURFACE {"writeImageType":"undefined","readImageType":"undefined","readTextType":"function"}
MAINPROBE {"writeTextReturnsPromise":true,"readTextReturnsPromise":true,
           "writeImageType":"undefined","readImageType":"undefined"}
```

Consequences, in severity order:

1. **`clipboard:read-text` (`:968`) hangs forever.** The handler returns
   `{ success: true, text: <Promise> }`. Electron's IPC serializer cannot
   structured-clone a Promise, and the renderer's `ipcRenderer.invoke` **never
   settles** — it does not reject, it simply never returns. A harness probe
   driving the real `window.electronAPI.readClipboardText()` sat pending until
   the 60s test timeout tore the app down. User-visible effect: address-bar
   context-menu **Paste** silently does nothing.
2. **`clipboard:copy-image` (`:985`) throws.** `clipboard.writeImage is not a
function` → a `TypeError` caught by the handler's own `catch`, so it
   degrades to `{ success: false, error: 'clipboard.writeImage is not a
function' }` rather than crashing. User-visible effect: "Copy image" in the
   page context menu always fails. (Note this is the `copy-image` sibling of the
   `save-image` handler — the same pair PR #158 had to fix twice; both need
   checking together again here, though `save-image` uses no clipboard API and
   is unaffected.)
3. **`clipboard:copy-text` (`:953`) races.** `writeText` now returns an
   un-awaited Promise, so the handler reports `{ success: true }` before the
   write has necessarily landed. Not observed to fail in the e2e run, but it is
   a real "reports success early" bug.

The fix is small and local — `await` the two text calls, and replace
`writeImage` with the W3C-shaped `clipboard.write([...])` — but it is a
**behaviour change that must land with test assertions for the new behaviour**,
and `src/main/ipc-handlers.test.js:1289-1340` currently asserts the old
synchronous shapes (`expect(ctx.clipboard.writeImage).toHaveBeenCalled()`), so
those go green against a mock while the real app is broken. That mismatch is
exactly why the unit suite passes on 44.2.0 and the e2e suite does not.

### Check 2 — the `install-app-deps` pass

**FAILS.** This is the hard blocker. `npm ci` dies in `postinstall`:

```
> freedom-browser@0.8.5-dev postinstall
> node scripts/better-sqlite3-prebuilds.js && electron-builder install-app-deps

→ better-sqlite3: removed the unused binding.gyp (8 prebuilt addons available);
  @electron/rebuild will leave it alone
  • executing @electron/rebuild  electronVersion=44.2.0 arch=x64 ...
  • preparing       moduleName=keccak arch=x64
  ⨯ Could not detect abi for version 44.2.0 and runtime electron.
    Updating "node-abi" might help solve this issue if it is a new release of electron
    at getAbi (node_modules/node-abi/index.js:32:9)
    at PrebuildInstall.prebuiltModuleExists (node_modules/@electron/rebuild/lib/module-type/prebuild-install.js:54)
npm error command failed
```

Root cause, and it is **not** an addon incompatibility: the lockfile pins
`node-abi@4.32.0` (via `electron-builder@26.15.3 → app-builder-lib →
@electron/rebuild@4.1.0`), whose `abi_registry.json` stops at
`{"abi":"148","runtime":"electron","target":"43.0.0-alpha.1"}`. There is no
entry for Electron 44, so `getAbi()` throws before any module is even examined:

```
$ node -e "const {getAbi}=require('node-abi'); ..."
43.6.0 -> 148
44.0.0 -> ERROR: Could not detect abi for version 44
44.2.0 -> ERROR: Could not detect abi for version 44
```

Proven to be the _only_ blocker by patching the local registry with
`{abi:'149', runtime:'electron', target:'44.0.0-alpha.1'}` (scratch only,
reverted immediately afterwards) and re-running the same command:

```
  • preparing       moduleName=keccak arch=x64
  • finished        moduleName=keccak arch=x64
  • preparing       moduleName=node-hid arch=x64
  • finished        moduleName=node-hid arch=x64
  • preparing       moduleName=usb arch=x64
  • finished        moduleName=usb arch=x64
  • completed installing native dependencies
real 0m31.233s
```

All three rebuild candidates (`keccak`, `node-hid`, `usb`) resolve cleanly
against ABI 149. Per §1 they are Node-API, so nothing was actually compiled —
`@electron/rebuild` merely needs a number it can look up.

The real fix is a lockfile refresh, not a code change:
`@electron/rebuild@4.1.0` already declares `node-abi: ^4.2.0`, and `node-abi`
**4.33.0 (2026-07-02) added Electron 44**, with 4.35.0 (2026-08-28) current. So
`npm update node-abi` alone moves 4.32.0 → 4.35.0 entirely within the existing
range. **This PR deliberately does not do that** — it is scoped to `electron`
and nothing else, so CI observes the blocker rather than hiding it.

Note the misleading shape of this failure: it names `keccak`, so it reads like
"keccak is incompatible with Electron 44." It is not. `keccak` is simply the
first module in the walk, and it is in the walk at all only because of the
`binding.gyp` misclassification tracked in #204 — the same class of problem
`scripts/better-sqlite3-prebuilds.js` was written to solve for better-sqlite3
in PR #197. Pruning `keccak`'s `binding.gyp` the same way would sidestep this
particular failure, but `node-hid` and `usb` are genuinely native and would hit
`getAbi()` next, so refreshing `node-abi` is the actual fix.

### Check 3 — the build-pipeline check

**PASSES**, once check 2 is unblocked. With the scratch `node-abi` patch in
place, `npm run build -- --linux --x64` (an unpacked `--dir` build) completed:

```
  • executing @electron/rebuild  electronVersion=44.2.0 arch=x64
  • completed installing native dependencies
  • packaging       platform=linux arch=x64 electron=44.2.0 appOutDir=dist/linux-unpacked
  • downloaded      label=electron progress=100%
  • downloaded electron zip extracted successfully
BUILD EXIT=0
real    1m50.662s
```

The artifact runs and reports the new runtime:

```
$ ELECTRON_RUN_AS_NODE=1 ./dist/linux-unpacked/freedom -p "..."
{"electron":"44.2.0","modules":"149","chrome":"152.0.7977.76"}
```

`resources/` contains all four extraResources addon trees (`ant-bin`,
`freedom-ipfs-node`, `myotis-node`, `radicle-bin`), and — confirming breaking
change #3 — the output ships **no `libEGL.so` and no `libGLESv2.so`**.

Not exercised on this host, and still open:

- The **docker** linux pipeline (`npm run dist:linux:{x64,arm64}:docker`), which
  release-process.md §2 check 3 names specifically because `npm ci` inside a
  container can behave differently. Note it will hit the same `node-abi`
  blocker, since it runs a plain `npm ci`.
- **Cross-platform / cross-arch packaging.** Per PR #197's lesson, a same-arch
  build proves little: `@electron/rebuild`'s already-built cache key is
  `${arch}--${ABI}` with no platform component, so a linux-x64 host building
  win-x64 can pass by cache coincidence. The documented mac(arm64)→win(x64)
  release flow is unverified against Electron 44 and needs a real mismatched
  run. `keccak`'s missing arm64 prebuilds (#204) remain the likeliest failure
  there.
- A signed/notarised **macOS** build and the **Windows** NSIS/portable
  packaging.
- **electron-builder has no Electron-44 arch guard on the 26.x line.** The
  fail-fast for Windows-ia32 / Linux-armv7l under Electron 44+
  (`electronArchSupport.ts`) exists only in `app-builder-lib@27.0.0-alpha.*`,
  not in 26.15.3 or 26.16.1. We don't build those arches, so this is
  informational — but if anything ever passes `arch: "all"`, 26.x still expands
  it to include ia32 and will die with an opaque CDN 404 instead of a clear
  message.

---

## 3. Runtime results

| step                                     | result                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` (with the bump)                 | **FAIL** — postinstall, `Could not detect abi for version 44.2.0`. `node_modules` is nonetheless fully populated, so everything below ran. |
| `npm run lint`                           | **PASS** — exit 0, no output.                                                                                                              |
| `npm test` (jest)                        | **PASS** — 198 of 202 suites (4 skipped), 3783 passed / 15 skipped / 3798 total, 65.2s.                                                    |
| `npm run test:e2e` (harness, under xvfb) | **1 failed, 99 passed, 4 skipped** (11.7m).                                                                                                |

The single e2e failure:

```
✘ 3 [harness] › test-e2e/address-bar-clipboard.spec.js:122:3 ›
    address bar chrome context menu ›
    chrome context menu cut, copy, paste, and select all (18.6s)

  Error: Timeout 7500ms exceeded while waiting on the predicate
    at expectRendererClipboard (test-e2e/address-bar-clipboard.spec.js:30:6)
    at test-e2e/address-bar-clipboard.spec.js:163:11
```

**Root cause: Electron API change** (44.0 breaking change #8, the `clipboard`
rearchitecture — see §2 check 1). Line 163 is
`await expectRendererClipboard(window, pasteSample)`, whose predicate calls
`window.electronAPI.readClipboardText()` → `ipcMain.handle('clipboard:read-text')`
→ `{ success: true, text: clipboard.readText() }`, where `readText()` is now a
Promise that cannot cross IPC. Each poll iteration hangs, so the poll expires.

**Not a flake.** Re-run once in isolation, same failure, same line:

```
$ xvfb-run -a npx playwright test --project=harness test-e2e/address-bar-clipboard.spec.js
✓ 1 application menu excludes macOS-only roles (5.8s)
✓ 2 Edit menu exposes clipboard roles (5.4s)
✘ 3 chrome context menu cut, copy, paste, and select all (19.7s)
✓ 4 Control shortcuts copy, cut, and paste in the address bar (6.8s)
1 failed, 3 passed (40.6s)
```

Two details worth recording:

- Test 4 (`Control shortcuts copy, cut, and paste`) **passes**, because native
  accelerator paste never goes through our IPC. Only the custom chrome context
  menu's Paste is broken. A reader of the CI summary could easily conclude
  "clipboard mostly works"; it does not.
- Line 157's `electronApp.evaluate(({ clipboard }) => clipboard.readText())`
  also passes, because Playwright's `evaluate` auto-awaits a returned Promise.
  The test only fails where the value has to cross our own IPC boundary. This
  is a good reminder that a green `evaluate`-based assertion is not evidence
  about the app's real IPC path.

No other failure occurred, so there is nothing else to classify as addon-ABI,
Chromium-behaviour or flake. Notably **zero** failures were addon-ABI related,
consistent with §1.

### What this branch's CI showed

Observed on run `34225923826`, and the split is exactly along whether a job
installs with scripts — **18 pass, 16 fail**:

- **`npm ci --ignore-scripts` → all GREEN** (they never reach the `node-abi`
  blocker, and never download Electron): `test`, `migration-cross-platform`
  (3 OSes), `freedom-ipfs-native-addon` (4 targets), `radicle-addon-load`
  (5 targets), `myotis-addon-load` (5 targets). Per the coverage note in §1,
  these are green on `main` too and carry no Electron-44 signal.
- **plain `npm ci` → all RED at the "Install dependencies" step, before any
  test ran**: `e2e-settings`, `e2e-shortcuts-zoom`, `e2e-address-bar-clipboard`
  (3 OSes), `e2e-profiles` (3 OSes), `e2e-onboarding-identity` (3 OSes),
  `e2e-ant`, `myotis-native-e2e` (3 targets). Identical error on ubuntu, macOS
  and Windows, confirming Blocker 1 is not host-specific:

  ```
  e2e-address-bar-clipboard (ubuntu-latest)  Install dependencies
    > freedom-browser@0.8.5-dev postinstall
    ⨯ Could not detect abi for version 44.2.0 and runtime electron. ... failedTask=installAppDeps
    npm error command sh -c node scripts/better-sqlite3-prebuilds.js && electron-builder install-app-deps
    ##[error]Process completed with exit code 1.
  ```

Consequence worth stating plainly: **CI cannot currently observe the clipboard
regression at all**, because `e2e-address-bar-clipboard` — the one job that
would catch it — dies at `npm ci` first. The clipboard finding in this audit
comes from the local run, which only got that far because a failed `postinstall`
still leaves `node_modules` complete. Once `node-abi` is refreshed, expect that
job to go red for a second, unrelated reason.

---

## 4. Chromium 152: what to smoke test manually

Chromium moves 150 → 152. Checked the full Chrome 151 and 152 release notes and
milestone feature lists for the surfaces this app depends on:
**`<webview>`, custom schemes / `protocol.handle`, CORS on custom schemes, CSP,
`fetch()` on custom schemes, service workers and storage partitioning have no
changes in M151 or M152.** Corroborated on the Electron side — `docs/api/protocol.md`
and `docs/api/webview-tag.md` are byte-identical between tags `v43.6.0` and
`v44.2.0`. That is the good news, and it means `rad:`, `radapi:`, `web3://`,
`dweb` and the injected `window.ethereum` provider are not expected to be
affected structurally.

What _did_ change, and therefore what a manual pass should target per platform
(macOS arm64, Windows x64, Linux x64/arm64):

1. **`-webkit-app-region` is now inherited** (Chromium 152 standardises it as
   `window-drag`). This is **not** in Electron's breaking-changes doc and has
   already broken a shipped Electron app's custom titlebar upstream. We use it
   in four files — `src/renderer/styles/tabs.css:6` sets `drag` on `.title-bar`,
   with explicit `no-drag` on `.tab-bar` (`:39`), `.tab` (`:66`) and the close
   button (`:369`), plus `window-controls.css:9`, `menus.css:9`,
   `private.css:62`. Because every interactive descendant already opts out
   explicitly, we are probably fine, and the harness agrees: `tabs.spec.js`
   ("starts with one tab, can open more, can close them"; "clicking a tab
   activates it") passes on 44.2.0, and the app renders normally (screenshot in
   the PR). **Still smoke test by hand**, because drag-region hit-testing is
   not something a screenshot or a click-based e2e assertion fully covers: on
   each platform, drag the window by the empty title-bar area; confirm tab
   clicks, tab close buttons, the new-tab button, the window controls and the
   private-window chrome all still receive clicks rather than starting a drag.
2. **Permission types expanded.** Chrome 151 split `direct-sockets-private`
   into `local-network` / `loopback-network`; Electron 44's
   `session.setPermissionRequestHandler` docs now enumerate ~20 additional
   types. New permission strings can now reach our handler. Smoke test the
   permission prompt for camera/mic/geolocation/notifications and confirm
   nothing unexpected is auto-denied or auto-granted, especially for a page
   touching localhost (our own bundled nodes are on loopback).
3. **Connection Allowlists ship enabled by default in Chrome 152** — a
   server-supplied response header can restrict which endpoints a document or
   worker may `fetch()`. New way for a remote page to block sub-resource
   fetches. Worth a look on the wallet/dApp surfaces and injected providers if
   anything behaves oddly on a real site.
4. **XSLT deprecated with a stepped-rollout removal in Chrome 152.** Only
   matters if any bundled or commonly-visited page renders XML via a
   stylesheet.
5. **Chrome 151 moved XML parsing to a Rust implementation** (`DOMParser`,
   `XMLHttpRequest.responseXML`, standalone SVG documents). Behaviourally
   equivalent in principle; worth including an SVG-heavy page and an RSS/XML
   page in the pass.
6. **`new FontFaceSet()` now throws `TypeError: Illegal constructor`**
   (Chrome 151 dropped `[LegacyNoInterfaceObject]`). No hits in `src/`, but a
   page-side break to watch for.
7. **macOS only:** Chrome 152 drops `Notification.requireInteraction` on macOS
   and ties the Badging API to notification permission. Electron 44 also
   _restored_ `app.setBadgeCount`/`setProgressBar` on Linux via the LauncherEntry
   D-Bus API (we call neither). Smoke test notifications and any dock badge on
   macOS specifically.
8. **macOS 13+ is now the floor** (both Chromium 151 and Electron 44 dropped
   macOS 12). Any macOS 12 test machine must be retired from the §6 matrix, and
   the release docs' supported-OS statement needs updating.

---

## 5. Go / no-go

**No-go for shipping today. Go for scheduling it as its own release cycle** —
the work is small, fully diagnosed, and blocked on nothing outside this repo.

### Upstream releases needed before the bump can ship

**None.** This is the significant finding. Every addon — `better-sqlite3`,
`keccak`, `freedom-ipfs`, `libradicle`, Myotis, plus `node-hid` and `usb` — is
Node-API and already loads on ABI 149. There is no "blocked by upstream" of the
kind release-process.md §2 warns about and the 0.7.2 cycle hit; that hazard was
retired for good by better-sqlite3's v13 N-API move and by every project-specific
addon being napi-rs / node-addon-api.

The only version floor is **`electron@>=44.2.0`**: 44.1.0 and 44.1.1 abort
`node::ObjectWrap`-derived addons during GC on Node ≥24.19.0, fixed in 44.2.0.
The trial branch declares `^44.2.0` rather than `^44.0.0` for exactly this
reason, so a later lockfile regeneration cannot silently land on 44.1.x.

### Blockers to clear in-repo

| #   | Blocker                                                                                                             | Fix                                                                                                                                                                                             | Size                    |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| B1  | `npm ci` fails: `node-abi@4.32.0` has no Electron 44 entry                                                          | `npm update node-abi` (4.32.0 → 4.35.0, inside `@electron/rebuild`'s existing `^4.2.0` range — lockfile only)                                                                                   | ~15 min                 |
| B2  | `clipboard:read-text` IPC never settles; `clipboard:copy-image` throws; `clipboard:copy-text` reports success early | `await` both text calls; port `writeImage` to `clipboard.write([...])`; update `src/main/ipc-handlers.test.js:1289-1340` to assert the **new** async shapes (the current mocks pass either way) | ~half a day incl. tests |

### Estimated work

Roughly **2–3 days of engineering plus one full manual cross-platform smoke
pass**, spent about as: B1 trivial; B2 half a day; a genuine cross-platform /
cross-arch packaging verification (the mac→win flow PR #197 showed a same-arch
build cannot vouch for, plus the docker linux legs) a day; the §4 manual pass
across macOS/Windows/Linux another day. The dominant cost is verification, not
code.

### Proposed sequence

1. **Land B1 on its own**, as an ordinary in-range lockfile refresh on the
   current Electron 43 (`npm update node-abi`). It is a no-op on 43 and removes
   the blocker from the critical path — after which a re-run of this trial
   branch gets past `npm ci` and CI's full matrix, including the e2e legs,
   actually executes against Electron 44.
2. **Land B2 next, also on Electron 43.** The W3C-shaped `clipboard` API and
   the promise-returning `writeText`/`readText` all exist on 43 too, so the fix
   is forward-and-backward compatible and can be reviewed and tested on the
   current Electron with the e2e suite green on both.
3. **Re-run this trial branch** with 1 and 2 in. Expected: full CI matrix green,
   including `e2e-address-bar-clipboard`.
4. **Verify cross-platform packaging explicitly** before committing: a real
   mac(arm64)→win(x64) `electron-builder` run with a genuine platform _and_
   arch mismatch (not a same-arch build that can pass on `@electron/rebuild`'s
   platform-less `${arch}--${ABI}` cache key), plus both docker linux legs.
   Watch `keccak`'s missing arm64 prebuilds (#204).
5. **Open the real bump as its own release cycle**, headlined like the previous
   Electron majors: `Upgraded Electron 43 to 44 (Chromium 152, Node 24.20)`,
   with the full §6 manual smoke matrix budgeted and the §4 list folded into
   the per-platform checklist. Pin `>=44.2.0`.
6. **Retire any macOS 12 test machine** from the smoke matrix and update the
   supported-OS statement in the release docs.

### Worth doing alongside, but not blocking

- Rename the `freedom-ipfs` release assets away from the `electron41` label —
  it is a build tag, not an ABI, and it invites exactly the wrong conclusion
  during an audit like this one.
- Consider pruning `keccak`'s package-root `binding.gyp` the way
  `scripts/better-sqlite3-prebuilds.js` prunes better-sqlite3's (#204). It
  would not have prevented B1 on its own (`node-hid` and `usb` are genuinely
  native and hit `getAbi()` next) but it removes a dormant, arm64-less,
  transitively-pulled module from every rebuild pass.
- CI's three addon-load matrices verify under plain Node, never under Electron.
  For Node-API addons that is defensible, but an explicit `process.versions.modules`
  assertion somewhere would make the ABI story legible instead of implicit.
