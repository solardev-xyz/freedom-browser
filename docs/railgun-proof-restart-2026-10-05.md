# Proof recovery across a process restart — October 5, 2026

The [original-signature recovery host](railgun-proof-recovery-2026-10-05.md)
now passes native qualification across separate application processes, including
cases where the current tree has advanced since signing. All twelve restart cases
and two warm compatibility cases pass. Production code and policies are unchanged
from `ba44c1b4`; this checkpoint extends the qualifier and its evidence.

## What the restart proves

Each case starts with a fresh disposable public-vector profile. The setup process
runs genuine enrollment, scanning and signing, then injects the same broker-reply
fault after the signature is durable. It authenticates the unfinished record,
closes all owners, observes child/worker exits, wipes key loans, locks the vault,
releases the profile lock and exits. The launcher awaits exit before starting a
new Electron process. Resume requires a different PID, observes the setup PID
absent with `ESRCH`, and acquires the same profile's lock.

The new process unlocks the existing vault without importing or recreating it.
It derives a genuine identity and opens the existing enrollment/public generation.
The production existing-only recovery-store opener authenticates the original
history. A genuine reservation recovery phase discovers the sole signed hold;
no opaque receipt, capability or registry state crosses the process boundary.

The setup handoff supplies comparisons only. Resume obtains its current checkpoint
from the genuine cold public opener's authenticated scan-journal update, requires
it to match the handoff, then checks the root and tree length. The actual completed
wallet journal must match that checkpoint on every measured read, including a read
after the recovery utility exits. The original capsule and signature remain the
authority for the reconstructed proof's original root and path.

This is a **clean application restart after an injected utility fault**. It does
not test an abrupt application kill, power loss or an unobserved child exit.

## Cold opening and proof recovery are measured separately

Cold bootstrap makes exactly seven authenticated updates across six files: wallet
catalog, public catalog, public scan journal, reservations, capsules and their two
floors in the enrollment manifest. Only the expected lease/sequence/generation
fields may change; reservation/capsule entries and sequences and both floor values
remain identical. Unknown or repeated record updates refuse before writing.
The changed-file set must exactly match those six files. Every other account file,
including SQLite data, wallet journal and coverage, remains byte-identical; so do
the inventory marker and directory names.

Identity bootstrap runs two genuine derivation jobs, using one `spending-public`
and one `viewing-identity` loan. This necessarily derives spending material for the
public identity; it does not sign a new private operation. Bootstrap makes no RPC
or protocol-service request. Its two ordinary storage workers remain owned until
normal public-owner closure.

The qualifier invokes the production cold store opener during bootstrap. The
recovery host then reuses those opened stores in the new process. Measured proof
recovery uses two viewing-only jobs and one independent verifier, with no new
signing intent, spending-sign loan, POI/preflight query or EOA request. One read-only
wallet worker is opened and closed. Every resume process observes all seven child
exits and all three storage-worker exits.

After bootstrap, only the proof slot/sequence and its manifest floor change.
The original capsule, signature, ciphertext and reservation remain unchanged.
All five authenticated wallet-journal reads agree. A same-process retry returns
`proof-present` with no extra job, key, RPC or write. A third-process retry has not
been qualified; neither result creates submission authority.

## Advanced-tree cases

Maintenance happens explicitly in setup, before shutdown, through a genuine public
advance and an ordinary wallet advance. Recovery itself does not advance or repair
anything.

- Shield cases sign with two leaves, then scan the pinned source's existing
  Transact event: the tree grows to three leaves.
- Received-Transact cases sign with three leaves, then scan a synthetic event
  containing an unchanged foreign commitment/ciphertext from the pinned public
  vector: the tree grows to four leaves. The recipient label comes from that
  fixture construction; the run does not independently check the added leaf's
  owner or the complete received-note set.

Both recipient labels describe how the fixtures were built. The native assertions
cover tree growth, root change and preservation of the selected input.

Each case asserts the original selected input/hash/value/nullifier remains
unchanged and unspent, while the genuine current root differs from the capsule's
signed root. Recovery reconstructs against the saved original root/path and passes
fresh independent verification. The synthetic creating transactions and chain/list
observations do not establish protocol or live-service acceptance.

## Matrix and reproducibility

The [qualification index](qualification/railgun-proof-restart-2026-10-05.json)
binds all twelve setup handoffs and twelve resume reports, their hashes, matching
run IDs, successful setup-log records, runtime hashes and two warm reports. All
fourteen completed cases carry the same **532 source hashes**, rechecked against
the frozen tree. Times below cover the resume qualifier, not setup or total wall
time.

| Input    | Operation          | Same-root resume | Advanced-root resume |
| -------- | ------------------ | ---------------: | -------------------: |
| Shield   | Transfer           |         5,636 ms |             5,571 ms |
| Shield   | Full withdrawal    |         5,646 ms |             5,611 ms |
| Shield   | Partial withdrawal |         5,726 ms |             5,695 ms |
| Transact | Transfer           |         5,695 ms |             5,732 ms |
| Transact | Full withdrawal    |         5,876 ms |             5,717 ms |
| Transact | Partial withdrawal |         5,798 ms |             5,480 ms |

Every measured recovery makes one chain-ID handshake and two log queries. Header
counts are **38 for unchanged roots**, **42 for advanced Shield roots** and **34
for advanced Transact roots**: total RPC counts are 41, 45 and 37 respectively.
The index and reports retain counts per case. Only the reviewed protocol RPC
destination is used. Warm Shield-partial and Transact-transfer compatibility runs
pass in **23,275 / 24,793 ms**, using 41 recovery RPC calls each.

The committed handoffs are byte-exact setup evidence. They contain public-vector
identity IDs, hashes of the reservation/capsule/signature, encrypted-file hashes,
account filenames and synthetic checkpoint/block roots. They contain no plaintext
capsule, signature, private key, opaque receipt, hold ID or private wallet address.
These are disposable fixture records, not funded-wallet exports.

Invoke `scripts/qualify-railgun-proof-recovery.js` with the existing source,
directory, engine/prover archives, artifacts and bytecode arguments, followed by
`Shield|Transact`, `transfer|unshield|partial`, `setup` and
`same-root|advanced-root`. Await observed successful process exit, then invoke it
again with the identical arguments and `resume` instead of `setup`. Each case uses
a new directory; resume uses its setup directory. The original warm invocation
remains supported. Never run setup and resume concurrently for one profile.

The first setup diagnostic stopped before wallet setup because Electron's patched
filesystem treats ASAR files as directories. Raw archive hashing now uses
`original-fs`, as the production runtime verifier already does. The successful
cases use fresh profiles; no production guard or failed profile was repaired.
Syntax, formatting and full lint pass. Claude and a separate Codex reviewer
checked the restart fixture; Claude audited the native evidence.

The previous **15,178-test regression** remains evidence for `ba44c1b4`, with its
documented OpenLV exclusion and forced exit. All its production and test hashes
remain unchanged; only this qualification script differs. The repository regression
was not repeated for this fixture-only extension. Runtime/artifact pins, policy
hashes, dependencies, renderer and IPC surfaces are unchanged. No funded profile
or live service was used.

## Next

Connect partial withdrawal to the genuine one-use submission and authenticated
own-operation capture paths, preserving deployed 01x02 preflight and exact journal
binding. A recovered stored proof must not substitute for a completion token;
submission after cold recovery needs its own fresh-gates design. Durable combined
POI, normal change ingestion, restart/second spend, broadcaster qualification and
the funded private journey remain open. This milestone proves offline proof
recovery, not the full Railgun lifecycle or PPv2 parity.
