# Read-only Railgun wallet windows — October 3, 2026

The wallet coverage store now supports repeated read-only restoration windows
after its original scan receipt has been consumed. This supplies the storage and
receipt lifetime needed for private preparation. It does not yet add an
account-owned preparation API, reserve a note or release a live spending key.

Each grant belongs to one live window signal and a fresh internal identity.
Starting it immediately invalidates old coverage observations, including when
no storage request follows. Reads retain wallet namespace and cursor bounds;
any non-read method is refused and counted, and the derived session closes.
This catches SDK cache updates during apparent note reads as well as explicit
writes. Request IDs restart per grant, but old grant identities cannot be reused.

Finishing revokes the grant before checking that requests have drained, cursors
are closed and a new genuine restore receipt is present. Finished receipts
cannot be replayed. Successful finish detaches the window's abort hook; normal
coordinator window closure therefore preserves the completed wallet session.
Cancellation, an unfinished cursor, a pending request or an invalid finish
closes the derived session and requires cold recovery.

Restore receipts authorize only coverage reads. Passing one to a coverage write,
or omitting the receipt to try the host write path, refuses. The original writable
engine phase remains one-use. After restoration the open store stays read-only;
advancing the wallet requires reopening through the existing account flow.

The runner's separate `restoreReadOnly` entry forces full wallet restoration and
validation, requires the whole wallet-state digest to remain unchanged, checks
zero refused writes, and issues a normal restore receipt only after the utility
has exited. It does not let a read-only receipt stand in for a scan that wrote
wallet state.

## Qualification

[Eight synthetic vault-bound Electron runs](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-readonly-wallet-2026-10-03.json)
cover scan, restoration and retained rebuild states. Three restoration cases
each open two extra read-only windows: six windows total. Every window records
zero write attempts, unchanged wallet bytes, fresh journal revalidation and
refusal of the previous receipt and view. Balances remain 3,000, 2,000 and 2,700
synthetic units across receive, spent and self-transfer states.

This run uses a real disposable vault, the authenticated engine and encrypted
wallet storage, but the non-enrolled qualifier composition. It keeps the coverage
store visible to the trusted test harness to exercise the window sequence. No
product API exposes that store. These are synthetic history tests, not funded
preparation/proving or full enrolled private-operation tests.

[The sixteen-case enrolled recovery qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-readonly-enrolled-2026-10-03.json)
also passes against these sources, covering the existing account scan, cold
restore, retained rebuild and interrupted/cancelled recovery paths. It does not
exercise the new repeated-window entry, which remains covered by the separate
vault-bound run above. The wallet policy changes with these source files and
required rebuilding the retained live wallet generation; public and TXID policies
are unchanged. [The subsequent live cache refresh](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-readonly-live-refresh-2026-10-03.json)
passes at block 11,834,513, recovers one asset and retains coverage of all 4,230
mirrored TXID rows. It performs ordinary account recovery under the new policy,
not the additional read-only-window entry or private preparation. It sends no
owned-note POI query and signs or submits nothing.

Unit tests cover write refusals, pending requests, leaked cursors, old grants,
receipt reuse, cancellation, observation invalidation and unchanged-state
requirements. The initial added test fixture accidentally reused an already
created SQLite path; allocating separate temporary directories fixed the fixture
without deleting retained files.

Claude's report review also caught the internal owned-note projection in the
first synthetic run's report. The qualifier now uses an explicit report-field
allowlist, retains only projection counts/types and field-check status, and
refuses serialized private projection fields. Both qualifications reran; only
the redacted, source-matched reports are committed here. The application native
regression passes 8,530 tests (33 skipped); 58 focused checks and lint pass.

## Account composition still required

The account method must capture genuine selection and fresh POI before entering
the exclusive public window, then compare the exact captured checkpoint and
re-establish ownership through this read-only validation. The coverage store
itself cannot authenticate an arbitrary AbortSignal as a coordinator window;
keep it private to the account wrapper, with the runner receiving only the
coordinator's signal.

After preparation/proving exits, the required order is: finish the restore grant,
end the public window, read fresh coverage, inspect unchanged state, revalidate
the wallet journal, then atomically replace the account's current receipt and
view. Old views and selections must remain invalid. Keep the wallet phase claim
throughout; a failure after opening the window must close the entire account.
There must be no unrelated coverage-store call between acquiring the fresh
coverage observation and revalidating the journal.

At this checkpoint the account wrapper still captures its initial receipt. Integrating that
atomic replacement, durable reservations, POI-bound signing and proof generation
remains the next step. Combined real-history restoration and proving must also
be measured against the coordinator's 180-second limit.

The subsequent [account-owned window composition](railgun-account-windows-2026-10-03.md)
implements atomic replacement and qualifies interruption/cold recovery. Private
preparation, reservations and POI-bound signing remain separate work.
