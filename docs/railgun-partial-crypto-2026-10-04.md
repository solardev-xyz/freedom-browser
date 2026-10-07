# Railgun partial withdrawal: native proof and recovery — October 4, 2026

Historical checkpoint at `941099ff`; later
[receipt/TXID primitives](railgun-partial-receipt-2026-10-04.md) extend recovery
without enabling the complete partial wallet operation.

The bounded partial-withdrawal model now has real 01x02 proving and cold
reconstruction from its original encrypted change and stored signature. A fresh
keyless verifier accepts both the initial and recovered proofs. These are
utility-level tests with a synthetic account and scan, not an enabled wallet
operation or a complete two-spend journey.

## Implemented cryptographic path

The production witness helper derives C = V − U from the recovered input and
request. It constructs the pinned engine's self-owned Change output, then
appends gross unshield U. Both values must be positive; private outputs are
`[C, U]` and public commitments are `[change, unshield]`. It decrypts the change
in receiver-only, nonlegacy mode and verifies the self NPK, pinned WETH, C,
commitment, Change annotation, sender-random convention and absent memo. The
unshield commitment is independently reconstructed from recipient, token and U.

Reconstruction decrypts the retained ciphertext without creating a new note or
transaction request. It restores both private output values/NPKs and both public
commitments. The operate utility compares original/reconstructed private and
public inputs and canonical ABI-encoded bound parameters before requesting a
signature. Canonical encoding permits an engine object and an ethers decoded
tuple to represent identical data; a changed nested ciphertext still refuses.

The prover constructor's closed `intentKind` option selects the artifact before
signing. Omission preserves legacy-only 01x01 behavior; an explicit supported
kind must exactly match the later preparation. Partial selects 01x02. The
separate signer reconstructs the final unshield commitment and hashes all five
ordered public inputs before borrowing one spending key. It does not authenticate
change ownership by itself: that requires the viewing witness checks above.
The fresh verifier derives the circuit from validated intent, checks five public
signals and rejects a verification key with a different public-input count.

Main's identity signing gate, account wallet, staging and operation controller
still refuse partial requests. Reservations, submission, public journal and POI
admission remain closed. Supporting a primitive in an isolated utility does not
grant a main-owned operation permission to use it. No renderer, IPC, dependency,
artifact pin or runtime archive changes are involved.

## Native cryptographic evidence

The [complete partial report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-crypto-2026-10-04.json)
records a real production-witness/01x02 proof in **3,716 ms**, followed by cold
stored-signature recovery in **3,378 ms**. Recovery makes **zero additional
spending-key transfers**, retains the original intent and TXID, and passes fresh
independent proof verification. The fixture's account, input note, Merkle path
and scan are synthetic; it does not open an enrolled production account.
The fixture stores the capsule/signature through the generic encrypted storage
API, opens a fresh reader and resumes in a new utility after interrupting the
first one. It does not use a genuine partial reservation/capsule-store write or
restart the whole wallet application; those main-owned paths remain closed.

Each of the five public signals is changed coherently in intent, final calldata
and expected metadata while retaining the original proof. Structural matching
passes first, then real verification refuses. A sixth case swaps the two
commitments and is also refused. Recovery rejects 19 controlled changes, including
wrong value, ciphertext, annotation, viewing key, output order and a coherently
retargeted recipient under the original signature. The foreign-change control
uses the same viewing key: decryption succeeds before ownership/hash binding
refuses. It is not merely a wrong-key decryption failure.

Eight randomness/encryption/preparation hooks remain armed during reconstruction
and record zero calls. The absent memo is accepted. Each admitted broker callback
is drained and actual utility exits are awaited; reports retain their exit
observations. The partial fixture records three successful signer invocations
across initial preparation, an alternate-message signature control and interrupted
preparation. This is not a claim that the whole fixture uses a single key request;
only the stored-signature recovery uses none. Five additional signer refusal
cases cover message, chain, public key and host request binding.

The partial zero-proof refusal reports `RAILGUN_PROCESS_FAILED`, exit code 15,
without escalation; comparable legacy controls report code 1. The child posts
failure and closes its port, whose close handler exits with code 1. Independently,
the supervisor responds to failure by closing ports and sending SIGTERM, and the
fixture closes after readiness rejection. These paths can race. The report
establishes refusal and an observed supervised exit, not a natural self-exit or
the exact ordering of those events.

The [complete legacy report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-legacy-crypto-2026-10-04.json)
preserves transfer/unshield proving (**2,863 / 2,767 ms**) and four cold cases
(**2,908 / 2,863 / 3,113 / 3,075 ms**). Stored-signature cases use no new spending
key; the two explicitly requested legacy resign cases each use one. Both reports
retain 27 source hashes. Inclusion in that inventory identifies versions, not
execution of every module. No RPC, POI query, funded profile or send is involved.

## Existing wallet compatibility

All **306 focused tests across ten suites** pass, including the unchanged main
identity/account/staging/operation refusals. Lint is clean. Claude reviewed the
production and fixture source and audited the two native cryptographic reports.
This is engineering review, not an external security audit.

Six additional fresh Electron runs preserve the connected Kohaku operations;
each passes 19 enrolled-wallet baseline cases. The
[compatibility index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-crypto-compatibility-2026-10-04.json)
links the complete original reports:

| Existing flow                     | Outcome               | Operation time | Source inventory |
| --------------------------------- | --------------------- | -------------: | ---------------: |
| Shield input → private transfer   | Lost acknowledgment   |       4,512 ms |              133 |
| Shield input → full unshield      | Acknowledged          |       3,888 ms |              133 |
| Transact input → private transfer | Acknowledged          |       8,547 ms |              133 |
| Transact input → full unshield    | Lost acknowledgment   |       7,716 ms |              133 |
| Shield input → private transfer   | Held review cancelled |       3,398 ms |              133 |
| Public native-ETH Shield          | Acknowledged          |       1,877 ms |              169 |

These use real legacy proving/signing/controllers and journals, with simulated
RPC/POI authority. Sending cases each make one EOA signature and simulated send;
cancellation retains its private proof without an EOA signature or send. They
qualify compatibility of the existing operations, not a main partial operation.

The wallet-policy inputs change again through witness, reconstruction, prover
and operate-job source. The normal derived-cache rebuild must include these
changes. Public/TXID policy inputs, archives, pins and dependencies are unchanged.
Main `3b4f62df` remains merged after a fresh fetch; its explicit node refresh
remains current. The funded profile was not opened or refreshed.

The [full frozen regression](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-crypto-regression-2026-10-04.json)
passes **13,949 tests / 33 skipped**, **504 suites / five skipped**, in **504.063
seconds**, with all **1,497 source/test/configuration hashes unchanged**. It retains
the existing OpenLV exclusion and force-exit; natural application-handle drainage
is not established by that suite.

## Remaining integration

The [complete implementation plan](railgun-partial-unshield-plan-2026-10-04.md)
still requires anchored deployed 01x02 verifier checks, exact three-event receipt
and TXID recovery, real change ingestion through an authenticated wallet scan,
combined output/unshield POI, durable mixed-format recovery and a second full
unshield of that actual recovered change. Main partial admission remains closed
until that connected qualification passes. Live service eligibility and funded
private end-to-end qualification remain separate requirements.
