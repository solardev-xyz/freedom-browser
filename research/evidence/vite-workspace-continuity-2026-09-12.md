# Real Vite workspace continuity — qualification in progress

The production workflow has reached sandboxed Vite startup, a saved process,
a preview page, the upstream `vite-hmr` subprotocol and a successful production
file edit. **HMR, explicit Stop, saved-server restart and reattachment are not
yet qualified together:** the first run that reached the edit timed out waiting
for the changed DOM. Further diagnostics are in preparation.

## Candidate and environment

The disposable Mac uses public feature commit
`c586ab2bcbff4207e8a2e7e08b703fa96d9d66f4`, tree
`84d6a347e5feb33d0dbf2fef7347319339fc7353`, with separately pinned test harness
files. Production sources and the Freedom dependency lock remain unchanged.

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

## Evidence

Retained remote root: `/private/tmp/freedom-vite-production-d4uf2yyg`.
Local verified exports: `/private/tmp/freedom-agent-resume-20260912`.

| Run | Export SHA-256 | Payload members independently verified |
| --- | --- | --- |
| `run-r2trxr3k` | `8451d2c154dcf2a8ff17d23dec7ceddc9a84c00f5381d4cfa3fc8f559d8748d6` | 27 |
| `run-g95jyfra` | `1d338d26e7dd832c3bda2ca425754ef5e6dccf88d7898947186fa27f0e527c9b` | 55 |
| `run-8n8mb5es` | `3cd5968990caca050711c35c191ae55d74ba21804b943746ebbc4d486eff9b06` | 43 |
| `run-gkyp1tr2` | `b84306f40ee323fe73e3d0ebca0d51fad951107aee05de22f898c231592a547e` | 55 |

The fourth run's 1,664 pre/post input records and five symlinks matched. The
operational source manifest was
`aa87d62fd75a3e4b32a21ef479661dc01fd2fa9e05c56074b4767e7423eea6ee`.
Earlier evidence remained unchanged. Actual application restart/Quit,
live-model acceptance, signed packaging, aggregate resource containment and
general descendant cleanup remain outside this campaign.
