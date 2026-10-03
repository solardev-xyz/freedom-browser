# Railgun private-spend preflight — October 3, 2026

The new main-process preflight composes the existing pinned Sepolia deployment
checks with `rootHistory`, the 25-bps unshield fee, the 1×1 verification key and
the selected nullifier's unspent status. Every additional read uses the exact
deployment anchor through EIP-1898 with `requireCanonical: true`; a final header
read checks that the anchor still agrees. Its height must cover the captured
wallet checkpoint. This is consistency from an unverified RPC, not chain proof.

The selector is copied before asynchronous work and binds tree, root, nullifier,
checkpoint hash and minimum block. The result grants neither ownership nor
signing authority. Operation composition must compare it against the genuine
captured note/checkpoint and the exact prepared intent. It must omit the selector
from public reports and logs.

The nullifier query runs last, after root, fee and verifier checks. An unspent
nullifier can identify the later on-chain spend to the RPC operator, even over
Tor. No live owned-nullifier query has been run for this qualification. The
eventual live operation must account for this disclosure as well as its POI
query. Reusing shield checks also checks RelayAdapt, the shield fee and token
blocklist; this is deliberately stricter than the direct private transaction
requires, and changes to those pins will refuse this qualification path.

Receipt age starts before deployment acquisition and stays bounded to 60 seconds.
The assertion accepts a required remaining-time margin for the later signing
gate, and also reasserts the underlying deployment receipt. Slow acquisition,
clock reversal, replacement receipt, cancellation, endpoint revocation and
changed anchors refuse. Expiry before signing should become an operation refusal
and pre-sign cancellation, rather than a signature followed by a stranded hold.
The eventual qualification must measure total preflight-to-signing elapsed time
to set that margin. It is not measured by these standalone unit tests.

RPC failures retain a sanitized cause code through both preflight layers;
governance/verifier mismatches remain distinct. Raw endpoint or request errors
are not returned. Authenticated artifact buffers are wiped on success/failure.
The implementation remains in main wallet services with no renderer API or
top-level package changes.

## Verification and remaining integration

The combined private-preflight, deployment-preflight and artifact suites pass
53 tests. New checks cover input copying, exact canonical anchors, wrong root,
spent input, changed fees/verifier, malformed responses, ordering that avoids a
nullifier query on earlier mismatch, minimum checkpoint height, elapsed-time
margin, late cancellation, stale receipts, forged enrollment and error redaction.
These use controlled RPC/artifact responses; they are not live private-spend
evidence. Existing artifact and deployment qualifications remain separate.
The full regression passes 8,670 tests (33 skipped); lint is clean. Claude
reviewed the deployment composition, query order, freshness and error handling.

The reviewed contract source at revision
`36bcf5ed7cf94bfafb6e1a303e1832c769c16780` has a `tx.origin` verification bypass
for `0x000000000000000000000000000000000000dEaD` in `Verifier.sol`. It calls the
proof verifier and then overrides its returned validity for that origin. A
successful simulation must never replace the separate witness-free proof check.
The normal submission path must estimate with the real submitter. No bypass
estimation path is implemented here.

Operation-owned POI, reservation/key release, retained-witness proving and
transaction journaling still need composition. The submitter's idle journal and
gas budget must also be checked before the durable signing transition. No live
note was reserved, signed or spent by this work.
