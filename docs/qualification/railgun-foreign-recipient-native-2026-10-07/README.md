# Native qualification of a full-value transfer to another account

Five Electron cases ran at source `ea9cbdc0` with `scripts/qualify-railgun-proof-recovery.js`. They exercise the [foreign-recipient transfer](../../railgun-foreign-recipient-2026-10-06.md).

Each case uses a fresh disposable profile whose vault holds the public fixture mnemonic:

- account 0 is the sender A;
- account 1 is the recipient B;
- account 2 is an unrelated account C.

The chain data and external service responses are synthetic. Signing, proving, recovery and wallet scans use the genuine controllers, utilities, stores and pinned engine.

The seven JSON files are byte-exact fixture outputs, with no machine paths. `INDEX.json` lists their sizes and SHA-256 digests.

| Case              | Files                                                                             | Input    | Run                                               | Result          |
| ----------------- | --------------------------------------------------------------------------------- | -------- | ------------------------------------------------- | --------------- |
| Shield, warm      | `shield-warm-report.json`                                                         | Shield   | one process, same root                            | qualified, 57 s |
| Transact, warm    | `transact-warm-report.json`                                                       | Transact | one process, same root                            | qualified, 58 s |
| Shield, restart   | `shield-restart-handoff.json`, `shield-restart-report.json`                       | Shield   | setup, then a fresh resume process, same root     | qualified, 37 s |
| Transact, restart | `transact-advanced-restart-handoff.json`, `transact-advanced-restart-report.json` | Transact | setup, then a fresh resume process, advanced root | qualified, 38 s |
| Self regression   | `self-transfer-regression-report.json`                                            | Shield   | existing `transfer` kind                          | qualified, 21 s |

In both restart cases the resume report records that the setup process was absent before the resume started. The advanced-root case recovers under a root that differs from the original. There, B already holds one earlier vector note, and the checks account for it.

## What each foreign case establishes

**Signing and binding.**

- A's signed capsule names B with the `foreign` marker and the full input value.
- Removing the marker or redirecting the destination changes the capsule digest, and so the authorization digest.
- The receive job verified B's destination before the single spending-sign key release.

**Receiver gate on the real signed intent.**

| Destination                             | Outcome         | Utility starts | Key releases |
| --------------------------------------- | --------------- | -------------- | ------------ |
| B                                       | verified        | 1              | 1            |
| A's own keys under the Sepolia encoding | refused         | 1              | 0            |
| unrelated account C                     | refused         | 1              | 1            |
| A's own instance with the marker        | refused in main | 0              | 0            |

**Recovery.** Original-signature proof recovery regenerated the proof from the stored signature. The proved commitment is the reviewed commitment.

**Chain and wallets.** A Transact event built from the real proved calldata, plus A's nullifier, is appended after the measured recovery at a synthetic block.

- **A**, advanced to the anchor: the input is spent by that transaction, the output appears only as sent, and its output type is Transfer.
- **B**: one full-value, unspent received note, with the sender address hidden, no memo and no sent record.
- **C**: nothing received or sent.

**A's POI reconstruction.** The output NPK is B's NPK and the output hash is the reviewed commitment. The blinded output is B's blinded commitment. An altered destination is refused.

**B's creator provenance.** B's own authenticated public source attributes the note to A's Transact: same transaction, `logIndex` 1, expected position, and the proved calldata ciphertext. It is not a Shield and not a sent record.

**B's spend preparation, with B's authority only.**

- The production preparation of a full unshield to a public test address is read-only, with no writes. Its nullifier is B's own and its root is B's tree root.
- Key loans during B's phase come only from `railgun:1`. There are no sender key loans and no sender descriptor.
- B's POI input reconstruction derives an input NPK that equals:
  - A's POI output NPK, which A recovered from the sender side;
  - B's wallet NPK.

## Not established

- **POI services.** POI eligibility and list acceptance are synthetic and not queried. A's post-transaction POI submission, review callbacks and real submission are not qualified.
- **B's spend.** B's spend is preparation only: not signed, proved or submitted. TXID provenance for B's input is not staged.
- **Accounts.** All three accounts are enrolled in one profile. Separate devices or processes per account are not covered.
- **Live behavior.** Nothing here qualifies funded or live use, Tor, relay delivery, recipient withdrawal on Sepolia, or EOA unlinkability.

## Inputs

| Input                                                                           | SHA-256 prefix     |
| ------------------------------------------------------------------------------- | ------------------ |
| Synthetic WETH source vector                                                    | `bfa8684f50b2bb83` |
| Engine archive                                                                  | `019f10880abf1c44` |
| Prover archive                                                                  | `dd50a29f297867b3` |
| Public contract bytecodes (`railgun-public-contract-bytecodes-2026-10-04.json`) | `a1f3a1c51c6272ec` |

The proof artifacts are the Oct 2 Railgun artifact set. Every report pins the 793 hashed source files, and all of them match `ea9cbdc0`.

## Development attempts

- **First Shield warm run (at `1c4694eb`).** A's side completed, but B's wallet open exceeded the three-worker session cap while A's public account still held two workers. `ea9cbdc0` closes A's public account before B and C scan.
- **One batch did not start** because of a shell word-splitting error, and **one advanced-root run** was refused by the qualifier's rule that an advanced root requires setup and resume. Neither produced a profile or a report.
- **A repeated Transact warm invocation** into the existing directory was refused without changing that directory's report, but it overwrote that case's local run log. The report and the recorded `qualified` status line are unaffected.
