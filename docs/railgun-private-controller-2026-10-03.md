# Railgun private signing controller — October 3, 2026

The main-process controller now connects the retained wallet operation to durable
recovery storage, the vault-owned signer and independent proof verification. It
accepts one recovered Shield input, either for a full self-transfer or a full
WETH unshield to vault wallet zero's address. Transact inputs refuse before any
storage or network access until creating-transaction provenance is connected.
This technical path has no renderer API and cannot submit an EOA transaction.

Before opening the private window, the controller checks local reservation and
capsule capacity, resolves the vault submitter, checks its submission journal,
requires an ordinary EOA and at least 0.002 Sepolia ETH for gas. The independent
receiver checks self-transfers. An operation-bound POI check precedes the private
preflight, which discloses the selected nullifier to its RPC. Identity, input,
checkpoint, POI and preflight bindings are checked explicitly. Time budgets leave
room for the signer and a 20-second key-release margin; timed-out acquisitions
are closed and drained before the window returns.

B validates the public intent before requesting a key. Only that request can
trigger a reservation, exact capsule persistence and the durable signing
transition. The controller then issues a one-use permit bound to that identity,
live B instance, exact operation window and durable record. Identity rechecks it
before and after derivation. It sends the binary key only to B; failures and aborts
wipe the buffer, and the supervisor wipes it after copying. Signer exclusion lasts
until both the child and its pending host callbacks have drained.

B checks its own signature. Main persists that signature before replying to A.
A proves and exits; C independently verifies the exact resulting transaction;
only then is the proved transaction saved. A saved transaction has no proof or
submission authority by itself. The future submission controller must run C again,
check current chain state and use the recorded submitter through the EOA journal.

Known never-signing holds may be abandoned on failure. Once `markSigning` is
attempted, failures return `signed-unfinished` and retain the hold, even when a
write might have committed without acknowledgment or no key was released.
Recovery may distinguish a remaining `held` record and abandon it through the
existing exclusive `abandonRecovered` phase. A `signing` record is never released
by this path. Hold IDs and capsule contents belong only in encrypted account data
and internal results, never public reports.

## Evidence and limits

The [transfer report](qualification/railgun-private-controller-transfer-2026-10-03.json)
and [unshield report](qualification/railgun-private-controller-unshield-2026-10-03.json)
each record 94 matching source hashes, the existing 19 enrolled recovery runs,
and an additional production-controller run. The controller portion completes in
4,005 ms and 3,358 ms respectively. Each uses a disposable public-test-mnemonic
vault, real enrolled stores, actual A/B/C processes and one vault-derived spending
key reply. A fixture-only observer checks durable capsule/signing counts before
the binary reply, then checks the retained buffer is wiped. Signature/proof
persistence and C success are checked by assertions and the controller's successful
result; their report flags are derived from those checks.

**External EOA, POI and private-preflight observations are simulated in these
runs.** Negative POI leaves both stores unchanged and releases no key; duplicate
and Transact-input attempts stop without further simulated service calls. No live
POI query or transaction submission occurs. The fixture restores patched exports,
invalidates its simulated sources and evicts the patched controller afterward.
It is not an application capability or a live-service qualification.

All 173 focused checks pass. Full native regression passes 8,868 tests / 33
skipped across 424 passing suites. Lint is clean; Claude reviewed the implementation,
fixture isolation, sanitized evidence and documentation. The focused tests cover durability order, mismatched evidence, insufficient
margins, deadline drain, concurrent attempts, one-use permits, child exit during
host persistence, and key wiping after derivation. The observation-producing
modules are also tested for JSON-safe data used in the authorization digest.

The gas payer in this qualification design is the same vault EOA that sent the
Shield.
It publicly links the funding transfer, the Shield and the private submission. Separate Tor contexts do not
remove that link or prevent timing correlation between nearby provider requests.
This is not a production privacy claim.

Remaining work includes Transact-input provenance, the EOA submission and finality
reconciliation controller, interrupted signing recovery, post-transaction POI,
and funded private transfer/unshield qualification. The funded Shield note has not
been reserved, signed or spent by this work.
