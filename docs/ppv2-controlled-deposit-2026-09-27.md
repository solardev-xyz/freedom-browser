# PPv2 controlled native deposit

**Historical checkpoint:** [September 28 review fixes](privacy-review-fixes-2026-09-28.md) update the status of the recovery, registration, quote and proof-verification limits described below. Session verification runs in the producer process; the standalone relay fixture separately qualifies an independent verifier.

Date: 2026-09-27. Continues [controlled session assembly](ppv2-controlled-session-2026-09-26.md). Main was fetched and remains already merged at `2983dc62`; no merge or managed-node refresh was needed. No application dependency or renderer API was added.

## What now works

The real patched Kohaku factory and pinned SDK can prepare a native-ETH deposit using Freedom's managed utility-process prover. The main-owned session accepts an explicit amount and maximum fee, supplies restricted RPC reads, and returns a frozen transaction bound to Sepolia, the configured public owner and Entrypoint. It neither signs nor broadcasts.

The optional proving configuration is supplied by reviewed main-process code: local artifact directory, SDK entrypoint and an optional progress callback. A session without this configuration retains its earlier read/registration-only behavior. The application still installs no PPv2 SDK; qualification bundles the already-built private SDK and patched Kohaku adapter into a separate scratch ASAR. Production remains disabled.

`ppv2-deposit-prover.js` implements only the deposit portion of the SDK proof-service interface:

- Main opens a single preparation intent and permits one proof request for the native token and exact amount. The amount must be positive and less than 2¹²⁸, matching the circuit. Only the five reviewed scalar witness fields are accepted and copied before asynchronous work.
- The deposit WASM, proving key and verification key are loaded locally with exact size/SHA-256 pins from SDK revision `fe0244e3`. They are checked again inside the child. There is no download fallback or alternate circuit.
- The child receives the witness, public artifacts and reviewed SDK path. It receives no mnemonic, signer, vault, protocol storage or network capability. The existing host enforces cancellation, process termination, result size, heap and sampled RSS limits; its network/process guards remain safeguards for reviewed code, not an OS sandbox.
- The SDK generates **and verifies** the actual Groth16 proof in the child. Main checks proof shape, curve/protocol, coordinate/scalar bounds, public signal count, token, amount and context. Only that immutable issued proof can be converted to EVM format within the preparation.
- Main decodes the resulting deposit call and requires exactly one transaction to the reviewed Entrypoint, no approval/extra transaction, and a value between the requested amount and amount plus fee cap. It checks the EVM proof against the accepted proof, the note-data hash against the proof context, bounded nonempty note/ASP ciphertexts, and canonical ABI encoding without trailing data. It returns fixed sender/chain/target fields, `proofVerified: true` and **`chainStateVerified: false`**.

These checks bind the prepared transaction to the accepted proof and note-data context. They do not independently establish the correctness of SDK note encryption, authenticate the ASP's operator identity, prove remote asset configuration, or verify the deployed contracts against an audit. The reviewed SDK still owns note construction/encryption. Private witness strings in JavaScript cannot be guaranteed to be erased; no witness, signature, proof or calldata is written to the qualification report.

## Qualification

The new Electron test imports only the established public test mnemonic into an isolated test vault. It uses the real Kohaku factory, SDK, restricted provider, encrypted session store, process host and local artifact loader. Chain responses are controlled at the private-RPC dependency; the test is not a Tor or live-Sepolia measurement. The ASP public key is pinned, so deposit preparation requires no ASP HTTP request. A test-local gate override permits exercising the packaged code; the actual packaged production gate remains false.

Source Electron passes. Packaged macOS arm64 also passes, including executable preflight, with the job/host loaded from the application ASAR and SDK/adapter loaded from the isolated SDK ASAR. Packaged session, bridge, policy and job bytes were compared with the tested source and match exactly.

The packaged flow prepared both registration calls and a real deposit of **10,000 fixture wei**, with a 100-wei fee and total value 10,100. Preparation took **431 ms** in this run, excluding session creation; this is not a performance guarantee. The note announcement contains 196 bytes and ASP ciphertext 394 bytes. No transaction was submitted.

The test also rejects an excessive fee, closes/reopens encrypted session state, locks the real vault after proving starts, checks that the child is gone, unlocks and proves again, then corrupts a local artifact and confirms refusal before another prover starts. Only block-number, contract-read and log-read RPC methods were observed.

Validation:

- **23 focused unit tests pass**, including rejection of witness widening, changed amounts/contexts/coordinates, arbitrary proof formatting, wrong transaction targets, additional approvals, changed note data, trailing calldata and excessive fees.
- Full regression: **5,590 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork integration case).
- Source Electron: **1 passed**. Packaged Electron: **2 passed**, including executable preflight.
- Lint and whitespace checks pass. Application package/lock files are unchanged.

See [the qualification report](qualification/ppv2-controlled-deposit-2026-09-27.json). Logs are `/private/tmp/freedom-ppv2-deposit-{unit,regression,lint,build,electron,packaged}-sep27.log`; the packaged Playwright report is `/private/tmp/freedom-ppv2-deposit-packaged-sep27.json`.

Reproduce after preparing the pinned source/typecheck fixtures:

```sh
node scripts/spike-ppv2-process.js /absolute/ppv2 /absolute/generated-compat-directory
```

Use the emitted ASAR path as `FREEDOM_PP_V2_PROCESS_ASAR` for `test-e2e/ppv2-deposit.spec.js` in the harness and packaged projects. The optional second argument adds the real Kohaku factory, ABIs and controlled configuration to the scratch artifact; the earlier process-only probe remains supported.

## Remaining work

The next boundary is wallet signing/review and recovery from a mined deposit: validate registration and deposit handoff through the public transaction lifecycle, then discover a note from its encrypted announcement, persist it and recover after restart/reorg. The native preparation result is main-only and has not been wired into an approval UI or generic send action.

ERC-20 deposits remain unavailable. The pinned SDK can return a zero-reset approval followed by the actual approval in `approvalTxs`, while the Kohaku candidate maps only the legacy final `approvalTx`. Correct and test the complete sequence before exposing that path; native-only qualification avoids making an unsupported ERC-20 claim.

Private transfer/unshield needs its own circuit qualification and durable relayer-operation journal before any submission. Final identity constants, audit/deployment matching, unverified chain/ASP-state policy, distribution review and platform coverage remain production gates. No UI feedback or funded smoke test is required for the next infrastructure work.
