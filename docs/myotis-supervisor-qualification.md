# Finite disposable-host Myotis supervisor qualification

This follow-up harness is **not executed on the primary Mac**. It is intended
for coordinator-managed disposable Linux/macOS hosts with existing Electron 43
and an already installed compiler. It loads no real Myotis addon and makes no
network/provider/blockchain request. It neither downloads software nor launches
the Freedom application. The disposable Mac checkpoint below qualifies only
the recorded finite campaign; the remaining product gates still apply.

## Disposable Mac checkpoint — 2026-09-08

Commit `098149e7155393b1ce719e7e71ad1c6a38c409e3` passed the original eight cases (1–8) below
in one campaign (exit 0, `inputsUnchanged: true`), using the benign JS fixture.
Runtime: Electron 43.0.0, Node 24.17.0, libuv 1.52.1, macOS 15.6 arm64;
compiler: Apple clang 17 with installed SDK 15.5. No primary-Mac runtime test
was performed.

The coordinator retained remote evidence at
`/private/tmp/freedom-myotis-qualification-1plan72i` and verified all 75 text
member hashes in the local `/tmp/freedom-mac-098149e7-evidence.json` export.
The hashes were also checked when recording this checkpoint.

| Artifact | SHA-256 |
| --- | --- |
| Native source | `ca4f72d62ca3b5d4b87078ee12e6f60682ac13589eca4742bbabf164423d684d` |
| Compiled helper | `217f71c48045ad982704a0ba7b72d234328e353fc796f1f09755aec59d6fcfb5` |
| Evidence archive | `a8c4360e06bd506122234495c21809ded8a3a5bdb465af0f57b37ea0645826cf` |

In the parent-controller-loss case, the harness asserted the generation-matched
old retired record before guarded reuse/lock release, but did **not** separately
snapshot that record: only the successor record is retained. The controller's
OS exit was observed; the old supervisor's OS exit was not. Control EOF is the
separate case with full native receipt and observed supervisor OS exit.

Native helper, process, child and harness sources are byte-identical between
`098149e7` and `e662127c`; this is **not** a full `e662127c` runtime pass. The
campaign does not qualify the real addon, Windows, signing/packaging, app Quit,
supervisor loss or the broader matrix below. No rerun was made for this update.

## Disposable Mac checkpoint — c915e138, 2026-09-08

Commit `c915e1384e6f3f3390458d3a168cf2c89b9fd486` passed all nine cases in
one authorized campaign (build exit 0, runner exit 0; no rerun). All 715 tracked
file hashes remained unchanged. Runtime: Electron 43.0.0, Node 24.17.0,
libuv 1.52.1, macOS 15.6 arm64; Apple clang 17 with installed SDK 15.5.
This is the real process wrapper/native supervisor with the benign JS fixture.

Both controller-loss cases retained `old-retired-record.json` before guarded
successor reuse. The isolated group controller's actual OS exit was SIGTERM
with a null exit code. Evidence for each old generation remains **controller
OS exit + generation-matched durable retirement snapshot + guarded reuse/lock
release**; the old supervisor OS exit was unobserved. A retired record does not
establish the old child's exit signal or graceful completion. Successors have
their own native terminal receipts and observed supervisor OS exits.

Retained remote root: `/private/tmp/freedom-myotis-c915-8o0ywmft`. Local report:
`/tmp/freedom-mac-c915e138-reply.md`; decoded export:
`/tmp/freedom-mac-c915e138-evidence.json` (`files[].text`). The coordinator
independently verified all 98 exported member hashes.

| Artifact | SHA-256 |
| --- | --- |
| Native C source | `a56be756bc14a7049f679ead1c0f272d2054ab83be5df91b3e5ec8a83a6a0516` |
| Compiled helper | `027c518fb4fa1c7a65b35cfa88e196ea8c1cfaf89f89f17e5461673f9a5c7f61` |
| Gzip export | `666916084d836bf19006c3a52d6279876f466faa384e0ee4ddee231bcc684bb2` |
| Decoded JSON export | `037f4ca252f55bd614562762204c94ff957a576618e971d5fe6f991c8251c905` |

No primary-Mac runtime test, real addon, actual application Quit, Windows,
signing/packaging or supervisor-loss qualification is claimed. Manager
freshness, UI and routing behavior are outside this narrow runtime campaign.
It does not establish a measured process peak or aggregate resource containment.
The earlier `098149e7` checkpoint remains a separate historical campaign.

## Running on an authorized disposable host

Build the target supervisor from the candidate source using existing tools:

```sh
node scripts/build-myotis-supervisor.js
```

Then run with the installed Electron executable in Node mode, using an absolute
**new, nonexistent** task-owned evidence directory. For a disposable Mac with
the existing Electron dependency tree linked/materialized in this checkout:

```sh
FREEDOM_MYOTIS_DISPOSABLE=1 ELECTRON_RUN_AS_NODE=1 \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/qualify-myotis-supervisor.js --disposable \
  --evidence-dir /private/tmp/freedom-myotis-supervisor-qualification-20260908-01
```

The Linux executable is `node_modules/electron/dist/electron`; use a fresh
`/tmp/freedom-myotis-supervisor-qualification-<run>` path. Never run either command
on the primary Mac. Do not reuse a previous evidence directory or delete it.
The runtime gate checks Electron major 43, Node mode, POSIX, the environment
opt-in and the explicit CLI opt-in. It does not independently attest that a
host is disposable; the coordinator supplies that authority.

## Cases and evidence

Nine sequential cases stop at the first failure. The `c915e138` checkpoint
above covers all nine on disposable macOS; the earlier `098149e7` campaign
covered cases 1–8 without the separate old-record snapshots:

1. Actual fd3 startup/read/status using `MyotisProcess`, the native helper and
   the benign JS addon; graceful exit; a new generation reuses a retired record.
2. Natural fixture exit, with native receipt and supervisor OS exit.
3. Blocked read, caller deadline, retained admission, forced native termination.
4. Blocked status, caller deadline, forced native termination.
5. Blocked graceful stop, forced native termination after the product grace.
6. Direct control EOF, retaining the full native receipt and supervisor OS exit.
7. An explicitly simulated prior active record rejects startup without loading
   the fixture. This is not a concurrent-owner or supervisor-crash experiment.
8. A task-owned controller starts a child, sends its generation, and exits
   itself without calling stop. The outer harness observes **controller OS exit
   + generation-matched native durable retirement + guarded new-generation
   reuse/lock release**. Direct observation of the old supervisor OS exit is
   unavailable. The new generation has full terminal receipt/OS-exit evidence.
   This tests parent-controller loss, not supervisor loss. Current harness source
   persists `old-retired-record.json` before any successor overwrites the native
   record; the historical `098149e7` campaign did not retain that snapshot.
9. A fresh task-owned controller is launched with POSIX `detached: true`, retaining
   IPC and OS-exit observation (no `unref`). libuv requests a new session; its
   macOS spawn path is covered by this campaign. The Linux fork fallback does
   not check the `setsid()` return value and remains separately unqualified.
   Only after generation-bound confirmation from this launcher does the
   controller call `process.kill(0, 'SIGTERM')` on its own current group. Missing
   confirmation expires without signaling; no stored PID/PGID or host-session
   fallback is used. The assertions are **controller OS exit + old generation's
   snapshotted retired record + guarded successor reuse/lock release**. The old
   supervisor OS exit is unobserved. This tests group-signal parent loss, not
   supervisor loss or any stronger exit proof.

The blocking fixture uses one timed native `Atomics.wait` for 15 seconds,
followed immediately by synchronous exit code 78. This does not rely on an
addon/controller event-loop timer callback to end the block. A fixture-expiry
exit is always a failed product cleanup result, never a pass. The helper should
terminate it through owned native authority well before that expiry. No loop,
resource-pressure fixture, real addon or arbitrary PID signal is used. Only
the explicit group-signal controller creates a fresh session; product processes
keep their normal spawn options. The parent-loss controller also has an 18-second self-disposal timer;
it executes no blocking fixture code in its own process.

Each action has a 25-second deadline, followed by bounded owned-control cleanup;
the overall run has a 180-second failure deadline. Cleanup requests product
stop/closes task-owned control pipes only. The overall failure path exits the
harness itself, retaining unknown generations as failures. It never uses
`ChildProcess.kill`, process-name matching or absence scans. The sole
`process.kill` exception is case 9's controller self-group signal with literal
PID argument 0, following its isolated-launch confirmation.
Unknown outcomes are not promoted by a timer, disconnect or fixture expiry.
The coordinator's disposable-host containment remains the outer backstop; its
cleanup must never be counted as product success.

The new evidence directory retains the runtime executable/version, random run
identity, source/helper/fixture SHA-256 hashes, native receipt bytes, actual
supervisor OS exit events, generation identities, bounded fixture events,
per-case results and a summary. PIDs are diagnostic only, never signal authority.
Inputs are hashed again at the end. All files are preserved. A failed run needs
a new evidence directory after coordinated disposition; no auto-clearing of
active records or unverified reuse is attempted.

The harness does not qualify supervisor loss, arbitrary descendants, real
Myotis libuv behavior, Windows, exact-lock dependencies, signed/notarized
packaging, live chain fallback, or actual application Quit. See the separate
[product contract and remaining matrix](myotis-process-isolation.md).

## Windows Node-only campaign (runtime checkpoint below)

The dedicated `myotis-supervisor-windows.yml` workflow runs only on relevant
pushes to `feature/myotis-process-isolation`, or a future manual dispatch. A
reviewed push is necessary while this new workflow is absent from the default
branch. It checks out the exact event SHA and uses runner-preinstalled Windows
x64 Node 22 or 24 and installed MSVC/SDK. There is no `setup-node`, npm install,
Electron/addon download, new action, or tool acquisition. Missing prerequisites
fail the job and retain early evidence. Only existing checkout/upload actions
access GitHub; fixture processes have no network or real-addon work.

The source-built helper runs the real `MyotisProcess` and `myotis-child.js`
against the task-owned benign JS fixture. Nine sequential cases cover fd3
start/read/status and retired reuse; natural exit; blocked read, status and
stop; control EOF; active-record rejection; parent-controller loss and guarded
reuse; and a fixed ABI-handshake rejection before create/start, followed by
verified retirement. Windows does not run the POSIX group-signal case. The
ABI rejection fixture returns 0; successful fixtures return 22. Neither loads
a native Myotis addon.

Commands in an **existing x64 MSVC developer shell on the disposable runner**:

```powershell
node scripts/build-myotis-supervisor.js x64
$env:ELECTRON_RUN_AS_NODE = '1'
$env:FREEDOM_MYOTIS_DISPOSABLE = '1'
$env:FREEDOM_MYOTIS_NODE_QUALIFICATION = '1'
node scripts/qualify-myotis-supervisor.js --disposable --evidence-dir C:\task-owned\new-campaign
```

The evidence directory must be new and its parent must already exist. Each
blocking fixture has a 15-second native timed wait followed by exit 78; idle
fixtures expire after 18 seconds. Expiry is always failure. Case/controller/
campaign deadlines remain 25/20/180 seconds, with bounded owned-control cleanup
and no PID signals. Evidence is retained without deleting files. No fixture,
helper or application is run on the primary Mac.

Normal cases require a generation-matched native terminal receipt, stdout EOF
and observed supervisor OS exit 0. Windows force evidence additionally requires
`forced: true`, child exit code 1 and signal 0; a natural exit 1 cannot pass as
forced cleanup. Controller loss records actual controller OS exit, snapshots
the old generation's durable retired record before reuse, and proves guarded
successor acquisition/exit. The old supervisor OS exit is **not observed** in
that case. Active-record rejection remains quarantine, not proof of child exit.

Successful Windows child startup exercises the mandatory suspended
`CreateProcess` job-list assignment, CRT fd3 inheritance and retained-HANDLE
wait/termination paths. This is not an independent supervisor-crash,
kill-on-job-close or descendant-cleanup test. Job setup failure must fail the
campaign; there is no fallback or automatic clearing of active records.

Artifacts include the event/candidate SHA, runner image/OS, exact Node versions
and executable hash, lockfile/source/fixture/helper hashes, compiler and SDK
identities, native receipt bytes, actual supervisor exit events, durable-record
snapshots and per-case results. Preflight/build/campaign transcripts are
uploaded even on failure. The manifest labels the transport `node-only`;
Electron 43, ASAR, RunAsNode fuses, real ABI22 native teardown, actual app Quit,
and signing remain separate qualification gates. Historical `098149e7` and
`c915e138` Mac results above retain their exact source/runtime attribution;
changes to this harness do not extend those passes.

### Windows partial runtime checkpoint and scoped correction — 2026-09-09

[Run 34338572209](https://github.com/solardev-xyz/freedom-browser/actions/runs/34338572209)
checked out exact `dff65fb8ad22ad59eb4f46fb2ea063785db6ca4d` and compiled the
native helper. The nine-case campaign **failed**: its first eight cases passed,
then `parent-controller-loss` failed with `Native durable retirement not
observed`. Inputs were unchanged. No wait or pass criterion is being relaxed.
The earlier run `34337971585` failed workflow validation before any job ran.

Runtime: preinstalled Node 22.23.2 / libuv 1.51.0, Windows x64, runner image
`win25-vs2026` version `20260824.214.3`, OS `10.0.26100.0`. Helper SHA256:
`4b4b5739762a2c726ae7fc6d7d953b22701f5cebb6b50dcb318bc2988072c922`.
The downloaded helper hash was independently checked without execution.
Evidence is retained at
`/private/tmp/freedom-windows-dff65fb8-evidence-20260909`; the controller-ready
record and fixture init/create/start/stop events establish that its runtime
opt-in and fd3 startup succeeded. The old supervisor exit was not observed;
the failed wait alone does not prove how it died. The upload omitted hidden
owner files, and the old harness did not persist controller exit before that
wait failed. These omissions prevent stronger reconstruction of this attempt.

[Exact Node 22.23.2 libuv source](https://raw.githubusercontent.com/nodejs/node/v22.23.2/deps/uv/src/win/process.c)
creates a kill-on-parent-exit job and assigns non-detached spawned children to
it (lines 65–91 and 1016–1034). That provides a source-backed explanation for
controller loss killing the supervisor before retirement, consistent with the
observed failure; it is an inference, not a captured supervisor exit result.
The correction sets `detached: true` **only on Windows product supervisor
spawn**, retaining control/report/IPC pipes and exit observation. There is no
`unref`, new signaling, native C change, POSIX detachment or record clearing.
The supervisor's own mandatory child JobList and retained-HANDLE contract stay
unchanged. The original finite parent-loss case remains the runtime check.

The same libuv code creates detached processes suspended and then resumes
them (lines 988–1040). Parent death between those operations can strand an
unexecuted supervisor. No addon child or active owner record exists at that
stage, but this correction does **not** establish complete startup cleanup or
resource containment. It does not request general ancestor-job breakaway or
promise survival of unrelated job termination. After supervisor execution,
its existing control-EOF checks and native ownership rules still apply.

The harness now persists `controller-exit.json` immediately after observed
controller OS exit, before assertions and the unchanged retirement wait. Any
case failure writes `owner-record-on-failure.json` before cleanup, using a
single descriptor read capped at 97 bytes to detect the 96-byte record bound;
missing/unreadable/oversized records are explicit, never cleared. Upload includes
hidden files **only within the task-owned evidence root**, preserving actual
owner records as well as bounded plaintext failure snapshots. Subsequent
retirement cannot reclassify a timed-out case as passed. The partial run above
does not qualify this correction, Electron, a real addon, actual app Quit,
signing or supervisor-crash cleanup; the subsequent campaign is recorded below.


### Windows Node-only pass — fa14433f, 2026-09-09

[Run 34339755062](https://github.com/solardev-xyz/freedom-browser/actions/runs/34339755062)
checked out exact `fa14433f933ce3e1bf8eeaab6c5acc5209f7dc47`. One finite campaign
passed **9/9 cases**, with `inputsUnchanged: true` and no reported unconfirmed
generations; all job steps succeeded.
This qualifies the listed supervisor cases under **Node 22.23.2 / libuv 1.51.0
on Windows x64**, using the benign JS addon fixture. It does not turn the earlier
failed `dff65fb8` attempt into a pass.

Runner: `win25-vs2026`, image `20260907.229.1`, OS `10.0.26100.0`; installed
MSVC tools `14.51.36231` (`cl.exe` version `14.51.36256.0`) and SDK
`10.0.26100.0`. No npm install, Electron/addon download or tool acquisition was
used. The source-built helper SHA256 is
`8f1139568990a618f2598c0c41f0df3e67adf2b27623373be2d1b54efb26f414`.
The runner-recorded Node executable SHA256 is
`0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4`.

Read-only inspection of retained evidence at
`/private/tmp/freedom-windows-fa14433f-evidence-20260909` matched the helper bytes
to their manifest hash and all six source/lock inputs to exact `fa14433f` Git
content with Windows CRLF checkout conversion. The Node hash agrees between
manifest and build transcript; the Node executable was not uploaded and was
not independently rehashed locally. The coordinator independently verified the
nine-case results, controller/record/reuse evidence and helper/source hashes;
the retained local file inventory is
`/private/tmp/freedom-windows-fa14433f-local-inventory.json`. These are provenance
checks, not fresh execution or an exact-lock Electron qualification.

The ordinary terminal cases retain generation-matched native receipts and
actual supervisor OS exit 0; forced cases include explicit force evidence and
child exit 1 / signal 0. Active-record rejection remains a rejected start,
not a terminal child proof. For parent-controller loss, `controller-exit.json`
records controller OS exit 0 / signal null; `old-retired-record.json` preserves
the matching old generation before a distinct successor acquires the directory.
The successor has its own receipt, observed supervisor exit and retired record.
The **old supervisor OS exit is still unobserved**. Hidden native owner records
are included in this upload.

This is fd3/CRT, post-launch control EOF, retained-HANDLE termination, mandatory
child job-assignment path, retirement and guarded-reuse evidence under the
recorded Node runtime. It is not Electron transport, real native-addon/ABI22
teardown, actual app Quit, job-crash/supervisor-loss or descendant cleanup,
all-startup containment, ancestor-job escape, ASAR, fuse or signing qualification.
The detached pre-resume residual above remains accepted and unqualified.
No runtime fixture or application ran on the primary Mac; no tests were rerun
for this documentation checkpoint.

### Standalone Mac real-addon and native Quit checkpoint — 2026-09-09

The coordinator independently verified a **scoped pass** for
`run-d30_uxul`: real-addon load/start, cached status, one native-error read and
actual native Menu Quit. This ran standalone app commit
`3ff2c3fc75f5007848c03f9b7cacb49ec60d06a0`, tree
`9709e52bbe7f20658db97430c0f7413c5dc89a73`, with source-only driver
`3d1e2ec18b83f998d8cc3084a1ed3da544040375`. It is not a runtime test of the
latest full PR head or the combined Agent/Myotis integration branch.

Pinned inputs (SHA256):

| Input | Hash |
| --- | --- |
| Driver | `695a2e7d5c588efd8ed6210bfcf402faa07ca74c098773b876655cdb7d22ad35` |
| Existing v0.1.7 / ABI22 Mac addon | `1b297652775793a028337c0a62508c62a93aa5650449afcc77e7f765a6462eda` |
| Native supervisor | `027c518fb4fa1c7a65b35cfa88e196ea8c1cfaf89f89f17e5461673f9a5c7f61` |
| Electron executable | `692ff0f6fbd10819a2bda2dfb9a976de520e03c909559d8541ab2b04caaeaaa5` |

Runtime was installed Electron 43.0.0 / Node 24.17.0 / libuv 1.52.1 on disposable
macOS arm64, in normal app mode with a fresh seeded profile and an
unavailable-only `safeStorage` test substitution. It did not exercise the real
keychain. Electron differs from lock 43.6.0; reused donor dependencies also
differ (including `ws` 8.21.0 versus 8.21.3 and `better-sqlite3` 12.11.1 versus
13.0.3). This is not an exact-lock or packaged-runtime pass.

The driver observed off before Start, one successful Start, four cached-status
samples over 1.5 seconds and exactly one zero-address `getAccount` result:
`native-error`, `verifiedFlag: false`, `hasReason: false`. No detailed native
reason or verified data was retained. Immediately before Quit, the chain was
running, `SYNCING`, at current period 0 / target 1852 with zero peers and zero
snap peers. `elReaderAvailable: true` in a cached sample establishes neither
SYNCED readiness nor an occupied native read at shutdown. The driver did not
query ABI directly; acceptance rests on the pinned child's exact ABI22 gate
and the successful real started result.

One shared `Menu.sendActionToFirstResponder('terminate:')` request was recorded
before the action, with a returned marker and no fallback. The outer original
kernel observations show browser **B**, inspector bridge **D**, supervisor
**S** and addon child **C** each exiting with code 0. B/D signal authority was
retired before their sole reaps, both status 0. Inspector detachment/EOF and log
messages were not used as exit proof. One framework helper **F** exited by
SIGTERM 15 during app/framework teardown; the other recorded F exits were 0.
Do not describe every framework process as exiting zero.

For generation `8b614411-4ca1-4966-a2b4-63677dd1119a`, actual `MyotisProcess`
sanitized lifecycle evidence reports `classification: verified`, `receipt:
reaped`, supervisor code 0, child exit 0 / signal 0 and `forced: false`, matching
the durable retired record. Raw native receipt-pipe bytes were **not**
intercepted. This product evidence is distinct from the independently observed
original S/C kernel exits.

The final campaign ran once, runner exit 0, in 2.113445 seconds from browser
launch intent to final result; the driver phase was 1,695 ms. No errors,
emergencies, unknown/unconfirmed instances or outer-harness **W** process
signals were reported. Ten observed instances / peak ten are sampled counts,
not a containment bound or a complete historical process count. All 715
candidate source files and modes and the operational/input/runtime pins were
verified before/after; only approved harness activation fields changed.

Three earlier harness attempts remain preserved **failures**:

- `run-anb18681`: invalid `require.main` entry proof before Myotis;
  original-owner emergency B/D SIGKILL.
- `run-vf1654xn`: deferred `require` undefined and a known framework recheck
  race; fallback Quit, B/D exit 0, no emergency.
- `run-jgss5ca8`: pre-exec child image misclassified, startup interrupted and
  no read; fallback Quit, native retirement and B/D exit 0.

The final run followed source-reviewed harness corrections to cached-module
entry proof, capture, bounded original-event/exec observation and inspector
detachment. There was no product fix or unrecorded retry. Prior local reviews
remain at `/private/tmp/mac-first-failure-review`,
`/private/tmp/mac-second-failure-review` and
`/private/tmp/mac-third-failure-review`.

Final raw originals remain remotely under
`/private/tmp/freedom-pr295-entryproof-bk43igo_/evidence/run-d30_uxul`; local
review copies and the coordinator's `ROOT-VERIFICATION.json` are under
`/private/tmp/mac-final-pass-review`. All 21 exported representations were
hash-verified locally; transformed copies are explicitly labeled and retain
original hashes/sizes. The retained `/private/tmp/mac-final-pass.json.gz`
archive SHA256 is
`b9473cbc9a01007e71b62882d8fe72e85655c9b998354af18f65ad4ad03d05f3`;
its 315,202-byte decoded export SHA256 is
`b9f07229824da6e479f151ab21b254ac59acfd71e35fb514468df790ee5fa069`.

This completes the agreed targeted standalone Mac check for external review
with the disclosed scope. It establishes no verified read, SYNCED state,
occupied-native-request shutdown, real keychain/provider behavior, release or
signing qualification, descendant guarantee or resource containment. Historical
fake-addon campaigns and Windows Node-only evidence keep their own attribution.
No tests, runtime, acquisition or product changes accompanied this documentation
checkpoint; no app/native fixture ran on the primary Mac.
