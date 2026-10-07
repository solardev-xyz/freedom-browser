# Railgun shield signing and recovery — 2026-10-03

The native shield preparation now connects to Freedom's transaction signer and
encrypted submission journal. The operation can sign once only after enrolled
recipient recovery and a fresh deployment preflight. A separate recovery path
survives preparation expiry, vault lock and restart. No live Railgun transaction
has been submitted by these qualifications.

## Signing and durable intent

The main wallet owns the operation; SDK utilities retain no signing or network
submission capability. A private handle registration binds the exact intent
digest and current preparation, receiver and deployment receipts. Both the
transaction service and raw broadcast path check this authority. A caller with
a generic transaction context and syntactically valid shield calldata cannot
bypass the receipt checks.

Before signing, the operation checks an undelegated funding EOA, exact-calldata
gas estimation/simulation, no unresolved journal entry, equal latest/pending
nonces, and sufficient balance. The qualification is bounded to 0.01 ETH,
3,000,000 gas and 0.002 ETH maximum gas cost. Review includes amount, fee, note
value, recipient, maximum gas cost and the public funding-address linkage.
The review deadline leaves ten seconds before the shorter preparation or
preflight lifetime expires. Revocation, expiry or changed transaction bytes
refuse before broadcast. A disk or transport failure after the journal write
can still leave an uncertain record; the margin does not eliminate crash risk.

The journal derives note public key, token, gross amount and expected note value
from the canonical signed calldata, together with its sender-bound digest. It
persists the signed hash and nonce before transport receives bytes. It stores
no raw signed transaction or key. Within this profile, the same EOA journal and in-process nonce lease cover
PPv2, Railgun and enrolled ordinary sends. Use of the same key from another
wallet or device is not coordinated. There is no automatic broadcast retry
or same-nonce replacement flow.

Pinned proxy, implementation and RelayAdapt targets cannot be labeled as PPv2
or an ordinary direct call. WETH transfers/wrapping stay ordinary. This target
classification does not discover indirect calls through arbitrary third-party
contracts and does not automatically enroll a fresh EOA making a dapp call.
It is not a claim that every possible Railgun interaction is journaled.

## Recovery and finality

Recovery opens an independent public-address context from the unlocked vault
session. It reads only journaled hashes. For a successful receipt it checks:

- the mined transaction's calldata-derived intent and nonce;
- one canonical Shield event from the pinned proxy, at the same block/hash;
- the expected note public key, WETH/sub-ID, and exact encrypted note payload;
- actual note value plus fee equals the journaled gross amount;
- bounded tree/position and no removed log.

A fee change is recorded as a deviation, with the actual received value. A
successful receipt without the matching note is an anomaly, not a completed
deposit. Explicit resolution requires at least three confirmations **and**
RPC-reported finality at or beyond inclusion, checked before and after review.
This remains unverified RPC evidence, not consensus verification or a grant to
spend. Generic resolution cannot bypass Shield matching: an opaque recovery
permit is required again inside the journal update.

Matched/reverted outcomes, finality observations and matched note facts persist
inside the encrypted resolution and survive archival. Reorg observations revoke
the entire resolution. Older builds that do not know the Railgun intent/schema
will refuse a journal containing Railgun records; downgrade compatibility is not granted.

Nonce-consumed-without-receipt and anomalous successful receipts remain
unresolved. A pruned or lagging RPC can omit a mined transaction, so absence is
not proof of no deposit. These states block every journaled send from that EOA;
use a dedicated funding EOA for the live qualification. Resolving them from a
complete authenticated public scan is future work. No workflow here silently
labels them not shielded or retries them.

## Actual qualification and limits

[Electron submission report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-submission-2026-10-03.json)
records three cases with real disposable vault enrollment, guarded engine
preparation/decryption, secp256k1 signing, encrypted journals and cold recovery:

1. A simulated acknowledged send is matched and explicitly resolved; its stored
   outcome is identical after another cold reopen.
2. A simulated accepted send loses its response, returns an uncertain hash, and
   is matched/resolved after cold reopen.
3. A simulated dropped attempt has no transaction or receipt. Cold recovery
   reports unknown, resolution is refused, and a newly prepared deposit cannot
   submit while that entry is unresolved.

The funding RPC is strictly in-process simulation. Only deployment reads use
live Tor. Before installing the override the harness refuses already-loaded
RPC/signing modules, and it uses a fresh ephemeral synthetic funding signer.
No private signer material is written to the report. The signer interface is
real, but this run does not exercise the vault-derived funding signer.
Simulated logs come from the transaction itself; the separate real Sepolia
Shield-log test checks the event layout against the two-provider archive.
The report's journal-before-transport assertion observes the journal in-process;
restart and durable-storage tests provide the disk-persistence evidence.

Run `a` passed the original two-case harness. Published run `b` adds the load-order
refusal, random signer and dropped-attempt case. Both remain local evidence;
only `b` is the current submission qualification. Its Arti endpoint is the
qualification-only shim; production Tor-manager/circuit isolation is not
qualified by this run.

[Live preflight timing report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-preflight-timing-2026-10-03.json)
records two additional public-vector cold-reopen checks, totaling 6.45 and
5.60 seconds for preparation, recipient recovery and live deployment reads.
Run `e` requalifies the account path with the current preflight; the earlier
account report binds the previous version. Preflight now distinguishes transport, deployment mismatch, stale and inactive
failures, or a generic refusal, preserving a bounded inner error code. Only a transport failure may
retry once on a fresh preflight source, before signing, within the original
preparation lifetime. There is no direct or alternate-endpoint fallback.

Validation: all 8,287 native tests pass (33 skipped), including 36 receipt and
recovery cases; lint passes. The native command excludes the separately
configured OpenLV protocol suite. Claude reviewed the signing authority,
shared journal, matching, finality, durable schema and qualification harness.

The next live step is funding the dedicated Railgun EOA and a bounded shield,
then finalized scan recovery, owned-note POI/TXID evidence, private transfer and
unshield. These checks do not complete those remaining operations.
