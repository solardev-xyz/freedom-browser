# Railgun TXID journal and live root observations, 2026-10-03

A separate encrypted host journal now records pending TXID pages before apply,
then binds completed state to the whole-store digest and a fresh POI-node root
observation. Its account binding, public generation/source/public-store IDs,
TXID store ID and code policy must match on reopen; a fresh lease and monotonic
sequence guard each update. This
component is not yet composed into enrolled account ownership and grants no
independent event coverage, account POI or spending authority.

The pending record holds the exact base, expected result, up to 100 rows / 1 MiB,
page hash and historical root-acceptance metadata. The journal caps its entire
record at 2 MiB. Prepare requires both a current guarded projection receipt and
a fresh root receipt for the expected page-end state. Complete requires a current
apply receipt, matching page/state, a fresh store observation and fresh root
acceptance. Persisted acceptance cannot substitute for a new receipt on restore.

Recovery accepts only the exact base or expected state. At the base it checks
the prior whole-store digest. At the expected result there is no precomputed
post-apply digest: recovery instead depends on the guarded replay job checking
each page row's content/position/path and recomputing the full page from the base.
Earlier rows and nodes are checked when a later witness uses them. Completion
then records the observed whole-store digest. Store-and-journal rollback together
remains outside the existing local guarantees.

Root receipts come from the fixed public-only service client through managed Tor.
The source first checks the node's latest validated index, then asks it to validate
the exact tree-0 root and index. The receipt is opaque, point-bound, expires after
60 seconds using a monotonic clock, and is revoked with its service/context.
Explicit node rejection or a conflicting latest root has the distinct
`RAILGUN_TXID_ROOT_REJECTED` code; operational refusal remains separate. Neither
case triggers automatic retry or a direct-network fallback.

Evidence:

- [Actual host-journal qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-journal-2026-10-03.json)
  runs all 4,230 captured rows through the real guarded engine, encrypted worker
  and host journal. Controlled interruptions after prepare and after apply are
  followed by cold worker/journal reopen, replay and completion. Final root,
  transcript and checkpoint digest survive cold restore. These are orderly
  component shutdowns at explicit boundaries, not OS-crash or power-loss tests.
  Root receipts in this fixture are explicitly controlled assertions; public
  generation identities and encryption keys are synthetic.
- [Separate live root qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-root-2026-10-03.json)
  obtains real POI-node acceptance for the reconstructed root at index 4,229
  and the known historical root at index 4,187, then submits an invalid root at
  that same historical index and receives rejection.
  Using an older index ensures this negative case reaches `validateTxidRoot`,
  rather than only comparing against the latest advertised root. Forged,
  wrong-point and closed-source receipts refuse. This Node harness uses dedicated
  bundled Arti with a qualification-only endpoint shim; it does not qualify
  Electron's Tor manager or account lifetime.

The focused journal/root tests also cover changed policies and store identities,
changed whole-store digests, unexpected recovery state, stale root evidence and
forged receipts. The offline fixture does not exercise profile inventory; that
belongs to the pending enrolled composition.

Next is enrolled composition: dedicated purpose-separated keys, inventoried TXID
stores, public-generation binding, and exclusive TXID/wallet phases within the
three-worker budget. Witness consumers will need opaque host receipts bound to
the journal sequence, store state, current public generation and fresh root;
the journal's returned plain checkpoint is diagnostic data. Independent
row-against-event coverage remains mandatory before P0/P2/P5 can authorize owned
notes. Account-specific list eligibility, intent-bound proving/signing and funded
shield/private-transfer/unshield recovery remain open.

Claude reviewed the journal and root-source code. The current policy closes the
journal on failed evidence checks, including expiry; the owner must reopen for
recovery. This conservative availability behavior can be refined separately.
Seventeen focused tests and lint pass; the full native suite passes 8,035 tests /
33 skipped across 386 passing suites. No dependencies changed and no Railgun funds
moved.
