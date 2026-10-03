# Independent Railgun self-transfer receiver — October 3, 2026

A fresh utility now checks that a prepared self-transfer output can be recovered
by the enrolled account. It receives one viewing key and the exact zero-proof
intent, with no preparer witness, note database, spending key, network or prover.
The supervisor permits only its dedicated `private-receive` purpose and entry.

Both main and the utility validate the narrow transaction policy before key
release. The utility reconstructs the wallet's public identity from the viewing
key and spending public key, decrypts the output as receiver, and recomputes its
commitment. The token must be WETH and the recovered value must equal the supplied
amount. Keys and the shared secret are wiped before the result is sent. Main
accepts only the exact result schema, matching intent digest, amount/recipient,
pinned runtime and clean guard report, and waits for observed process exit.

The result says `recipientVerified: true`, `inputOwnershipVerified: false` and
`spendingEnabled: false`. It is frozen cryptographic data, not a spending grant.
The future private operation must invoke this check internally on the intent it
will sign, using the amount from its genuine selected note. It must not accept
a caller-supplied verification result or infer input ownership, conservation,
POI eligibility or reservations from output recovery alone.

## Qualification

The synthetic enrolled qualification tests correct self-transfers alongside five
failures that each reach the independent verifier: wrong amount, changed
ciphertext, changed commitment, wrong viewing key and a real output encrypted to
a different recipient. The altered-ciphertext case recomputes the bound-parameter
hash, and the foreign-recipient case supplies consistent ciphertext, commitment
and amount. These therefore test cryptographic verification beyond structural
calldata validation. The foreign output is sent by our synthetic wallet to a
second public test-vector account: sender-side recoverability does not satisfy
the receiver check.

Each transfer case records six viewing-key handoffs: one successful verification
plus the five negative cases. Nonzero proof placeholders and an invalid kind
refuse before any handoff. A structurally valid unshield also refuses before a
handoff because this verifier is transfer-only. These negative cases remain local
and synthetic; reports contain assertions and counts, not ciphertexts or nullifiers.

Unit checks cover copied immutable inputs, purpose confusion, repeated key
requests, substituted result fields, egress violations, late credential
revocation, concurrent requests and cancellation with process-exit drain.
Claude reviewed the implementation and the negative fixtures. The wallet cache
policy is unchanged because this verifier does not derive wallet state.

The [synthetic report](qualification/railgun-private-receiver-2026-10-03.json)
records three successful receiver suites and three valid-unshield refusals across
the eighteen enrolled cases. All 71 recorded source hashes matched the tested
tree. Regression: 8,619 tests passed, 33 skipped; lint clean.

The [live report](qualification/railgun-private-receiver-live-2026-10-03.json)
also passes: the receiver independently recovers a locally prepared self-transfer
from the funded Sepolia note at finalized anchor 11,834,513. All recorded source
hashes matched. This is a diagnostic preparation, not an on-chain transfer. The
first attempt refused at its initial Tor RPC anchor read (`TOR_REQUEST_FAILED`),
before wallet restoration; a fresh-process retry passed. No POI query, reservation,
spending-key handoff, proof or transaction submission occurred.

The verifier lives alongside wallet services in `src/main/wallet`; no renderer
API or top-level package responsibility changes. The independent utility keeps
receiver verification separate from the preparer's witness, which dies with
that utility.

## Remaining operation work

No live input is reserved, no spending credential is released and no private
transaction is signed or submitted by receiver verification. Fresh owned-note
POI, creating-TXID provenance, one-window preparation/reservation/signing/proving,
recovery and transaction-journal handoff remain required. Proof validity and
fresh deployment/root/unspent checks remain separate gates.
