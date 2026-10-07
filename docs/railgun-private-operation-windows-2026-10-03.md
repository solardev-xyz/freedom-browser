# Railgun retained-wallet operation windows — October 3, 2026

The enrolled read-only wallet can now retain a genuine note witness while main checks an exact public intent, a separate process signs it, and the wallet process proves it. A fresh witness-free process independently verifies the proof after the wallet process exits. This plumbing has passed real circuits with synthetic enrolled notes; it does not yet grant access to the funded account's spending key.

## Boundaries and behavior

`railgun-private-operate-job` restores the viewing-only wallet, authenticates the serial prover and local 1×1 artifacts before offering an intent, and retains the witness inside that utility. Main accepts one bounded, normalized offer and checks it against the captured owned note: full WETH value, root, nullifier, operation kind and recipient. The independent viewing-key receiver checks self-transfer outputs. An unshield's commitment and signing message are independently recomputed in the signer before its key request.

The broker accepts either an exact refusal or a bounded signature. The prover checks its witness public key against the enrolled public key and verifies the signature against the exact public-input message before proving. The final transaction may change only the eight proof coordinates. Both prover and main return `independentlyVerified: false`; a later independent verifier is mandatory. The utility closes its prover and wipes loaded WASM/zkey buffers on success or failure. JavaScript witness strings are not claimed to be securely erased; process exit ends their lifetime.

A normal refusal completes the read-only restoration and atomically replaces the account view. Old views expire. The account checks the wallet-store digest and unchanged owned projection before publishing the new view. Storage requests after the offered intent are refused. No renderer, IPC channel, dependency or package boundary changes were introduced: process orchestration remains in the main wallet modules, and synthetic key handling remains in qualification tooling.

## Handler contract

The main-only operation callback receives owned-normalized intent data, the combined prover/router/identity signal, and an opaque window token. The token binds exact account/enrollment/coordinator owners, captured data and a conservative 175-second deadline. It refuses immediately on prover death, including while a secondary handler is draining. Keep neither token nor operation data as a reusable authority after the callback.

Every production handler await and child must honor that signal and have a hard deadline within the window. Observe every child exit before returning. The wallet runner retains the account phase until the handler drains; it deliberately cannot release the phase on a timeout while a child remains alive. A non-cooperative main callback could hold the phase indefinitely. The production handler must enforce bounded cooperative cancellation before it gains key authority.

Expected outcomes (non-Valid POI, stale evidence, unavailable network, pre-key signer refusal) must return `{status: 'refused'}`. Integrity failures throw and close the account/coordinator for recovery. Before a durable signing transition, the production gate must recheck the window, fresh POI and preflight receipts with remaining-time margins, exact receiver digest, current held reservation and the signer's validated digest. After `markSigning`, it must recheck both utilities and current authority before copying one spending key. This production gate, operation registration, private transaction journal and signing-state recovery are still to implement.

## Evidence

[Enrolled report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-operation-enrolled-2026-10-03.json) preserves the existing nineteen synthetic account/recovery cases and adds refusal plus proved windows for both self-transfer and full unshield. Its 82 source hashes match the final qualification tree. It uses only the explicitly documented public test mnemonic, a fresh temporary profile and local artifacts. No real vault spending key, POI request, live RPC, reservation or submission was used.

| Operation | Normal refusal | Prepare/sign/prove/independent verify | Wallet/prover peak RSS |
| --- | ---: | ---: | ---: |
| Self-transfer | 376 ms | 2,629 ms | 398,360,576 bytes |
| Full unshield | 337 ms | 2,398 ms | 396,935,168 bytes |

These are local qualification timings, not latency guarantees. Memory was measured with a restored synthetic wallet, not the funded live wallet. `receiverVerified: false` for unshield means the separate receiver is transfer-only; the signer recomputes the unshield commitment instead. The prover uses the unchanged default 256 MB JS heap and 768 MB sampled RSS limit. The proof windows use one synthetic key each in signer B, observe B's exit before returning its signature to A, observe A's exit before verifier C, and verify the resulting proof in C. Refusal windows transfer no spending key. Both paths preserve the owned projection and report zero wallet write attempts.

[Split-prover report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-prover-2026-10-03.json) uses the same production prover helper with real artifacts, independently verifies transfer/unshield proofs, rejects a valid signature over a different message before proving, and separately confirms the wrong-message signature fails the circuit. Its 20 source hashes match. Its `proofElapsedMs` includes negative controls, not just positive proving time.

Earlier synthetic runs `enrolled-oct3-a` and `-b` also passed; `-c` captures the final policy closure. The first full regression exposed an exact floating-point duration assertion; the test now uses microsecond tolerance with a deterministic fractional-clock case. Production deadline checks are unchanged. Final full regression: 8,730 passed, 33 skipped across 420 passing suites (the existing `openlv-protocol.test.js` exclusion); lint is clean. Claude reviewed the production changes, checked both source-hash sets and report redaction, and accepted the plumbing with the documented handler contract. The review found the missing prover-liveness binding and policy coupling; both were corrected and qualified before commit.

## Remaining live work

The wallet policy now covers 28 modules, including the operation job, prover, artifact loader and dedicated signature normalizer. A new live wallet generation is required; the existing public/TXID generations are unaffected. Batch further wallet-policy changes before rebuilding. Main-only signer/receiver result-normalizer changes no longer invalidate this cache.

The funded shield remains finalized and unspent. Owned-note POI disclosure approval is pending; no such query has been sent. Private preflight also discloses the selected unspent nullifier to its RPC and has not been run live. Fresh operation-bound POI, durable one-use key release, transaction recovery, post-transaction POI, Transact-input provenance, funded private transfer and unshield, and cold output recovery remain open. Synthetic proof success is not live Railgun parity with PPv2.
