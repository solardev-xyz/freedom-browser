# Agent + Myotis test integration

This test branch combines Agent head `ae668a24` (main `584f7e08` merged at
`e8012fa0`) with exact isolation `3ff2c3fc75f5007848c03f9b7cacb49ec60d06a0`.
The separate merge commit is `99177c068f7a5d161187c4e183193d12b4de07f7`.
The original Agent branch and isolation PR #295 remain independent and unchanged
by this integration work. This is not a release or qualification completion.

## Patched native source and local activation

`config/myotis-integration.json` pins source
`02a183d86474a263cf8e85e5c2c2399672645535`, exact ABI **25**, and
`rust/Cargo.lock` SHA-256
`1f0c580d933559bc5f66e60613d53053fe1528c0b1e2dc2b0981295419d25961`.
Only these already-built debug Node addons are configured:

| Target | Exact bytes | SHA-256 |
| --- | ---: | --- |
| Linux x64 | 280699328 | `b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792` |
| macOS arm64 | 51290696 | `9c93d1209fb981eda50b85df2cc9381be91c85aeefb2171e3412baa87b6e3fc5` |

The Mac compile/link-only evidence is retained at
`/private/tmp/myotis-mac-arm64-debug-02a183d8-20260909.DdZzko/PROVENANCE.md`:
Cargo/rustc 1.94.1, Apple clang 17, SDK 15.4, offline locked native-host debug
build with two jobs. The artifact is ARM64 Mach-O DYLIB with Node registration
exports; its code-signature load command is not notarization or runtime evidence.
The evidence manifest hash is
`e144c687e2b768cf3d9031766a13418ef91bd00c4d6c7203d00f3db249a73a01`.
Debug unwind behavior differs from release panic-abort. Neither artifact was
loaded or activated during this source adaptation.

After immutable review, the coordinator can activate the retained local Mac file:

```sh
npm run myotis:activate -- --target darwin-arm64 --file /private/tmp/myotis-mac-arm64-debug-02a183d8-20260909.DdZzko/myotis-node.darwin-arm64.node
```

On the authorized Linux host, use the same command with `--target linux-x64`
and the absolute path to its already-present exact pinned addon. The command
never downloads, builds or loads native code. It streams verification/copy in
64 KiB chunks from one opened regular-file descriptor, enforces the exact byte
size and a 1 GiB ceiling, and creates `myotis-bin/<os>-<arch>/myotis-node.node`
and `myotis-artifact.json` exclusively. Existing files are never overwritten or
deleted; an interrupted/invalid copy has no trusted manifest and fails closed.
Do not clear such output automatically; preserve it for coordinator disposition.

Packaging preflight and child-before-load check the same bounded manifest,
source/lock/target/ABI/hash pin. Main's status path only does cheap discovery,
not binary hashing. Unconfigured targets (including Windows and Mac x64) need a
separately reviewed exact artifact pin; there is no old-addon or release-download
fallback. `myotis:download` explicitly refuses in this test branch.

Verification is provenance consistency, not adversarial immutable loader
ownership: the trusted local pathname can change between verification and native
loading. These pins cover the exact supplied debug bytes. Signing may change
addon bytes; a signed packaged addon needs a separately reviewed artifact/hash
policy. Neither signer rewrites this pin to bless changed bytes. No signed
package or production readiness is claimed.

## ABI and lifecycle adaptation

One actual asynchronous read/broadcast is forwarded per handle, below the native
four-outstanding-per-handle limit. Sixteen parent requests may queue. Their
10-second caller deadline drops unsent work or rejects the active caller while
retaining its native admission slot and identity. A late native reply releases
only that slot and is discarded for its expired caller. No individual native
cancel API is claimed. A separate fixed 100-second native watchdog is a **host
availability policy**, not proof that native work cannot overrun its 90-second
budget; expiry initiates owned shutdown, retaining admission until actual
completion or native terminal receipt plus observed supervisor exit.

Status has its independent single slot, six-second freshness and ten-second
hard health deadline. Serving requires fresh own-generation `running === true`,
`paused !== true`, `beaconState === "SYNCED"`, `elReaderAvailable === true`,
`elHunting === false` and `snapPeers > 0`. Bootstrapped/start success alone is
insufficient. No stale-anchor acceptance or weak-subjectivity widening is called.
Optimistic, execution and finalized block numbers remain distinct, with
`wsBoundPeriods` and synchronization periods retained. Status identifies the
integration source commit and ABI instead of claiming released v0.1.7.

The existing `gasLimit` consumer mismatch is repaired to numeric `gas` (already
present in ABI 22). Verified call/estimate reverts preserve `dataHex` as JSON-RPC
code 3 and do not try another source. Both `{error}` and
`{status:"unavailable",reason}` read outcomes may use configured read fallback.
A timed-out/lost/failed started broadcast is uncertain; no automatic retry or
replacement transaction is authorized. Unsent queue expiry is distinct. Only
actual Node exports are required; C/UniFFI-only log APIs are not assumed.

Both supervisors retain their original ownership/receipt/quarantine contracts.
The composed prestart prepares both helpers only on macOS; Linux/Windows use
the explicit helper build command. The composed beforePack remains strict per
packaging target. Signing seals
the workspace helper and its manifest first, preserves its ignore/hash/team
checks, then applies Myotis-only empty entitlements through the normal builder
signer/retries. Both resource sets and empty-entitlement files remain separate.

## Evidence limits and next gates

Only lint and finite mocked tests ran for this adaptation. The read-only donor
link has Jest 30.4.2 / babel-jest 30.4.1 instead of lock 30.5.1, and Electron
43.0.0 instead of lock 43.6.0 (builder 26.15.3 matches). These checks are
provisional. The existing merge CI's 14 failures in three workspace suites were
reported identical before this Myotis merge; this task neither fixes them nor
claims a historical green uplift. Exact-lock runtime prerequisites remain
missing on inventoried hosts; no acquisition is authorized.

The inherited `qualify-myotis-supervisor.js` and benign addon are **historical,
unmodified isolation fixtures**, incompatible with this integration's ABI 25
artifact/method handshake and soft-read deadlines. The old 8/9-case results
remain attributed to their original commits; they do not qualify this branch.
Do not run that harness as current integration evidence. Any integration runtime
harness is a separately reviewed follow-up with fresh authorization and bounds.

Pending: coordinator local activation and hash verification, exact runtime
prerequisites, child ABI/method handshake, real patched-addon read/status/stop,
actual app Quit, supported Windows artifacts/HANDLE/CRT/job behavior, signed
macOS/ASAR/RunAsNode packaging and integration workflow qualification. No app,
addon, E2E, blocked/fatal or native runtime fixture ran on the primary Mac.
