# Restricted Kohaku snapshot adapter — October 5, 2026

The new read adapter exposes `instanceId`, `balance` and `notes` over completed
snapshots from a restricted host. The same read vectors run against an independent
memory host and a fixed Freedom bridge. Its reusable part has no Electron,
storage, key or network dependency. This is CommonJS/Node reuse under the existing
main-wallet boundary, not a published package, browser build or implementation
of Kohaku's generic `Host` factory.

The fixed bridge borrows an already-open genuine Freedom account. It authenticates
the owner join and rechecks the exact view, wallet/public generations and
checkpoint before publishing a read. It never opens, scans, restores or closes
that account. Structural hosts cannot enter the existing plugin registry or issue
preparation/submission authority. The adapter exposes `provenance: 'host-supplied'`
with either host; amounts and notes remain unverified data.

The adapter validates bounded canonical snapshot shapes, privately copies/freezes
them, and returns fresh mutable arrays, entries and assets. Mutating one result
cannot affect the host or another read. The original facade and its frozen result
identity remain unchanged. Unsupported ERC1155 notes still refuse unfiltered
reads; supported filters can exclude them. Shape validation does not authenticate
token preimages, ownership, chain state, POI eligibility or spendability.

Host callbacks are trusted synchronous application code. They are not sandboxed.
The adapter rejects asynchronous callbacks and thenable results; it observes
unexpected native Promise rejections without accepting async host currency or
claiming to drain that unsupported work. Read admission precedes callbacks, so
reentrant close cannot resolve shutdown before the admitted read settles. A final
check follows the host's currentness callback. Shutdown covers adapter reads and
never closes borrowed owners or claims physical resource drainage.

## Validation and review

Root checks pass **510 tests across fifteen suites in 1.355 seconds**, with natural
exit and no force-exit. Full lint passes with `--max-warnings=0`; all six added
files pass formatting. Logs and original exits are recorded separately from the
older native/full-suite checkpoints in the
[unit evidence record](qualification/railgun-kohaku-snapshot-unit-2026-10-05.json).
No fresh full regression is claimed here.

The new component contributes 89 tests. Shared vectors cover both hosts; the
Freedom bridge's owner/currentness seams use controlled doubles in these tests.
Ten detached mutations distinguish lost currentness checks, aliasing, premature
shutdown, unwanted owner closure and data-bound failures. Import checks show the
portable factory loads only its pure read helpers and builtins. Four actual pinned
Kohaku source hashes are checked; declaration syntax parses, but no TypeScript
compiler/assignability check is claimed.

Independent Codex review found that object spread dropped non-enumerable asset
fields after validation. The corrected revision copies validated fields explicitly
and has distinguishing controls for asset type, contract and token ID, including
ERC1155 refusal. It also requires a plain received array. The original candidate
is preserved; the corrected six-file revision cleared review before import.

These additions stay in the main process because the Freedom bridge authenticates
privileged wallet owners. Exposing an arbitrary host through the existing facade
would change its trust boundary and is unnecessary for this read-only adapter.
No existing facade, policy input, dependency, IPC or product activation changes.

## Subsequent qualification

The [October 6 follow-up](railgun-kohaku-snapshot-qualification-2026-10-06.md)
records one passing genuine-account native probe and a separate strict declaration
check against the actual pinned Kohaku graph. The syntax-only statements above
describe this earlier unit checkpoint. The later compiler run checks declaration
and consumer assignability, with an explicit dependency-version limitation; it
does not type-check the JavaScript implementation.

Generic upstream Host support, transaction-capable extraction, a standalone
package/browser build and live Railgun service/broadcaster qualification remain
separate. The [parity plan](railgun-parity-plan-2026-10-04.md) tracks those boundaries.
