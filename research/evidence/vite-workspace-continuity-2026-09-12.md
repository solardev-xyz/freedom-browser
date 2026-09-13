# Real Vite workspace continuity — qualification in progress

The production workflow has reached sandboxed Vite startup, real same-document
HMR in a polling-control fixture, explicit Stop, old socket-key refusal and
SQLite close/reopen. **The complete restart/reattachment flow is not yet
qualified:** the polling run stopped on an auxiliary-probe observer ambiguity
before its second launch. Earlier default-FSEvents runs missed the file edit.
A later run with the product environment defaults and independent client
event-ordering fix still missed the edit. Explicit project polling configuration
is required for the next plugin-free qualification; environment hints alone are
not a demonstrated fix.

## Candidate and environment

The first nine runs used public feature commit
`c586ab2bcbff4207e8a2e7e08b703fa96d9d66f4`, tree
`84d6a347e5feb33d0dbf2fef7347319339fc7353`, with separately pinned test harness
files. The tenth adds the two production files and their two tests from
`1b7bab2b91f7401194240923b2ab723b45f74398`, described below. This derivative is
not a full-head checkout. The Freedom dependency lock remains unchanged.

The user approved Vite **8.3.0** and its dependencies in a new task-only
directory, with install scripts disabled. Its lock SHA-256 is
`13dbc0de19e15eab64f089a32e824519142f1349f1c5d92e210c7df1c4a21f79`.
The fixed vanilla fixture uses port 41937, native config loading, no plugins and
no optimizer discovery. Approved dependency bytes are copied into each new
managed workspace, with file hashes and symlink targets verified.

Actual runtime: Electron 43.0.0 / embedded Node 24.17.0, standalone Node 22.22.0,
ws 8.21.0 and better-sqlite3 12.11.1. Candidate lock versions are Electron
44.3.0, ws 8.21.3 and better-sqlite3 13.0.3. These donor differences exclude
exact-lock and packaged-release claims. The existing macOS supervisor hash is
`f7cb7da6b40562def145bee3576567403225fb99ae8d56a488d2ecf22b176671`;
its production C hash is
`01d67c27e99220ebb37e3d1e07e962703ceab10b832cadd053abc7fd0b458cce`.

Composition uses real SQLite, workspace/controller/process/server services,
Seatbelt and a sandboxed BrowserWindow with the production preview protocol.
Tool choices and permission approval are scripted; no model/provider or full
application index is loaded. Storage-retention seams preserve task-owned
files after cleanup or setup failure. They do not substitute execution,
permissions or receipts. SQLite reopen, if reached, is within one app process,
not an application restart.

The independent original-process observer retains its existing authority and
requires actual exits. Command cancellation, native root receipts, original
kernel events and sole direct reaps are distinct evidence. Campaign limits
remain 45 seconds for the scenario, 10 for teardown, 60 for failure-only expiry,
65 for exit observation and 70 overall. Every retry uses fresh task-owned
profile/evidence and a new one-use authorization. None of these fixtures runs
on the primary development Mac.

## Retained failures

| Run | Result and first cause | Workflow reached |
| --- | --- | --- |
| `run-r2trxr3k` | Driver incorrectly treated the permission API response wrapper as the prepared grant | Real SQLite and enabled workspace; no Vite launch |
| `run-g95jyfra` | Observer confused native policy ceiling (1,800,000 ms) with the separate requested command timeout (40,000 ms) | Grant and supervisor launch; command not released |
| `run-8n8mb5es` | Observer did not recognize the installed CLT `otool` → `llvm-otool` image/argv mapping | Grant and tool probe; no Vite launch |
| `run-gkyp1tr2` | Six-second DOM-update condition expired after successful production file edit | Real Vite, preview, HMR subprotocol and file edit |
| `run-e27nmkug` | Same DOM deadline; connected frame delivered to browser, no upstream update observed | Real Vite connection, unchanged document and successful edit |
| `run-xqual8xm` | Observer rejected a short-lived `otool` probe after its parent request completed | Workspace/grant only; Vite and watcher plugin never launched |
| `run-a0la0gqf` | FSEvents watcher ready and target registered, but no target notification after edit | Instrumented Vite/preview/edit; HMR deadline failed |
| `run-d8cr16br` | Repeated same-target probe requests made observer class matching ambiguous before second launch | Polling-control HMR, Stop, old key refusal and SQLite reopen passed |
| `run-gs186938` | Observer did not recognize the pinned `/bin/bash` image retaining the exact `/bin/sh` launch arguments | Workspace and native launch; no watcher or HMR observation |
| `run-xzxhm2so` | HMR condition expired despite the product polling environment defaults | Real Vite, connected frame, revision-1 page and completed edit; no update frame |

The first three are harness failures, not product defects. Each correction was
source-reviewed and tested with pure mocked checks before a fresh bounded run.
The policy-ceiling correction changed only exact observer admission, not any
scenario or outer deadline. Tool admission remains bound to the pinned image,
exact arguments and unique active direct-parent request. Failed runs retain
their original result and artifacts.

For `run-gkyp1tr2`, Vite reported ready in 422 ms. Original supervisor and Vite
child were independently registered and validated. The preview loaded
`revision-1`, `import.meta.hot` was present, and the upstream socket negotiated
`vite-hmr`. The production file helper completed with its own observed exit 0
and native root-reap receipt. The edited file was independently read after
termination: 38 bytes, SHA-256
`f4a4a98aaa88b1a08d0b7a67c211ee8d90ade8ffaf7aace398e1d98bb92bfb30`,
matching the requested `revision-2` content.

The retained trace has no watcher events, HMR frames, browser console errors or
final unsuccessful page snapshot. The initial page snapshot had `connected:0`;
the upstream protocol alone does not prove delivery of the connected frame to
the page. Thus the trace cannot yet distinguish filesystem notification,
server emission, bridge delivery or client handling. It does not establish a
Seatbelt/FSEvents defect. No polling-mode or policy change has been made to
make the test pass.

Failure cleanup cancelled the Vite process through production shutdown. The
native receipt recorded root observed/reaped, supervisor exit 0 and child exit
143, matching its own kernel event. Final group-KILL returned EPERM and cleanup
uncertainty remains explicit. All nine registered original instances exited;
the observer sent no emergency signals and reported no final unknown exits.
A child ESRCH/recheck race after the HMR failure was separately retained; it did
not cause the preceding HMR timeout. This is neither a successful explicit
scenario Stop nor a guarantee about unobserved descendants.

## Narrowed diagnostic result and separate client correction

`run-e27nmkug` retained the unchanged six-second condition. The upstream socket
opened and delivered a 20-byte `connected` frame; the browser logged Vite's
connected event. After the production edit, the page still showed revision 1
with zero updates and the same document identity. No update frame reached this
upstream socket during the interval. Socket, projected console and snapshot
capture reported zero drops. A CSP error occurred only after the failed
condition and socket close, in Vite's reconnect path; it does not explain the
preceding absence of updates. This narrows the investigation to watcher/server
emission without proving a selected watcher or policy cause.

All 11 registered original processes had known terminal events. Failure cleanup
used the production path, retaining root-reap evidence and group-KILL EPERM
uncertainty. No emergency signal was sent. The scenario's explicit Stop/restart
and reattachment remain unreached. The 1,666 input records and five links matched
before/after; operational manifest was
`0f8da52334cd49aa6bf67b2f4c4bc81b1627f8742ce18b086a93d5a1136ca42d`.

Separately, a pure VM/mock reproduction found that synchronously dispatching an
open event and a message from one poll batch can lose the message when the
application awaits open before attaching its listener. `fd5d9e76` schedules each
incoming event in a separate browser task, allowing intervening microtasks.
Two mocked preview suites (12 tests) and lint passed. This does not explain the
run above, where the connected frame arrived and no update was emitted upstream;
the new client has not yet been qualified in the real Vite campaign.

The next attempt, `run-xqual8xm`, staged an observational watcher plugin but
failed before Vite launched. Its original `otool` image/arguments and kernel
exit were observed; a source-bound active-request check raced the parent's
synchronous completion. The parent completion is not a PID association or
substitute for the original kernel exit. This remains a harness failure, with
no watcher-selection or HMR evidence. All five enrolled original exits were
known; no observer signal was sent. Its 1,668 input records and five links were
unchanged. The plugin adds observation only and does not qualify the original
plugin-free fixture.

After the observation-only probe classification correction, `run-a0la0gqf`
reached Vite. The plugin recorded `useFsEvents:true`, interval 100, watcher ready
and revision.js membership before the edit. `usePolling` was absent from the
boolean projection, so its exact value was not observed. The production write
again produced the exact revision-2 bytes, but no target raw/change/add/unlink,
hot-update hook or send event appeared before the six-second deadline. Counters
for other paths, errors, projection errors and backpressure stayed zero. This
localizes the captured failure before HMR emission, without proving a Seatbelt
cause or permanent watcher failure. A separately attributed polling control is
in progress; no policy expansion was made. All nine enrolled original exits
were known; native group-KILL EPERM uncertainty remains.

The explicit polling control, `run-d8cr16br`, changed only Vite's fixed fixture
config to `watch: { usePolling: true, interval: 250 }`. Actual watcher options
showed polling true/FSEvents false. A target change reached the hot-update hook
(one JS module), update send, upstream update frame and browser hot-update log.
The DOM changed to revision 2 with the same document identity and one update.
The native Stop receipt and original exits were checked, the old socket key was
refused, and SQLite reopened the saved recipe without a persisted process ID.
All nine preliminary assertions passed, but the run remains **FAIL**: two
legitimate sync probe records for the same target made the observer's uniqueness
check reject the restart probe. No second-generation launch was credited.
All ten enrolled original exits were known; no observer process signal was sent.
An EOF failure-control intervention and native group cleanup uncertainty remain
recorded. This is a polling control, not proof of the FSEvents failure's OS cause.

The macOS backend now supplies polling/250 ms defaults through the supervised
command environment, preserving explicit policy overrides and existing private
HOME/PATH settings. Two mock-only environment-handoff tests and the existing
pure capability-profile test pass, as does lint. The environment change grants
no additional filesystem/network/Mach-service access. Polling's filesystem/CPU
cost and non-Chokidar tools remain separate; the subsequent environment-only attempt below did not deliver HMR. Agent guidance
now requires explicit project watcher configuration for macOS Vite.

The next attempt, `run-gs186938`, exercised the reviewed probe-class correction
but failed during the command's pre-exec transition. The original command was
registered before observation and stayed token-free. Its image changed from the
helper gate to `/bin/bash`, retaining the exact `/bin/sh` launch arguments; the
observer refused that unlisted intermediate image. All eight enrolled original
exits were known, including supervisor exit 0 and command SIGTERM matching the
native receipt. The observer sent no process signals; its owned stdin EOF was a
failure-control intervention. No watcher, edit, Stop/restart or second generation
was reached. All 1,668 file records and five links matched before/after. This
failure does not overturn the preceding polling-positive HMR evidence.

A locally prepared final source package combines the two committed Mac product
changes from `1b7bab2b91f7401194240923b2ab723b45f74398`, their mocked tests, a
narrow pinned shell-transition observation correction, and the original
plugin-free Vite fixture without a watch override. It is a derivative of the
remote `c586ab2b` base, not a full-head checkout or a runtime result. Its gzip
SHA-256 is `b20e4f76df6457ceb16e663f9ced8f6936e839d4826bc93bca3328793c266709`.
Automatic approval review initially blocked its transfer. On September 13 the
user explicitly authorized the source payload and existing Mac destination, and
request `req-b1b9445acb99b50721bcfd835d515b00` delivered it. The agent's visible
progress reported matching inputs, 14 mocked product tests, source/observer
checks and lint passing, with activation disabled. It then hit a model-capacity
error before submitting its explicit reply. These are progress reports, not an
independently reviewed completion package; no subsequent runtime is claimed.
The user then restarted the agent. Recovery request `req-f674ada2f570e8fecf1fc65c156bb57a`
returned the preserved package; the coordinator independently verified all 69
members, the four exact product/test files, unchanged records and plugin-free
configuration. The source export SHA-256 is
`cd9f3b64a1438bd3c5a8a0a04d265f6d1bfc23afe588e70c84bb2a47f071866f`.

`run-xzxhm2so` then used that source plus the exact two-stage shell observer
correction, owner SHA-256
`41e2c3305af8612ad5cafbd1d7b4747c5cab5967ea6867a0730b28955b1e3b5f`.
It failed the unchanged six-second HMR condition, with an outer duration of
7.350884 seconds. The connected frame arrived and the production edit completed,
but the DOM stayed at revision 1 with zero updates and no upstream update frame.
No watcher plugin was installed, so effective runtime watcher selection was not
observed. No planned Stop/restart stage was reached. Failure cleanup retained
native root observed/reaped, supervisor exit 0 and command exit 143, matching
its original kernel terminal. All ten enrolled original exits were known;
B retired before sole reap with exit 1, without observer signals or emergencies.
Native group-KILL EPERM uncertainty remains. The source/runtime/fixture pins
matched before and after. This is an environment-only failure, not a successful
qualification of those defaults.

The Agent now receives explicit macOS Vite project-configuration guidance rather
than relying on environment flags. The guidance preserves other config settings
and the sandbox boundary. Its 68-test mocked service suite and lint pass;
live-model adherence is not established.

## Evidence

Retained remote root: `/private/tmp/freedom-vite-production-d4uf2yyg`.
Local verified exports: `/private/tmp/freedom-agent-resume-20260912`.

| Run | Export SHA-256 | Payload members independently verified |
| --- | --- | --- |
| `run-r2trxr3k` | `8451d2c154dcf2a8ff17d23dec7ceddc9a84c00f5381d4cfa3fc8f559d8748d6` | 27 |
| `run-g95jyfra` | `1d338d26e7dd832c3bda2ca425754ef5e6dccf88d7898947186fa27f0e527c9b` | 55 |
| `run-8n8mb5es` | `3cd5968990caca050711c35c191ae55d74ba21804b943746ebbc4d486eff9b06` | 43 |
| `run-gkyp1tr2` | `b84306f40ee323fe73e3d0ebca0d51fad951107aee05de22f898c231592a547e` | 55 |
| `run-e27nmkug` | `e66b9a679c617ee2a0361ea1a4f203b1eadaa473b97ef470ae0fe142cc29bf33` | 40 |
| `run-xqual8xm` | `cf41857c2811652001a6314dc8641eb0883aec64b4faaa58a13668909159aef9` | 54 |
| `run-a0la0gqf` | `30230a0f1a2e2ce0d082ea9cc5645d5deef7ecc1a40e0046bb058c90cc405ded` | 62 |
| `run-d8cr16br` | `c5b493adb1c4f9fcd4e3c7e49bcc499f00be98e018b10d057b48309d328a0297` | 87 |
| `run-gs186938` | `26108ccaa11746ed416fad218f06300b39bb2afefd6a4af5c0e48d28a1de61cd` | 71 |
| `run-xzxhm2so` | `250db34e821e8b00a42729536f02e2b7da93d61cc4e87ec1cf57e83b486615ee` | 92 |

The tenth export redacts its saved preview-origin token in three shareable text
members. Those members carry original hashes and transformation metadata; the
export hashes verify the shared representations, not byte identity with the
retained unredacted originals. Original evidence remains unchanged on the Mac.

The fourth run's 1,664 pre/post input records and five symlinks matched. The
operational source manifest was
`aa87d62fd75a3e4b32a21ef479661dc01fd2fa9e05c56074b4767e7423eea6ee`.
Earlier evidence remained unchanged. Actual application restart/Quit,
live-model acceptance, signed packaging, aggregate resource containment and
general descendant cleanup remain outside this campaign.
