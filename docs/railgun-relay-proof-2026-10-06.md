# Railgun controlled fee and pre-transaction POI proof — October 6, 2026

A controlled native experiment at `0cc74e6c` proves the fee/output shape needed for a future Railgun relay lane: one synthetic 1000-unit WETH input produces a 100-unit broadcaster fee first and a 900-unit self output second. Both minimum-gas cases pass independent proof verification. This closes a cryptographic prerequisite; the current production broadcaster still submits through the enrolled Ethereum account, and gas relaying is not implemented.

The [evidence index](qualification/railgun-relay-proof-2026-10-06/INDEX.json) joins the aggregate report, source/runtime/artifact provenance, original process observations, engineering review and retained failed attempt.

## What passed

Each case uses the existing `01x02` transaction artifact and a separate `POI_3x3` pre-transaction proof. Another utility process reconstructs the expected public signals independently and verifies both proofs. Gas 0 and 1 use separate signatures.

| Minimum gas price | Transaction proof | Pre-transaction POI | Altered public signals refused | Recorded case time |
| ----------------- | ----------------- | ------------------- | ------------------------------ | ------------------ |
| 0                 | Verified          | Verified            | 13                             | 6.227 s            |
| 1                 | Verified          | Verified            | 13                             | 6.081 s            |

Verification binds the ordered fee/self commitments, ciphertext-bound parameters, transaction and pre-POI roots, and synthetic list root. Producer decryption and annotation checks establish fee-output semantics; annotation meaning is not a separate circuit constraint. Both production policy and payload normalizers continue refusing this two-private-output domain.

The original qualifier and driver exited naturally with code 0, without external termination. Four proof/verification utilities were deliberately closed after results with exit 15, without escalation or peer disconnect. Each producer and verifier reports the exact 91-hook JavaScript guard catalog, 91 canaries and zero forbidden attempts. These checks do not establish natural utility exit, physical resource drainage, OS egress confinement or Windows support.

The source freeze remained unchanged: 11,569 files, 15 symlinks, ten external inputs and 25 artifact files. The report selects 511 source hashes; that selection is neither execution coverage nor a transitive dependency closure. Root checks pass 168 focused tests in five suites, strict lint and explicit formatting of the two entry-correction files. They are not a full regression. Independent engineering review revalidated the bounded native evidence; this is not an external security audit.

## Evidence and limits

The fixture uses public disposable keys, fixed note randomness and an unsigned synthetic list path/root. It makes zero credential loans and submissions. No enrolled authority, authentic service quote, peer discovery, relay transport, acknowledgement, live disclosure or deployed-service acceptance follows from these proofs. A fixed 100-unit fee does not show that a service would accept the payment. Relayed full and partial unshield remain unqualified.

The compact archive retains the aggregate assertions, counts and provenance, **not public proof objects or calldata**. A reader can audit the recorded joins and source-derived checks, but cannot independently reverify the cryptography from this archive alone. That requires a new run with the pinned source, runtime and artifacts. Exact copied reports and normalized metadata are labelled separately.

[Failed attempt a](qualification/railgun-relay-proof-2026-10-06/FAILED-A.json) is preserved. Its Node entrypoint guard did not run under Electron's app loader, so no proof report was produced. Default Electron startup occurred and the parent externally terminated it. The resulting child exit 0 is not natural success; its driver exited 1. The corrected fresh attempt b above is separate.

## Next integration work

Pinned public client/server sources now resolve the protocol-source gap. Next is offline qualification of signed fee-advertisement bytes, address-derived keys and encrypted request/reply compatibility, using disposable data and existing dependencies. Then review production fee admission, a distinct pre-transaction POI authority and durable uncertainty before transport handoff. Lost replies must retain the original attempt without automatic retries, repricing or peer switching; a decryptable reply is not canonical inclusion or finality.

Confined Waku transport, dependency decisions and live deployment/service qualification remain separate. The existing funded-note/service disclosure gate is unchanged. This experiment does not authorize live spending, production activation, a return-to-origin exception or product UI, and does not establish PPv2's live relay milestone.
