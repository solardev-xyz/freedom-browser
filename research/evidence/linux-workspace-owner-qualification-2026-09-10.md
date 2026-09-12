# Linux workspace owner — partial qualification, 2026-09-10

The correction remains separate from the feature branch. Its named gate-copy
follow-up is `336c183fcb2b0fd5d5634e9b40d7d3a638e1d9e8`, parent
`8e803e0097a28bf6aef2fc41222811d825fd3967`. The fixed natural-exit,
missing-command, Stop and control-EOF cases now pass on the disposable host.
Seven fixed native startup/creator-loss boundaries now also pass in a test-only
derivative, as recorded below. Actual Node creator-thread loss and full-backend
qualification remain open; this is not a complete Linux ownership qualification
or permission to merge on steady-state
evidence alone. The initial failed campaigns below are historical and unchanged;
the passing follow-ups are recorded below.

## Candidate and scope

The candidate replaces numeric process signaling with a native owner retaining
original pidfds through observation, retirement and sole reap. The first six
cases cover facilities, natural exits 0 and 7, missing executable, Stop, and
control-pipe EOF. They do not cover application Quit, creator loss during setup,
general process-birth discovery, stock AppArmor deployment, or resource limits.

The designated disposable Linux machine uses existing Node 24.15.0, Bubblewrap
0.9.0, kernel 6.8.0-90-generic and the existing
`freedom-appimage-qualification` profile. A separate test owner supplies private
namespaces, read-only inputs, bounded writable evidence, no host network,
UID 1001, capability removal, and original-process disposal. Its intervention
would fail the case; it cannot count as product cleanup. No host policy or
dependencies were changed for these runs. No native fixture ran on the primary
development Mac.

The source-built native helper is 26,448 bytes:

- C source SHA-256: `bedcf124cf368d37aabbfafe826b6f1727daf02e8e9346626db87befcb34cd45`.
- ELF SHA-256: `05178e1c6e86014c4cce3a61063229df1f40f3443c1b7063b0fbd8c8b2480088`.
- Installed Node SHA-256: `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`.
- Installed Bubblewrap SHA-256: `52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712`.

## First attempt — harness namespace refusal

The first campaign stopped at facilities: native `unshare(CLONE_NEWUSER)`
returned `EPERM`, before creation of the lifetime init or command. The harness
used `chroot`; Linux documents this as a user-namespace refusal condition.
Source review also found missing `/dev/full` and `/dev/tty` bindings needed by
Bubblewrap's later device setup. All five later cases were **not run**.

The correction added those two existing device nodes and replaced `chroot` with
a checked private `pivot_root`, detached the old root, verified the new root and
closed saved original-root descriptors before workload launch. Ownership,
deadlines, policy and product bytes remained unchanged. Pure mocked checks and
independent parent-only source review passed before a fresh campaign.

Original failure evidence is retained remotely under
`/tmp/freedom-owner-campaign-ce267b6c.0VJ9G4` and locally under
`/private/tmp/freedom-linux-first-failure-20260909`. The exported archive SHA-256
is `3a1b4cd10f68235c5686a99d83cdc76e94b23b54a707588dabdfd63444105420`;
the coordinator verified all 30 payload member hashes and sizes.

## Corrected campaign — facilities passes, gate execution fails

Reviewed harness owner SHA-256:
`759df67908a0c3c2ef5b5cca37d10763155683cb36718fb6eb8d1b2c40835614`.
Reviewed source archive SHA-256:
`bda54fb66d5fbc61a590025b6cae0e21fe08714e2415180eb7713be934551ed5`.

| Case | Result | Root command exit | Elapsed |
| --- | --- | --- | --- |
| Facilities | Pass | 0 | 0.655 s |
| Exit zero | Fail before command release | 1 | 0.644 s |
| Exit seven | Not run | — | — |
| Missing executable | Not run | — | — |
| Stop while live | Not run | — | — |
| Control EOF while live | Not run | — | — |

Facilities returned the actual `bubblewrap 0.9.0` output. Native monitor, init
and supervisor exited 0; the receipt recorded observed, retired and reaped with
no uncertainty. Original test-parent exit, authority retirement and sole reap
were independently recorded. This qualifies only that version/facility path.

The next case reported:

```text
bwrap: execvp /run/freedom-workspace-owner: No such file or directory
```

Its native receipt was `setup_failed`, with `released:false` and
`execAttempted:false`. Monitor exit 1, init exit 0 and supervisor exit 0 were
retained; lifetime observation, retirement and reap completed without uncertainty.
The command did not run. Successful cleanup is not successful command execution.
The campaign stopped there; neither Stop nor EOF was exercised. Both cases had
no recorded emergency signaling, timeout or unknown original owner exit.

Read-only ELF inspection identifies interpreter
`/lib64/ld-linux-x86-64.so.2`. The inner gate path or its interpreter resolution
requires diagnosis; stderr alone does not identify the missing path. Product
capability setup uses the same relevant runtime bindings and gate command as the
harness. A diagnostic must preserve that layout and execute independently of
the suspected missing interpreter alias. Any subsequent layout correction must
preserve both merged-`/usr` and split-`/usr` hosts.

Raw runs and activation diffs are retained remotely under
`/tmp/freedom-owner-campaign-04c9f711.RHfau4`, and locally under
`/private/tmp/freedom-linux-pivot-campaign-evidence-20260910`. Export archive
SHA-256: `25b4b185c462b9a6f1598f4da30e2e3b6978a245e96cfb14d0f2fa49372ebb61`.
The coordinator verified all 45 payload members against their original/export
hashes and sizes and inspected both raw native results. Nonactivation input
bytes, modes and ownership were unchanged. Previous failures and consumed run
markers remain preserved; recorded commands and identifiers are historical
evidence, not authorization to replay them.

## Follow-up — gate-copy compatibility correction

A bounded diagnostic confirmed the gate bytes and interpreter paths exist.
Retained audit evidence supports an AppArmor deleted-entry exec denial, consistent
with [Linux 6.8 path handling](https://raw.githubusercontent.com/torvalds/linux/v6.8/security/apparmor/path.c)
and Bubblewrap unlinking the backing file of its data bind. The raw audit records
remain in the task evidence, outside this repository update.

At that preparation checkpoint, the proposed correction used `--file` for a
named gate copy, retaining the pinned descriptor, mode 0555 and read-only root
before execution. Both capability and full backend paths needed the same change,
without changing host aliases, policy or ownership. The later results below
qualify the fixed cases; they do not change the earlier failed outcomes.

## Named-copy cases passed — reconciled 2026-09-12

Candidate `336c183f` changes both capability and backend construction to copy the
pinned descriptor with `--perms 0555 --file 8`, then seal the root read-only before
gate execution. Native C and ELF hashes above are unchanged; no host aliases,
AppArmor policy, dependencies or native ownership protocol changed.

The September 10 runs used the existing disposable host/profile, Node 24.15.0
and Bubblewrap 0.9.0. They comprise a separate exit-zero run and a subsequent
four-case campaign, each case executed once. The earlier facilities pass remains
at its original revision; this is not a new six-case campaign or full-backend run.

| Case | Native terminal reason | Command exit evidence | Outer elapsed |
| --- | --- | --- | --- |
| Exit zero | `completed` | Monitor 0, init 0 | 0.629 s |
| Exit seven | `completed` | Monitor 7, init 0 | 0.604 s |
| Missing executable | `exec_failed` | Monitor 127, init 0 | 0.633 s |
| Stop after payload marker | `cancelled` | Monitor unknown; init signal 9 | 0.627 s |
| Control EOF after payload marker | `control_eof` | Monitor unknown; init signal 9 | 0.638 s |

Each case has a complete native FINAL with the original lifetime observed,
retired and reaped, `uncertain:false`, supervisor exit 0 and complete transport.
Stop/EOF correctly return null command code/signal: the command monitor was not
observed, and the init's signal 9 must not be relabeled as the command's status.
Only Stop records an AbortSignal request; EOF records control-channel loss.

Independent outer records show original B/N/R terminal exit 0, authority
retirement before sole reap, no containment intervention and no unknown original
owner exit. Generic outer `product_pass:false` remains unchanged: case success
also requires the separate native receipt and fixed-case assertions. No process
census is used as an original-exit proof.

The exit-zero export has 29 payload files plus its manifest, archive SHA-256
`fa44b0b58ba9005afc39c64eafd9cb52b7c0ec24df0a600dc17f9c1e717f6a32`.
The subsequent four-case export has 105 payload files plus its manifest, SHA-256
`4bc58b5d7487db6919571aa719a7795db18a07b918d167560dfa3502ea7d9184`.
Coordinator reconciliation verified the four-case archive hash, every payload's
size/original/export hashes, raw case receipts, B/N/R retirement/reap ordering,
absence of outer intervention, and unchanged nonactivation inputs. Only the
expected case/request binding and root binding hash changed between activations.
Exit-zero raw receipt and original exit ordering were separately inspected.

Evidence is retained locally in `/private/tmp/freedom-linux-named-gate-pass-20260910`
and `/private/tmp/freedom-agent-resume-20260912/linux-four`; the latter verification
summary is `../linux-evidence-verification.json`. Remote originals remain under
`/tmp/freedom-owner-named-harness-9853e7fc.B3Ly38/runs`, with the four-case capture
in `/tmp/freedom-owner-four-9d884e01.DFoCkQ`. Historical identifiers are not replay
instructions. This reconciliation performed no runtime rerun.

At that checkpoint, still unqualified: pre-create/pre-arm cancellation and creator loss, supervisor
loss during handoff, output-holding descendants, pending controller disposal,
application Quit, full backend/workspace mount policy, and stock deployment.
Those require directed boundary witnesses, not repetition of these passing cases.

## Fixed native startup boundaries — 2026-09-12

Seven cases passed once each under the same private Linux owner. These used a
**test-only derivative** with deterministic holds around the existing
parent-death handoffs, plus a single-threaded native creator. Mechanical source
verification reverses the seven instrumentation edits to the production C.
The production worktree and helper remain unchanged at `336c183f`.

| Boundary | Observed outcome |
| --- | --- |
| Cancel before namespace-init creation | Supervisor exits 0; cancelled receipt says no init was created |
| Cancel at READY, before command release | Supervisor exits 0; receipt proves init SIGKILL, observation, retirement and reap; monitor status remains unknown |
| Creator loss before supervisor arms parent-death signaling | Creator SIGKILL; continued supervisor detects lost parent/control, exits 0 and is adopted/reaped |
| Creator loss after supervisor arms parent-death signaling | Creator and held supervisor SIGKILL; supervisor is adopted/reaped; no terminal receipt |
| Supervisor loss before init arms parent-death signaling | Supervisor SIGKILL; continued init detects parent loss and exits 125, then is adopted/reaped |
| Supervisor loss after init arms parent-death signaling | Supervisor and held init SIGKILL; init is adopted/reaped; no terminal receipt |
| Supervisor loss at accepted-start handoff, before monitor creation | Supervisor and held init SIGKILL; init is adopted/reaped; no terminal receipt |

Each original creator/supervisor/init outcome has its own wait evidence. Imported
pidfds provide observation only: the namespace owner signals only its original
creator, and that creator signals only its original supervisor. Adopted exit
credit requires successful `P_PIDFD`/`WNOWAIT`, followed by authority retirement
and one matching destructive wait. READY cancellation instead uses the native
supervisor's init wait receipt; it is not an adoption observation. Missing
supervisor receipts remain **unknown product outcomes**, despite independently
observed kernel exits. Every exported result explicitly retains
`productPass:false`.

All seven outer commands exited 0 in 0.535–0.575 seconds, without expiry,
emergency intervention or unknown original terminal/reap outcomes. Intentional
SIGKILL stimuli are not counted as emergency cleanup. Raw native/creator output
and stderr were empty; status streams were retained separately. Root wrapper
and namespace-owner exits, retirement and sole reaps were recorded. The root's
wrapper status does not itself prove an intermediate owner's exit. UID census
is corroboration only. No host policy, dependency, production source or native
artifact changed during this campaign.

Evidence archive SHA-256:
`3595430522dbb0ab4bb1ad0093877b3d41e2f12b63b2aac4ef94c5daa60ce1c9`.
The coordinator verified all **187 payload hashes/sizes**, inspected raw hold,
stimulus, terminal, retirement and reap records, and checked every case's
unchanged activated/post-run inputs. Retained remote evidence:
`/tmp/freedom-boundary-campaign-23366367.yzelYW`; local verification:
`/private/tmp/freedom-agent-resume-20260912/linux-seven-independent-verification.json`.
Historical one-use run identifiers are evidence, not replay authorization.

Source bundle SHA-256:
`2400fad77c68f7ecddc91dbec0f2e98c100b5b82586332b9452ac382274bbbcf`.
Derivative ELF SHA-256:
`781f4ac029b1f14bc40673d5829aca66ff414b45829861474509202f27363974`.
Creator ELF SHA-256:
`16f975bf690b7539dd916b533f80266f453a383a13cdce7ed3af808eb710e7d3`.
The derivative build required `-Wno-error=unused-result` for a test-hook
diagnostic write; its original strict-build failure and warning remain retained.
The production helper is not replaced by this derivative.

This closes these fixed **single-threaded native boundary** checks. It does not
qualify actual Node/libuv creator-thread-only loss, pending controller disposal,
the full backend/workspace integration, application Quit, general descendant
discovery, resource limits or stock-host/AppArmor deployment. Full backend
qualification is the next task; this campaign alone does not justify merging
the Linux correction.

## Actual backend and pending disposal — 2026-09-12

Six fixed cases subsequently passed against **unchanged production `336c183f`**,
using the real Bubblewrap backend, execution policy, helper resolution, three
capability probes and native transport. All 19 native launches produced matching
raw READY/FINAL records, original supervisor libuv exit 0 and complete stream
EOF. Native lifetime observation, retirement and reap were complete and
non-uncertain. The two cancellation cases acted only after READY, entry-gate and
payload markers.

| Case | Actual outcome |
| --- | --- |
| Exit zero | Completed, monitor/init 0, expected payload |
| Missing executable | `COMMAND_FAILED`, native `exec_failed`, monitor 127/init 0 |
| Pre-aborted request | Three capability probes, no request spawn/FINAL; cancelled with no side effects |
| Stop while live | Cancelled, init SIGKILL proved; monitor/public command status unknown |
| Control EOF while live | `control_eof`, same lifetime proof; no fabricated cancellation request or monitor status |
| Pending controller disposal | One entered pending setup; abort and drain to zero pending/active/leases; no runtime call |

The controller case used the candidate's real controller with a held minimal
store seam. It is not SQLite, active native execution or application Quit
qualification. The latest feature's saved-server additions were absent from
that controller; their integration needs separate source/test reconciliation.

Each outer command exited 0 in 0.610–0.732 seconds. For each original B/N/R,
retained kernel records independently show terminal exit 0, authority retirement
and one matching destructive wait. No owner intervention, expiry or unknown
original exit occurred. The outer's generic `product_pass:false` remains intact;
case-specific backend assertions supply the narrower product evidence. The
existing private namespace/AppArmor environment does not qualify stock hosts.

An earlier attempt remains a **failure**: the fixture omitted the mandatory
protected `.git` directory, so policy creation refused before request launch.
Its three capability probes passed, but no command case was credited. The
correction creates an empty task-owned `.git` directory (0700), without invoking
Git or weakening protection. Staging-removal seams retain all test files, even
on builder errors; execution and receipt paths are unchanged.

The failed archive is
`bd4dfaba707a05b4241f44d6c78bbe14ae73c2fa14b4bf4d3e9b35d01ad0ef29`
(62 payloads). The six-case archive is
`94b767d517427ead01a7bb7abf1e222d218ce46d971242a39c74b6d076679e54`
(170 payloads). All payload sizes/hashes were independently checked; the
coordinator also checked raw native/receipt correspondence, action ordering and
original B/N/R retirement/reap ordering. Local verification:
`/private/tmp/freedom-agent-resume-20260912/linux-backend-independent-verification.json`.
Remote originals: `/tmp/freedom-backend-campaign-b3c4367b.xKHCoP` and the
case-specific runs under `/tmp/freedom-backend-source-92d836f1.T0tOaS/runs`.

Production C, helper, Node, Bubblewrap, copied Git sources and existing
containment policy remained unchanged. Actual Node creator-thread-only loss,
full application Quit, general descendant discovery, aggregate resource limits
and packaged/stock-host deployment remain unqualified. The completed backend
cases and earlier derivative boundaries must retain their separate attribution.


## Experimental feature integration

Source review found no concrete blocker to integrating `336c183f` with the
completed evidence and stated limits. The merge preserves the current
`ManagedWorkspaceController` and saved-server implementation byte-for-byte;
all 14 incoming product/build/test files match the qualified candidate. The
only textual conflict was the roadmap's historical implementation checkpoint.

Merged-tree local checks passed **89 selected tests**: mocked owner/runtime,
process-manager, server-restart, preview and packaging orchestration tests,
seven targeted pending-disposal/error controller tests, and three pure backend
argument/stream tests. Four Linux-only build tests skipped on macOS; 41 other
controller/backend tests were deliberately not selected. Lint and diff checks
passed. No compiler, native sandbox, app or remote qualification was run on the
primary Mac. Existing dependency versions remain donor evidence rather than a
fresh exact-lock installation. This merge does not reattribute remote runtime
results to the entire combined feature tree or close the remaining release gates.
