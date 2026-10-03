# Railgun keyless POI verification — October 4, 2026

`verifyRailgunPoiPayload` checks a canonical payload in a fresh keyless utility.
Main snapshots the bounded payload before any asynchronous work and binds both
its digest and the complete job-input digest. The utility loads the authenticated
serial verifier and POI_3x3 artifacts, derives all eight public signals, requires
successful verification and requires an altered TXID root to fail verification.
Only digests, selected flags, the runtime pin and guard observations return.
Main accepts one exact result and reports success only after observed process exit.
Cancellation and deadlines revoke the result and still wait for the child to drain.

`independentlyVerified` means a separate keyless process using the **same pinned
verifier and verification key**. It does not mean a separate cryptographic
implementation or independent authentication of an operation. The checkpoint
index and list key are not circuit public signals: the digest binds their supplied
values but does not verify their meaning. Ownership, source/membership authenticity,
root acceptance, metadata authentication, disclosure and spending flags stay false.
A later controller must compare the payload with independently captured account
and source evidence and revalidate current roots.

This is a main-wallet diagnostic, with no renderer/IPC or top-level responsibility
change. It accepts a private-account Railgun Sepolia `prover / poi-verify` context;
**the production enrollment allowlist currently refuses this pair**. The controller
slice must deliberately admit exactly this operation before using the verifier.
There is no production caller, key release, storage broker or network provider.
The existing artifact loader loads bounded WASM/zkey buffers as well as the vkey;
the unused buffers are wiped after verification settles. No dependency or policy
changed.

## Evidence

The [native report](qualification/railgun-poi-verifier-2026-10-04.json) records 41
matching source hashes. Actual synthetic transfer and unshield POI proofs are
produced through the local production prover. The proving utility exits before
the fresh verifier starts. Each operation then passes ordinary verification and
a changed-checkpoint-index characterization: verification still succeeds while
the payload digest changes. Four separately launched, well-shaped altered payloads
reject: proof coordinate, TXID root, POI root and blinded output/unshield marker.
The six verifier calls take 837 ms for transfer and 804 ms for unshield, excluding
proof generation. Reports omit payloads, proofs, roots and association digests.

The fixture uses public test keys and simulated inclusion/membership. No live
queries or submissions occur, and no authority is granted. Fifty-two tests across
three suites pass, covering broker shape/pins/digests, parent/caller cancellation,
late deadlines after a result, observed exit, signal padding, missing/vacuous
verification and artifact cleanup. The cancellation regression resolves the first
verification successfully after revocation and proves that no second verification
starts. Claude reviewed production and native evidence; Codex reviewed tests,
fixtures and the corrected cancellation boundary. Lint is clean. The prior full regression of
9,559 tests predates these two verifier modules.

Next: authenticated creator and current membership capture, controlled viewing-key
handoff, account/source/root reattestation and final disclosure. Live owned-note
queries remain subject to the pending disclosure authorization.
