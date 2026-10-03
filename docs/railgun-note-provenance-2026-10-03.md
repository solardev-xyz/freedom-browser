# Railgun detached note provenance — October 3, 2026

A detached, keyless verifier now rechecks a Transact note's creating TXID row and
all sixteen Merkle siblings using the pinned engine's Poseidon implementation.
It checks the exact output index, commitment, tree and position against the note
selector, recomputes the row digest, Railgun TXID and leaf, and compares a supplied
single-row creator event group. It rejects the known service omission rather than
using the diagnostic omission exception as spending permission.

This is a prerequisite for safely carrying public witness data across the
exclusive TXID and wallet phases. It does not enable Transact spending. The
private-operation controller continues to refuse Transact inputs until ownership,
authenticated creator events, current root acceptance and fresh POI are composed
inside its actual operation window.

The main wrapper accepts exactly one bounded result with the exact serialized
input hash, pinned engine inventory and zero guard attempts. Key, storage,
provider and input requests refuse; no binary-key option or database is passed.
Both caller and parent cancellation revoke the scope. Success and failure wait
for observed utility exit before returning. The result is immutable diagnostic
data, not an account or signing capability.

## Evidence and limits

All 1,911 Railgun tests pass across 97 suites (209.124 seconds), including 92
focused verifier/projection/witness tests. Repository lint is clean. The
user-created Codex reviewer independently approved the diagnostic boundary and
verified all 19 report hashes; no blocking findings remained.

The [actual Electron qualification](qualification/railgun-note-provenance-2026-10-03.json)
records eight runs, 19 matching source hashes and 1,211 ms elapsed. The valid
synthetic witness passes through the guarded utility. Changed sibling, index,
row hash and Railgun TXID reach cryptographic verification and refuse. A changed
note selector, incompatible supplied events and the known omitted creator refuse
at host validation before a child starts. No live queries or submissions occur.
The fixture creates only synthetic public fields; it does not open a user vault.

Focused tests cover all sixteen sibling positions, fabricated outside-tree
siblings even with a recomputed root, changed row/checkpoint metadata, immutable
copies, protocol escalation, duplicate/missing results, wrong digests/inventory,
crash and cancellation with delayed child exit. These use a deterministic test
hash; the separate Electron run uses the authenticated engine and real Poseidon.

A valid TXID path authenticates only the fields the protocol hashes. It does not
independently authenticate Ethereum transaction metadata, the complete supplied
historical state, or the source/completeness of the supplied events. The result
explicitly retains `ownershipVerified:false`, `eventSourceAuthenticated:false`,
`rootAccepted:false`, `spendingEnabled:false` and
`globalTxidCompleteness:false`. Event comparison also retains
`boundParamsChecked:false` and `unshieldCommitmentHashesChecked:false`.

The projection source belongs to the existing TXID policy closure. Its change
therefore selects a new mirror policy and requires requalification/rebuilding;
old encrypted mirrors are retained. Previous reports describe their own source
revisions and are not current-HEAD claims. No dependency, renderer API or package
boundary changes. The verifier stays in the existing main-owned wallet utility
architecture, where account and process lifetimes are enforced; the renderer has
no role in these checks.

## Remaining composition

Capture the selected owned note before closing the wallet phase, obtain its
witness in an exclusive TXID phase, drain and close that phase, then reopen the
wallet and rederive the same selection at the same public checkpoint. Inside the
real operation window, visit the current snapshot's authenticated source exactly
once and drain the whole visit, retaining only the bounded creating transaction.
The detached comparison must consume those events. Fresh root/required-list POI,
remaining-time margins and durable input holds must then be bound before any key
release. General multi-row creators, post-transaction POI and a funded second
spend remain unqualified.

## Root freshness prerequisite

TXID-root receipts now age from before the first service request, rather than
from successful acquisition. Both service responses must arrive within the
original 60-second budget. The deadline closes transport while the acquisition
continues to await pending work before releasing its busy state. `assertRoot`
accepts an optional remaining-lifetime margin; the strict boundary is
`age + margin < 60000`. Existing callers use margin zero; future signing
composition must request its own key-release margin explicitly.

Forty-five root/account-TXID/journal tests pass, including thirteen new slow-query,
clock-regression, margin and drain cases; lint is clean. The Codex reviewer
independently approved this change. No live service query was made. Because the
root-source code also belongs to the TXID policy closure, this follow-up changes
the mirror policy again before the deferred live rebuild.
