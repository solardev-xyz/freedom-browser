# Agent + Myotis test integration

This test branch combines Agent head `ae668a24` (main `584f7e08` merged at
`e8012fa0`) with exact isolation `3ff2c3fc75f5007848c03f9b7cacb49ec60d06a0`.
The separate merge commit is `99177c068f7a5d161187c4e183193d12b4de07f7`.
The original Agent branch and isolation PR #295 remain independent and unchanged
by this integration work. This is not a release or qualification completion.

## Patched native source and local activation

`config/myotis-integration.json` pins checkpoint-refresh source
`a416cb0ffe779cc85d6124883a809638f013163e` (the reliability candidate
`02a183d8` plus the two checkpoint updates), exact ABI **25**, and unchanged
`rust/Cargo.lock` SHA-256
`1f0c580d933559bc5f66e60613d53053fe1528c0b1e2dc2b0981295419d25961`.
The currently configured debug addon is:

| Target | Exact bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 51294792 | `8f0cb38605b633491a182e8d1b7655d83e02a0c5a11a7c6aa11dd7d1d5654d77` |

The compile/link-only evidence is retained at
`/private/tmp/myotis-checkpoint-native-evidence-20260909.3KRDLe/PROVENANCE.md`:
Cargo/rustc 1.94.1, Apple clang 17, SDK 15.4, offline locked native-host debug
build with two jobs. Its evidence-manifest SHA-256 is
`8d8ec09bde1f30e7a354d5ab46684d0c7149023238c53381c08a9903e7698ce1`.
The artifact is ARM64 Mach-O DYLIB with Node registration exports. Debug unwind
behavior differs from release panic-abort; static inspection is not runtime or
notarization evidence.

For a fresh checkout, activate the retained local Mac file with:

```sh
npm run myotis:activate -- --target darwin-arm64 --file /private/tmp/myotis-checkpoint-native-evidence-20260909.3KRDLe/myotis-node.darwin-arm64.node
```

The earlier Linux x64 artifact (source `02a183d8`, 280699328 bytes, SHA-256
`b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792`)
is retained as historical evidence. Linux is now unconfigured until an artifact
is built from the refreshed source; the old binary is not relabeled with the new
commit. Windows and Mac x64 also remain unconfigured.

Activation never downloads, builds or loads native code. It streams verification
and copy in 64 KiB chunks from one opened regular-file descriptor, enforces the
exact byte size and a 1 GiB ceiling, and creates
`myotis-bin/<os>-<arch>/myotis-node.node` and `myotis-artifact.json` exclusively.
Existing files are never overwritten or deleted. To refresh this local checkout,
the coordinator preserved both previous files outside the checkout before
activation. An interrupted/invalid copy has no trusted manifest and fails closed;
do not clear such output automatically.

Packaging preflight and child-before-load check the same bounded manifest,
source/lock/target/ABI/hash pin. Main's status path only does cheap discovery,
not binary hashing. Unconfigured targets need a separately reviewed exact artifact
pin; there is no old-addon or release-download fallback. `myotis:download`
explicitly refuses in this test branch.

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

At the initial source-adaptation checkpoint, only lint and finite mocked tests
ran. The then-used read-only donor link had Jest 30.4.2 / babel-jest 30.4.1 instead of lock 30.5.1, and Electron
43.0.0 instead of lock 43.6.0 (builder 26.15.3 matches). Those checks were
provisional. The later prepared-checkout section records exact-dependency checks. The existing merge CI's 14 failures in three workspace suites were
reported identical before this Myotis merge; this task neither fixes them nor
claims a historical green uplift. Exact-lock runtime prerequisites were then missing on inventoried hosts; later
user-approved acquisition prepared the primary Mac checkout as recorded below.

The inherited `qualify-myotis-supervisor.js` and benign addon are **historical,
unmodified isolation fixtures**, incompatible with this integration's ABI 25
artifact/method handshake and soft-read deadlines. The old 8/9-case results
remain attributed to their original commits; they do not qualify this branch.
Do not run that harness as current integration evidence. Any integration runtime
harness is a separately reviewed follow-up with fresh authorization and bounds.

Runtime gates include real patched-addon read/status/stop,
actual app Quit, supported Windows artifacts/HANDLE/CRT/job behavior, signed
macOS/ASAR/RunAsNode packaging and integration workflow qualification. No automated app, addon, E2E, blocked/fatal or native runtime fixture was run
on the primary Mac by the coordinator. Later user smoke observations are recorded below.

## Local activation checkpoint — 2026-09-09

The coordinator activated the macOS arm64 addon in the separate integration
checkout at exact source candidate `5483e051fcbca5057a6f968a1436bc7086f3e554`
using `node scripts/activate-myotis-local.js` with the then-pinned `02a183d8`
artifact retained under `/private/tmp/myotis-mac-arm64-debug-02a183d8-20260909.DdZzko/`.
Activation exited 0; an independent `verifyArtifact`
read confirmed the source, lock, ABI, target, exact 51290696 bytes and pinned
`9c93d1209fb981eda50b85df2cc9381be91c85aeefb2171e3412baa87b6e3fc5` hash.
The binary and manifest are ignored local files, not committed Git artifacts.
This was copying and hashing only, with no addon load or app launch.

Both disposable-host inventories found Electron 43.0.0, with no installed
43.6.0 identified. Their existing dependency trees therefore do not establish
an exact-lock integration runtime. Retained inventory replies are
`/private/tmp/freedom-integration-mac-inventory-reply-20260909.md` and
`/private/tmp/freedom-integration-linux-inventory-reply-20260909.md`.
The Linux addon was rehashed successfully at its previously recorded path.

The original Agent checkout stayed clean at `ae668a24`; its installed v0.1.7
addon still hashes to
`1b297652775793a028337c0a62508c62a93aa5650449afcc77e7f765a6462eda`.
The isolation and Myotis PR branches were not changed. Future runtime runs
should use a fresh, task-owned `--profile-dir` on a designated disposable host.

Manual source-only review of `99177c06..5483e051` found no concrete blocker and
confirmed the non-macOS prestart regression was fixed. The review executed no
project code. Implementation validation reported eight focused suites / 123
passing tests, then two overlapping process/platform suites / 20 passing tests
after the startup correction, with lint passing. The dependency mismatch above
still applies. Review record: `scratchpad/merge-99177c06-review.md` in the
existing reviewer session.

## Prepared local smoke checkout — 2026-09-09

After the user approved the exact npm/Electron and bundled-release sources, the
coordinator finished preparing this checkout for a manual macOS arm64 smoke test:

- An independent `node_modules` was installed with `npm ci --ignore-scripts`
  from the unchanged lock (`48f6528976c3c05e52339e90f636c3b0013c35d1bef5c300c8ae80894a705d1d`).
  All 1157 installed lock entries match their declared versions. The prior donor
  symlink was preserved outside the checkout; the donor was not changed.
- Electron **43.6.0** was extracted from the approved official arm64 archive,
  matching both the npm package's checksum and official `SHASUMS256.txt`:
  `5183a2b15d013517386edd9f1ea8e3402755f6c3ea17893f92acb20052f3a2e7`.
  Its bundle version and enabled RunAsNode fuse were checked without launching it.
- Ant **0.5.44**, freedom-ipfs **0.4.3**, and libradicle **0.7.1** were installed
  only after the repository's pinned archive/checksum-manifest checks passed.
  The patched Myotis addon at this checkpoint was the `02a183d8` artifact. Both supervisor helpers
  were built from local source with the installed Apple compiler.
- The existing node-hid **2.1.2** arm64 N-API binding was copied from the original
  checkout after matching package versions and loader bytes; its SHA-256 is
  `9ccf39dddd2baffcd1340d74b0dbeeaed9072c39c3aef9f63b6ea6b410690dd4`.
  Existing adblock data was copied after checking its manifest hashes. Native
  prebuilds supplied by the locked packages are present; unneeded install hooks
  and blanket native rebuilds were not run. Tor remains optional and absent.

Validation with this dependency tree: **13 focused suites / 207 tests passed**,
lint passed, and `node scripts/check-binaries.js --mac --arm64` passed. This
replaces the earlier donor-version limitation for these local checks only.
Evidence, complete acquisition URLs/integrities, archives, local reuse hashes,
and logs are retained at `/private/tmp/freedom-integration-smoke-prep-20260909/`.
Six pre-existing lock entries lacked integrity fields; their downloaded tarball
cache integrity records and verified cached bytes are retained in that evidence
without changing the lock.

The stock Electron archive has linker/ad-hoc signatures and no bundle resource
seal; strict bundle codesign verification does not pass, just as for the original
43.0.0 development runtime. No signatures or system security settings were changed.
This is an unpacked development checkout, not signed-package qualification.

The user can launch with a separate fresh profile:

```sh
cd /Users/florian/Git/freedom-dev/freedom-myotis-integration
npm start -- --profile-dir /private/tmp/freedom-myotis-smoke-20260909
```

Enable Myotis for the desired chain in the Nodes controls before testing the
agent, so the test exercises the patched path. A fresh profile may require model
provider setup/sign-in. No credentials or profile data were copied. The coordinator
did not launch Electron/Freedom, start a node, or run a real-addon lifecycle or
Quit fixture on the primary Mac. Actual startup, model workflow and Quit behavior are established by manual smoke
evidence only where explicitly recorded below; disposable qualification remains open.


## Fresh checkpoint correction — 2026-09-09

The user's first manual launch showed **Stale anchor** for both chains, with
zero peers/blocks. The initial `02a183d8` addon embedded August 20 checkpoints,
which exceeded ABI 25's default age bounds on September 9. That launch did not
establish working Myotis sync or a model workflow using verified reads.

The replacement source `a416cb0f` updates only the mainnet/Gnosis checkpoint
regions in Java, Rust and their existing parity assertions, plus provenance docs:

| Chain | Finalized slot | Period | Canonical block root |
| --- | ---: | ---: | --- |
| Ethereum | 15176160 | 1852 | `db3103e254917f717261c1afced9d8c46200125000a27f58419cd5b8ac863a31` |
| Gnosis | 29989088 | 3660 | `b8e6abc95beb93a5c8ccf3b92171edd5a5ca2f99a1c588b1a2519488f04910d4` |

Finalized discovery and canonical block-root queries agreed across three
mainnet operators and two Gnosis operators. The two gnosischain.com endpoints
count as one operator. No JDK/Gradle was installed: local Python validation and
source rendering followed the existing `refreshOneCheckpoint` algorithm and
three-region templates, without acquiring software. Public bootstrap responses
were also available and their BeaconBlockHeader SSZ hashes matched the selected
roots. This proves HTTP data availability/header consistency, not Myotis p2p
bootstrap, committee-proof validation or continuous update availability.

All five finite Rust parity/config/age-gate checks passed. Parent-only manual
source review found no blocker; ABI, lock, Sepolia and weak-subjectivity rules
are unchanged. The source is retained on test-only branch
`test/checkpoint-refresh-20260909` in
`/private/tmp/myotis-checkpoint-refresh-20260909`; neither reliability PR changed.
The Mac build was copied through the existing activation gate and independently
reverified. Previous local addon/manifest files are preserved at
`/private/tmp/freedom-myotis-checkpoint-replaced-20260909-t5r0ijkl/`.
Activation evidence: `/private/tmp/freedom-checkpoint-activation-20260909.json`.
All 41 native evidence file hashes were independently verified. Integration
checks with the prepared locked dependencies passed **7 focused suites / 70
tests**, lint, and macOS binary preflight. Logs are retained at
`/private/tmp/freedom-checkpoint-refresh-tests-20260909.log` and
`/private/tmp/freedom-checkpoint-refresh-lint-20260909.log`.

With no newer persisted snapshot, these anchors first age out at **September 10,
20:06:20 UTC for Gnosis** and **September 24, 14:14:47 UTC for Ethereum**.
A node that keeps syncing may have a newer persisted anchor. The refresh does
not bypass the age guard or make static checkpoints permanently usable.

Quit and relaunch the same checkout/profile using the command above. The Nodes
version should now show **a416cb0f (ABI 25)**. The profile and all ownership
records were left intact; no node, app, native lifecycle or Quit fixture was
launched by the coordinator. Successful sync, agent reads and actual Quit remain
for the user's smoke test and subsequent disposable qualification.


## User-reported combined smoke acceptance — 2026-09-09

After the checkpoint refresh, the user reported a long-running coding agent
session with many tool calls and no OpenAI connection disruptions, followed by
Cmd+Q without a shutdown hang or hiccup. The prepared checkout at this report
was `f1c10d8db94c50022ceea63b3dde1aca27596b3f`, using the pinned `a416cb0f`
Mac arm64 debug addon described above. This is acceptance reported by the user;
no automated run manifest or native stack capture was collected for that session.
Myotis sync/peer state and actual occupied native requests during the session
were not confirmed in the report.

This supports the combined workflow's two user-visible outcomes. It does not
independently qualify either standalone PR, every native cancellation path or
Windows behavior. Targeted follow-up work is underway: an unmodified-addon
load/ownership check, deterministic native scheduler tests on disposable Linux,
standalone Freedom startup/read classification/native Quit on the disposable
Mac, and supervisor runtime tests on GitHub's Windows runner. Test-only scheduler
fixtures must be identified separately from production-addon reader/network
evidence. Packaged signing and loading remain release qualification work.
