# Linux workspace owner — partial qualification, 2026-09-10

The correction remains on `fix/linux-workspace-process-ownership`, at
`8e803e0097a28bf6aef2fc41222811d825fd3967` (tree
`58fcee37c07146af4f6864bdb4b010be0afce898`). It is **not merged or runtime-qualified**.
Parent-only source review accepted the correction, including conditional cleanup
receipts. The fixed runtime campaign has reached the facilities probe but cannot
yet launch the command gate inside Bubblewrap.

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
