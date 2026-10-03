# Railgun private completion and outcome matching — October 3, 2026

The private-operation controller now issues an opaque completion receipt after
independent proof verification, proof persistence and authenticated readback.
Its immutable snapshot binds the identity and enrollment, signing reservation,
submitter, operation ID, authorization digest, exact capsule, signature and proved
transaction. Only the successful controller can mint it. Reading a saved proof
or constructing an identical JavaScript object cannot create that authority.

The receipt lasts at most 120 seconds, can be claimed once, and survives closing
the account wallet so a submission controller can enter the exclusive recovery
phase. Identity, enrollment or either store closure revokes it. It attests the
earlier controller execution; it does not extend POI or chain freshness and does
not itself authorize broadcasting. Submission must claim it internally, compare
the entire snapshot against authenticated recovery records, run C again, obtain
fresh chain preflight and enforce the EOA journal before transport. A supplied
claimed object is not a substitute. Cold recovery still requires its own trusted
ownership/signature and gate reconstruction path.

The calldata classifier derives the private operation, root, nullifier,
commitment, bound-parameter hash and existing zero-proof intent digest from the
canonical transaction. No caller-supplied hold ID enters the EOA journal. It
supports the current single-input/single-output Sepolia transfer and WETH
unshield policies only. It does not compute Railgun's Poseidon TXID in main.

The own-hash receipt matcher requires the exact transaction, inclusion block,
nullifier and output event. Transfers compare all original output ciphertext;
unshields compare recipient, token and gross amount, recording actual fee
deviation. Extra proxy events, mismatched log positions or noncanonical encoding
refuse. Matches remain unverified RPC observations and confer no finality,
spending, POI or retry authority. These classifier/matcher modules are not yet
connected to generic journal classification or submission.

## Deployment event evidence

The contract checkout at `36bcf5ed7cf94bfafb6e1a303e1832c769c16780`
emits an `Action` event; the pinned engine V2.1 ABI does not include it. Independent
review checked the existing full-proxy public log capture, requested without a
topics filter and corroborated between Sentio and Tenderly through block
11,829,346. All 14,822 logs contain zero `Action` topics. Two examples are:

- Transfer `0xfc8fb142ef9fa7509462fe4f890d15343af3f54b3cdf8ee5518318cdf391e685`,
  block 11,809,836: Nullified at log 342, Transact at 343.
- WETH unshield `0xf2f3081d5406599731b2a71930b54f5bc0c6a9324b9f623029bd2deb57229e71`,
  block 11,802,339: Nullified at 73, Unshield at 76.

Capture observed at `2026-10-02T14:47:10.370Z`; report SHA-256
`21235a03e7374020b97c0253a71653b99cc99e4712758fb83666865d2eb078bd`;
page `00118.json` SHA-256
`52d6fbaabe2b6b9de56a42adf38af3b4f5dc9c304f7fa9fd7e91791bd090704c`;
log-set digest
`5ea1a7c8f307dcae2f8bbec85200410392b14d1db356f8b2b7d396e656c9d10c`.
These are public log captures, not full receipts or calldata; they establish
observed event order, not direct top-level routing or source/runtime equivalence.
Unexpected events remain fail-closed. The checkout is proxy-layout provenance,
not a claim that its current logic matches the pinned deployment bytecode.

## Qualification

The [transfer](qualification/railgun-private-completion-transfer-2026-10-03.json)
and [unshield](qualification/railgun-private-completion-unshield-2026-10-03.json)
reports each retain 94 matching source hashes and 19 existing enrolled runs.
The new controller portions finish in 3,770 ms and 3,290 ms respectively.
These synthetic enrolled runs exercise actual vault signing, isolated
A/B/C utilities, encrypted stores, wallet closure and exclusive recovery. It
checks the completion snapshot against the authenticated recovered entry and
capsule and refuses forged or twice-claimed receipts. External EOA, POI and
preflight observations are simulated. No live POI requests or submissions occur.
The funded note remains untouched.

All 110 focused tests pass across the controller, classifier and receipt matcher;
lint is clean. The completion tests include independent revocation by identity,
enrollment and either store, expiry after claim, deep immutable snapshots,
readback mismatch, wrong owners and repeated claims. Full regression results in
the earlier controller report predate this slice.

Independent review found no blocking issue in the classifier, receipt matcher or
completion changes. Claude's weekly quota was exhausted; an available independent
review agent performed these reviews without modifying the files.
