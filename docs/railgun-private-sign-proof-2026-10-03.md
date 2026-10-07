# Separate Railgun spending signer and proof verification — October 3, 2026

**Later October 3 key-request binding:** B now sends the independently checked
transaction digest and reconstructed message hash in its exact binary-key request.
Main matches both before any key copy or future durable signing transition. The
normalizer returns data only; operation ownership, fresh gates and one-use release
remain mandatory. [The updated synthetic qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-signer-request-2026-10-03.json)
passes all six ordinary/cold proofs and rejects two altered key-request fields with
zero key transfers. Forty-eight focused signer/result/policy tests pass; lint is
clean. This does not add a production vault-signing controller or change the wallet
policy closure. Earlier evidence below remains historical.

The guarded spending-sign utility now signs the narrow Sepolia private-transfer
and WETH-unshield intent. A synthetic preparation process uses its signature in a
real 1×1 circuit, and a fresh process verifies the resulting public transaction
without receiving the witness. No live vault-signing API or funded private
transaction is enabled by this slice.

## Boundaries

Before asking for any key, the signer requires canonical calldata with an
all-zero placeholder proof, repeats the host's transaction policy, reconstructs
the SDK HardwareWallet signing message and matches the expected hash. For an
unshield it also recomputes the output commitment from recipient, WETH and gross
amount. Only then does it request one binary spending key through the exact
`keystore / spending-sign / railgun-spend-sign-job` supervisor allowlist entry.
The derived public key must match; the utility signs once, verifies the EdDSA
signature and wipes its received buffer before returning the result.

The spending key never reaches the preparation/proving process. The signer has
no viewing key, note database, RPC or POI interface. Checking ownership, private
transfer recipient/value, required-list POI and durable reservation authority
remains the account operation's responsibility. A valid signature is not proof
that those checks happened. Signatures and pending calldata must stay internal
because they accompany a not-yet-public nullifier.

Main normalizes the result's exact schema, pinned inventory, message and intent
digest, zero-attempt guard evidence, field-encoded R8 coordinates and subgroup-
bounded S. It copies and freezes the returned data. These normalizers do not
issue operation receipts or cryptographically reverify EdDSA in main.

After proving, the final calldata must match the signed intent byte for byte
after replacing its eight proof coordinates with zeros. The separate verifier
repeats that match, refuses noncanonical BN254 base-field coordinates, reverses
the contract's G2 coordinate order and verifies the four public signals using
the pinned 1×1 verification key and authenticated serial prover. Its result is
also normalized against the final transaction digest and pinned prover hash.
It loads the full artifact set, although verification uses only the vkey; a
vkey-only loader remains a possible memory improvement.

These utilities remain within the main wallet service and its existing guarded
utility-process boundary. No renderer channel, dependency change or top-level
package change is introduced.

## Qualification

[The source-bound Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-sign-proof-2026-10-03.json)
records both synthetic transfer and unshield cases using the packed engine and
independent prover. Preparation receives only a synthetic spending public key
and its synthetic viewing material. It builds the real SDK transaction request,
asks a separate utility for the signature, and proves and verifies the request.
An additional signer signs a changed-root intent; that otherwise valid signature
is rejected when supplied to the original circuit witness. A fresh verifier then
accepts the real proof and refuses an all-zero proof for the same intent.

Both cases pass, including the main-side result normalizers. Additional signer
negative controls refuse a changed message and wrong chain before any key
transfer, and a mismatched public spending key after receiving and wiping one
synthetic key. Each successful signer receives exactly one key. Host buffer
wiping is observed directly; job-side wiping is covered by unit tests and source
review, not a claim that every runtime/library allocation has been erased.

The complete synthetic cases take 2.6–2.8 seconds each, including two signing
utilities and two verifier runs. This does not include real wallet restoration
or POI latency. The report's `proofElapsedMs` includes the negative-signature
exercise and its second signer, so it is not an isolated proving benchmark.
Memory figures are sampled process RSS under soft supervisor limits. No account,
network, POI service, reservation, EOA signature or submission is involved.
The final run's sampled maxima were 399,998,976 bytes for preparation/proving,
159,055,872 for signing and 110,018,560 for the fresh verifier.

The first full regression exposed the verifier's direct import of the already
authenticated prover entry. The shared architecture check requires external
entry imports to remain in their verified loaders. That import now lives in
`loadRailgunProverRuntime`; tests cover authentication before execution, and the
synthetic qualification was repeated against the corrected sources.

The corrected native regression passes 8,511 tests (33 skipped); 126 focused
tests and lint pass. Claude reviewed the implementation, loader fix and scope
claims. This engineering review is not a security audit.

## Remaining composition

A genuine account-owned preparation window must re-establish the selected note
against the captured checkpoint while retaining the private witness inside the
guarded process. Existing wallet receipts intentionally expire when the exclusive
snapshot window opens; they cannot be reused to authorize signing inside it.
The operation must reserve the input durably and validate fresh POI before
releasing a vault spending key to this exact signer. It must observe both utility
exits before closing the window and reissue wallet/journal evidence afterward.

Before EOA signing, require witness-free proof verification, fresh deployment
and on-chain verification-key equality, root-history and unspent-nullifier
checks, and successful simulation. A reverted private transaction still exposes
its nullifier. Journaled handoff, uncertain-result recovery, inclusion/event
reconciliation, post-transaction POI and cold output recovery remain necessary
for funded transfer/unshield completion. Self-funded submission exposes the
funding EOA as the gas payer.
