# Recovering interrupted Myotis ownership without reboot (#418)

The reporter's Linux help dialog shows `Failure: ownership` with the addon
present. It does not identify what interrupted the supervisor. This change
fixes reproducible lifecycle dead ends, not a proven original crash cause.

## Lifecycle fixes

The old supervisor could publish `active`, fail before creating a child, and
leave that record behind indefinitely. Known pre-child failures now retire the
record; Windows also prepares its launch resources before publishing it.

The main-process wrapper also cached a failed stop indefinitely. A later
**Retry sync** now asks the native helper again after supervisor exit, rather
than returning the old failure. A lost terminal report can be reconciled from
the durable native record. Supervisor exit alone still does not prove child
exit.

## Normal recovery: a lock held by the node itself

On supported local storage, the supervisor acquires a separate read-only
`.freedom-myotis-lifetime` lease before writing `v1 leased <uuid>` or creating
the child. The execution child inherits this lease as fd 4 and retains it
across exec; it cannot write the owner receipt. POSIX uses a shared open-file
description with `flock`; Windows uses an inherited read handle denying write
and delete sharing. The supervisor retains its own copy too.

Recovery must acquire both the original supervisor-owner lock and exclusive
access to this lifetime file. While either process lives, recovery is refused.
After both exit, even if the supervisor crashed without a terminal receipt,
the helper writes `v1 orphaned <uuid>`. Startup or **Retry sync** can then
preserve the interrupted generation and create a fresh one in the **same OS
boot**. No computer restart is needed for this path. A missing or unsafe lease
does not count as proof. Filesystem replacement by hostile local software is
outside the existing profile boundary, as for ordinary retirement receipts.

The lock semantics are documented by [flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)
and [CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
Windows additionally retains its existing kill-on-close Job Object. The lock
test waits for actual release rather than assuming job cleanup is instantaneous.

## Legacy fallback: records without a child lifetime lease

Ordinary shutdown is unchanged: the native supervisor holds the owner file's
kernel lock and writes `retired` only after waiting for its direct child.
A free **supervisor** lock alone cannot prove exit for old `active` records:
the old execution child did not retain it. Neither a missing PID nor elapsed
time authorizes recovery. We cannot retrofit a lock into an already-orphaned
0.8.6 process. For those ambiguous records, the reboot witness below remains
a last resort; this is not the normal recovery path for new `leased` records.

New supervisor starts also save `.freedom-myotis-boot`, binding the exact
owner bytes to the local machine and OS boot. This file stays local and
is never logged. Failure to obtain boot evidence does not break otherwise
healthy startup or lifetime-lock recovery; it disables only the legacy boot fallback.

On an ownership failure, a bounded helper invocation takes the **same owner
lock**, checks a local filesystem and regular files with one link, then compares
that witness. A live owner, different machine, inaccessible file, unsupported
filesystem or unavailable boot identity stays blocked. No process is signalled.

A missing/invalid/stale witness is recorded for the current owner and current
boot. Freedom asks: **Restart your computer, then reopen Freedom**. This is the
one-time migration path for blocked 0.8.6 profiles: first launch the updated
build so it records the evidence, then restart the computer. Restarting only
Freedom, sleeping, or retrying in the same boot does not qualify.

After a matching prior-boot witness, the helper writes `v1 rebooted <uuid>`
while still holding the owner lock. The original owner bytes remain in the
witness. Both `rebooted` and `orphaned` allow **replacement only**: the store creates a fresh
bundled generation, preserving all old snapshots and anchors. Only untrusted
peer hints may be inherited. Stale bundled anchors still require the existing
checkpoint quorum plus Colibri verification. A crash between the receipt and
pointer publication remains recoverable without resuming the old snapshot.

## Platform evidence

- Linux: `/etc/machine-id` plus `/proc/sys/kernel/random/boot_id`. Recovery
  (both the lifetime lease and this fallback) accepts a bounded list of local
  filesystem types — ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, F2FS, ZFS,
  eCryptfs, bcachefs, JFS, ReiserFS and NILFS2 — not NFS/CIFS/FUSE/unknown
  types. A profile on any other filesystem stays blocked as in 0.8.6, with the
  ownership message rather than restart advice.
- macOS: `gethostuuid` plus `kern.bootsessionuuid`, on `MNT_LOCAL` storage.
  The boot session UUID survives sleep/wake/hibernate.
- Windows: the installation's `MachineGuid` plus the kernel System process
  (PID 4) creation time from `NtQuerySystemInformation` (the process-table
  buffer grows on `STATUS_INFO_LENGTH_MISMATCH`; every allocation, headroom
  included, is capped at 256 MiB). That process's creation time is fixed for
  the lifetime of the kernel; this is **not** wall-clock time minus uptime. It follows the Windows boot identification
  approach in the [OCSF CPID specification](https://github.com/ocsf/common-process-id/blob/main/specification.md#windows).
  Network drives and reparse-point owner files are refused. Use Windows
  **Restart**, not merely closing Freedom or sleep/hibernate.

As with the existing retired receipts, hostile software able to rewrite the
user's profile is outside this boundary. Moving a shared profile between live
machines is not supported; a changed machine identity never proves reboot.
No new IPC authority or dependency is introduced: policy stays in the main
process and kernel checks stay in the existing bundled native supervisor.

## Validation

`node scripts/check-myotis-owner-recovery.js` exercises the compiled helper
with real platform boot identities and disposable directories. Its crash test
kills the retained supervisor while a benign node holds its inherited lease,
checks that a surviving POSIX child still blocks recovery, then confirms that
child exit permits same-boot recovery and fresh-generation selection. Windows
checks the same transition with Job Object cleanup. It also covers
legacy witness creation, same-boot legacy refusal, a simulated previous-boot witness,
changed owner bytes, a different machine, hardlinks, a live supervisor lock
and ordinary clean retirement. It starts a benign JS addon, not live Myotis,
and neither reboots the host nor touches user profiles. CI runs it on all five
shipped OS/architecture targets. Simulation is not a physical reboot test.

Unit coverage checks retry after a failed stop, lost terminal reports,
fresh-generation replacement on both chains, interrupted
pointer publication, preservation of old snapshots, unchanged ownership while
reboot is pending, distrust of helper success without a durable receipt,
manager error routing and user-facing reboot guidance.

At `ce1d4781`, the native regression passed in CI on Linux x64/arm64,
macOS x64/arm64 and Windows x64 ([run](https://github.com/solardev-xyz/freedom-browser/actions/runs/37344361483)).
Windows crash recovery plus replacement read took 238 ms; local POSIX runs
took 2.2–2.4 s including the fixture's intentional two-second child pause.
The macOS test also passed under the installed Electron runtime, followed by
all nine cases in `qualify-myotis-supervisor.js` (blocked operations, forced
stop, parent loss, group termination and clean reuse). These are benign-addon
lifecycle checks, not live network-sync or physical reboot qualification.
