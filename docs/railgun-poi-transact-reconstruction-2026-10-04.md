# Railgun received-note POI reconstruction — October 4, 2026

The utility-only POI reconstructor now accepts the exact Transact creator shape
produced by authenticated source extraction. It decrypts as the receiver using
the account viewing key and blinded sender key, with no sender or legacy fallback.
Input and self-transfer output ciphertext share one conversion/decryption path.

The utility compares creator tree, position and hash with the normalized recovery
capsule, checks the decrypted value against its original preparation, and binds
the note public key to the wallet master public key and decrypted randomness.
It checks the pinned WETH token hash and token fields, recomputes the note hash,
and derives the expected nullifier from the account nullifying key and position.
Shield inputs retain their exact preimage/ciphertext checks and net value handling.
Working viewing and shared-key copies are wiped; witness secrets remain in the
utility. SDK-created strings and witness values rely on process isolation and exit,
not complete memory erasure. Because the SDK constructs received-note NPKs from
the current wallet, the NPK check alone does not prove ownership: authenticated
decryption and comparison with the captured commitment are both required.
The pre-spend reconstruction's unspent-note requirement is unchanged.

This is proof preparation, not creating-transaction provenance or list acceptance.
The eventual funded sequence must obtain acceptance for the self-transfer's POI
before its received output can supply real membership for a later spend's POI.
No key-release allowlist, account policy, dependency, renderer or IPC changed.

## Evidence

The [Transact report](qualification/railgun-poi-transact-reconstruction-2026-10-04.json)
and [Shield compatibility report](qualification/railgun-poi-shield-reconstruction-2026-10-04.json)
each cover transfer and unshield, with 41 matching source hashes. Transact runs
refuse 13 direct reconstruction controls each; Shield runs refuse ten each. Every
control first normalizes its capsule. The foreign-recipient control additionally
proves successful sender-side decryption before receiver-side reconstruction
refuses it. Reconstructed private fields are compared with the original spend
request, in memory only.

Each of the four runs also refuses 12 assembly mutations and eight altered public
signals, and refuses a second proving attempt in the same process. The fresh
keyless verifier refuses changed proof, TXID root, POI root and output/marker.
Changing only the checkpoint index still verifies but changes the payload digest:
the index is metadata, not a SNARK signal.

Local POI proving plus same-process verification/control checks take 3,964/4,123 ms
for Transact transfer/unshield and 4,113/4,022 ms for Shield. The subsequent
keyless verification/control sequences take 809/815 ms and 885/844 ms respectively.
These timings exclude the earlier spend-proof generation. All 78 focused tests
across six suites pass; lint is clean.

The fixture uses public test keys, actual current-format Transact encryption,
a received input from a different public test sender with sender visibility enabled,
an actual one-input/one-output spend proof, POI witness assembly/proving and a
fresh keyless verifier after the proving process exits. Membership and transaction
history are synthetic; the creator ciphertext itself is not evidence of a mined
creating transaction. Legacy ciphertext has not been qualified. No external
query, funded private proof or submission occurs.

Next: controlled viewing-only handoff derived from authenticated recovery,
current membership, creating-TXID provenance where applicable and fresh final
source/root/account checks, then the disclosure controller and funded runs.
