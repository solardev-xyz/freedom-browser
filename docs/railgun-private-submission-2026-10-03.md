# Railgun private submission and journal recovery — October 3, 2026

The main-owned submission controller now consumes the opaque completion receipt
itself, after the wallet has closed. It enters the exclusive signing-recovery
phase and compares the entire authenticated reservation and capsule against the
controller's immutable snapshot. The completion also retains the original
minimum block height, so a new preflight cannot silently lower that threshold.

C independently verifies the exact proof again. Fresh preflight checks the pinned
deployment, root, verifier, fee and unspent nullifier. The recorded vault EOA is
used for gas estimation and simulation; the dead-address verifier shortcut is not
used. Fee, gas, nonce, balance, sender and exact transaction are checked before
review and signing. The limits remain 3,000,000 gas and 0.002 Sepolia ETH in gas
fees. A one-use EOA signer wrapper checks live authority and durable records and
drains pending signer/review callbacks before releasing account exclusion.

Both generic signing and raw-broadcast entry points require the main-owned
submission handle for the new `railgun-transact` kind. Its intent is recomputed
from actual calldata, including signed bytes at broadcast. The existing encrypted
EOA journal records the attempt before transport. No automatic resend occurs.
An acknowledged result survives a later recovery-phase error. An uncertain error
hash is retained only when authenticated journal history matches the exact
private intent; callback exceptions cannot invent a submitted transaction.
If history cannot be authenticated, the controller requires recovery and retains
the private signing hold.

Cold EOA recovery matches exact own-hash events, requires confirmed and finalized
inclusion under the existing unverified-RPC trust model, and rechecks after
review. Successful outcomes require the nullifier and exact encrypted output or
WETH unshield destination/amount. Reverts may be resolved without claiming an
output. Nonce-consumed, missing, shallow, changed or inconsistent evidence stays
unresolved. Resolution and archival preserve the private intent and output facts;
neither releases the private signing reservation nor authorizes another proof or
replay. An alternative Ethereum hash still needs separate public nullifier/TXID
reconciliation.

Review found callback timeout races in submission and cold reconciliation, plus
an error-hash provenance gap. The implementation now revokes per-attempt authority
before draining callbacks, retains exclusion while they drain, and authenticates
uncertain hashes. Regression tests cover those races, fabricated error hashes,
generic signing/broadcast/resolution bypass attempts, cold reopen, canonical
receipt matching, finality changes and encrypted archival. The independent review
agent approved the fixes. Claude remains unavailable because of its weekly quota.

## Qualification limits and next work

Full native regression passes 9,011 tests / 33 skipped across 429 passing suites
in 292 seconds (`openlv-protocol.test.js` excluded as in prior branch runs).
Lint is clean. The complete source/test tree was frozen during the run. Main
remains `0b81852e`, already merged with its node refresh.

The controller unit tests simulate proof/preflight and transaction-service
observations. Recovery tests use actual encrypted journals, generic reconciliation,
intent classification and receipt matching against simulated RPC responses.
The earlier completion reports exercise actual vault signing, A/B/C and encrypted
account stores with simulated external gates. They do not constitute an end-to-end
qualification of this newly connected submission path.

Next is combined qualification of the real private controller, completion,
submission service and journal through a simulated transport, then funded live
qualification once owned-note POI disclosure is authorized. Still open:
Transact-input creation provenance, interrupted/cold private-signing recovery,
post-transaction POI and a second private spend, broadcaster support and funded
transfer/unshield. The existing Sepolia Shield remains the only funded Railgun
operation executed. No new live POI query, nullifier preflight or transaction was
sent by this slice. No renderer surface or new dependency was added.
