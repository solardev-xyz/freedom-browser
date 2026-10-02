# Railgun current-Kohaku viewing reads — October 3, 2026

The development Railgun adapter now exposes `instanceId()`, `balance(assets?)`,
`notes(assets?, includeSpent?)` and a `status()` extension over completed,
main-owned wallet evidence. It follows the read signatures at Kohaku
`92fb3a8a2d482ea9582402531e60f4b5131fd6ad`, inspected from its `base.ts` and
`shared.ts`. Transaction preparation methods are absent. This is not a product
session or a funded lifecycle result.

## Authority and semantics

`createRailgunKohakuRead` requires a genuine runner. Every call passes its opaque
receipt back to that runner, which requires a genuine wallet journal, matching
wallet/policy/store identity, and the exact receipt used to establish current
journal readiness. Readiness rechecks the public snapshot, coverage observation
and fresh whole-cache digest. A pending scan, stale snapshot, later store
dispatch, closed session/journal or forged receipt refuses reads. The journal
copies the caller's evidence container so it cannot be reassigned afterward.

The runner copies a minimal normalized projection into its private receipt map.
Mutating the raw utility result cannot alter it. Notes, arrays and asset objects
are frozen. Received and sent positions must exactly match their respective
validated coverage sets. Self-transfer projections must agree. Main checks
canonical amounts below `2^120`, commitment-hash field bounds, transaction IDs,
and token-preimage hashes. ERC721 quantities must be one. Main recomputes the
ERC20 or NFT token hash; it relies on the reviewed guarded scan for the underlying
note commitment, decryption, spent classification and source association.

Balances sum unspent received notes, using bigint amounts and `tag: 'unverified'`.
They are observed balances, not spendable balances. `status()` reports
`wallet-scanned-unverified`, POI `unverified`, and `spendableGranted: false`.
Quarantined or unrecoverable sent entries never contribute to balances; their
counts remain available in checkpoint status. Default notes exclude spent notes;
`includeSpent: true` includes them. Sent history is not mixed into received notes.

ERC20 and ERC721 assets match the current Kohaku types. **WETH remains ERC20**:
requesting `{ __type: 'native' }` returns no matching Railgun assets, not an
ordinary-account ETH balance. Filters are bounded, validate their exact shapes
and compare contract addresses case-insensitively. ERC1155 lies outside the
current Kohaku asset union. Unfiltered reads refuse if a selected note is
ERC1155; explicit supported-asset filters can still read their matching notes.
No unsupported asset is silently dropped from an unfiltered result.

The instance address comes from the authenticated guarded wallet constructor and
has a bounded format check. Independent credential/address enrollment is still
open. No mnemonic, spending/viewing key, note randomness or memo crosses this
read projection. Positions, commitments, amounts and transaction IDs are still
sensitive wallet data: future renderer/IPC exposure needs its own minimization
and privacy review. There is no new renderer or IPC access in this slice.

## Qualification

- [Synthetic Electron report](qualification/railgun-kohaku-reads-2026-10-03.json):
  thirteen scan/recovery cases, eight successful scan/restore windows. Current
  reads show 3,000 → 2,000 → 2,700 fixture units with 2 → 1 → 2 unspent notes.
  Including spent notes returns 2 → 2 → 3. Native filtering returns no matches.
  A forged receipt is refused, raw result mutation does not change balances, and
  replay-triggered session invalidation refuses all subsequent reads.
- [Archived-history Electron report](qualification/railgun-kohaku-read-history-2026-10-03.json):
  scan and cold restore traverse all 10,194 commitments. The public test wallet
  has no received/sent notes or balances and retains 70 separately classified
  unrecoverable sent entries. Scan took 2,648 ms; restore took 2,509 ms in this run.
- 54 focused tests pass, including uint120 maximum/overflow, token-hash mismatch,
  incomplete/duplicate positions, self-transfer disagreement, caller mutation,
  forged/stale receipt handling and unsupported asset behavior. Lint passes.
- Full regression: 7,775 passed / 33 skipped across 367 passing suites. The
  first sandboxed attempt could not launch Electron probes or bind loopback
  sockets; the rerun with native-process/network permissions passed.
- Claude reviewed the implementation and the resulting corrections. This is
  engineering review, not an external security audit.

Reports contain public/synthetic fixtures and source hashes. Earlier qualification
reports remain historical evidence for their pinned versions. These runs perform
no live acquisition, service eligibility check or transaction submission.

Reproduce with installed development dependencies and existing public captures:

```sh
node_modules/.bin/electron scripts/qualify-railgun-wallet-journal.js \
  /absolute/path/to/synthetic-source.json /absolute/path/to/new-output
node_modules/.bin/electron scripts/qualify-railgun-wallet-snapshot.js \
  /absolute/path/to/log-capture /absolute/path/to/header-capture \
  /absolute/path/to/new-output /absolute/path/to/completed-public-replay
```

Remaining parity work: account enrollment and source/runtime packaging; live
source acquisition and governance-boundary advancement; TXID/POI and relay
qualification; checked operation-bound proof/signing; reservations, durable
submission/reconciliation and funded shield, private-transfer and unshield flows.
