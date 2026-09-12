# Linux workspace owner — partial qualification, 2026-09-10

The correction remains separate from the feature branch. Its named gate-copy
follow-up is `336c183fcb2b0fd5d5634e9b40d7d3a638e1d9e8`, parent
`8e803e0097a28bf6aef2fc41222811d825fd3967`. The fixed natural-exit,
missing-command, Stop and control-EOF cases now pass on the disposable host.
Startup/creator-loss and full-backend qualification remain open; this is not a
complete Linux ownership qualification or permission to merge on steady-state
evidence alone. The initial failed campaigns below are historical and unchanged;
the passing follow-up is recorded at the end.

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

Still unqualified: pre-create/pre-arm cancellation and creator loss, supervisor
loss during handoff, output-holding descendants, pending controller disposal,
application Quit, full backend/workspace mount policy, and stock deployment.
Those require directed boundary witnesses, not repetition of these passing cases.
