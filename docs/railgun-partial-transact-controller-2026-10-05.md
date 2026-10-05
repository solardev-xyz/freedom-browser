# Received-input partial withdrawal and recovery reader — October 5, 2026

The protected internal partial-withdrawal controller now passes connected native
qualification for both Shield-created and privately received Transact inputs.
This extends the [previous controller checkpoint](railgun-partial-controller-2026-10-05.md).
The Kohaku facade still refuses partial amounts; partial submission and durable
combined POI remain closed. No live private spend is qualified here.

## Connected received-input evidence

The [Transact report](qualification/railgun-partial-transact-controller-native-2026-10-05.json)
records final run D, **33,497 ms**. The [Shield compatibility report](qualification/railgun-partial-shield-controller-native-2026-10-05.json)
records final run F, **22,722 ms**. Both contain the same **522 source/test/fixture
hashes**, verified unchanged during each run and before copying the reports.

The disposable public vector is scanned by the real public and owned-wallet
scanners. A keyless fixture worker derives the creator's TXID row; the production
GraphQL normalizer checks its wire representation. The real account-TXID host
then builds and persists a checkpoint. Five real staging handoffs select the
received note, verify its provenance and reopen the same wallet generation.
Missing and copied staging receipts refuse before service traffic.

The actual internal operation performs independent change decryption, input POI,
01x02 preflight, reservation, signing, proof generation and fresh verification.
One spending key is delivered, after durable signing is observed; all borrowed
keys are wiped. The encrypted signed capsule and proof survive vault lock/unlock
and identity/enrollment reopening in the same process.

Negative controls reject the wrong viewing credential, an invalid membership
path, a wrong verifier and a rejected TXID root, without releasing a spending
key or changing reservation/capsule state. The first three disclose no selected
nullifier. **TXID root acceptance occurs after private preflight**, so the rejected
root case has already made one selected-nullifier query. Earlier root rejection
with a later freshness check remains a possible improvement, not a change here.

Service accounting is exact: checkpoint advance makes three latest-index reads,
one indexer-page read and two root validations. Each of five stagings adds two
latest reads and two validations, without fetching another page. The rejected
and healthy proving attempts each add one latest read and validation. Totals are
**15 latest / 1 page / 14 validations**; reopening adds none. Shield totals are
zero. Both fixture workers (TXID and membership path) exit once for Transact;
the TXID fixture worker is absent for Shield. Actual provenance, receive and
operation workers each run five times for Transact, alongside one signer and
one independent spend verifier. The credential-corruption receiver is the only
expected failed child.

The Transact duplicate control rejects a consumed staging receipt; it does not
independently reach held-input exclusion. The Shield compatibility run and prior
controller unit tests cover that hold check. Creator rows have no unshield; the
mixed creator's final-hash path belongs to the earlier creator qualification.
The foreign creator is derived from the same public mnemonic; its creating spend
is not proved. Global TXID completeness and creator bound-parameter checking are
not established by this single-row fixture.

Transport, chain headers, service/list signing trust, indexer pages and root
acceptance are simulated. No real Tor connection, live eligibility query, deployed
verifier equality, broadcast or funded private spend is claimed. Reopening is not
a fresh application restart or unfinished-proof resumption.

## Recovery dependency

The main-process capsule store adds `readSignedUnfinished(receipt)`. Like the
existing completed reader, it requires a genuine live recovery-origin receipt,
exact hold/capsule/signing binding and final encrypted snapshot/floor attestation.
It only returns a signed record whose proof slot is still empty. Expected
not-ready results preserve a healthy store; integrity failures remain fatal.
The existing completed reader and writers are unchanged. This adds data access,
not signing, proving or submission authority.

All **43 capsule-store tests pass** in **150.984 seconds**, including 11 tests of
the new reader. They exercise genuine reservation receipts and encrypted files,
full and partial records, reopen, copied/foreign/escaped receipts, binding
substitution, expiry, floor drift and unchanged bytes/inventory. The phase adapter
and signatures are structural test fixtures, not native cryptographic evidence.
`npm run lint` passes. This does not refresh the previous broad regression.

Claude reviewed the fixture, service accounting, reader and its tests. The new
reader remains inside existing main-process persistence responsibilities; no
renderer, IPC, dependency, runtime pin or derived-cache policy changed. Main
`dbfd0e7d` was fetched and remains current, so no new node refresh is required.

## Next implementation

Signed-but-unfinished recovery remains open. Its next prerequisite is a genuinely
completed-only wallet opener: the ordinary journal constructor rotates its lease,
and the viewing runner needs stronger callback/child drainage. Recovery must not
implicitly repair, advance or rebuild a missing, pending or stale generation.

Then reconstruct the original signed capsule's proof for all supported kinds and
both creator types, independently verify it and fill only its original proof slot.
Proof regeneration grants no fresh admission or submission authority and need not
repeat signing-time POI/provenance disclosures. Submission retains fresh verifier,
root/unspent and destination checks. Partial submission/capture, combined POI
persistence, normal change scanning, restart/second spend and live qualification
remain separate requirements for PPv2 parity.
