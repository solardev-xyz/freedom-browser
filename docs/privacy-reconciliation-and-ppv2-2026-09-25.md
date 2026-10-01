# Wallet privacy: reconciliation and PPv2 integration boundaries

Date: 2026-09-25. Continues the [recovery and SDK transport work](privacy-engineering-followup-2026-09-25.md). Main was fetched again and remains `2983dc62`; the branch already contains it. No dependency, lockfile or node pin changed, so the previous explicit node refresh remains current. All new capabilities are main-owned; there is no new IPC, UI or production activation.

## Submission reconciliation

The encrypted journal now retains versioned observations and an explicit reviewed resolution alongside the original attempt. Old version-1 attempt records still load and remain blocked. Neither polling nor an RPC acknowledgment silently permits another send.

| Observation             | Meaning and effect                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`               | Neither receipt nor transaction is returned. It may still have been submitted; keep the gate closed.                                                                      |
| `pending`               | A matching transaction is returned without a receipt. No inclusion claim.                                                                                                 |
| `included` / `reverted` | Receipt, block-at-height and head agree at this RPC; record block hash, height and confirmation depth. These are **unverified observations**, not cryptographic finality. |
| `reorged`               | Inclusion disappeared or the reported canonical block/head contradicts it. Any previous resolution is revoked.                                                            |

Main must supply a positive confirmation threshold and a review callback to `resolveSubmission`. The immutable review states the transaction, nonce and unverified evidence. Approval must explicitly return `{ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }`; a bare `true` is refused. Evidence is fetched again after review, with an expiry and scope cancellation. Changed inclusion, insufficient depth, rejection or timeout leaves the gate closed.

Every subsequent send rechecks all resolved records before signing and again before broadcast. Missing or changed evidence closes the gate; network failure prevents progress. A previously attempted hash cannot be broadcast again, and the next nonce must exceed all recorded nonces. Concurrent observations use journal revisions so an older delayed response cannot overwrite newer state. The review releases the next-send gate only: it never retries, replaces, removes, or declares finality for the original transaction.

This deliberately conservative prototype remains capped at 64 attempts per account. No replacement/cancellation policy, history compaction, background locked polling, proof-backed finality, or integration with the ordinary wallet's transaction recorder is implemented. Persisted permission is bound to the experimental profile-local journal, not seed-only recovery. Product wording and approval UX remain undecided.

## Restricted protocol reads

`networks/kohaku-provider.js` supplies a read subset of Kohaku's provider for a separate private-account `protocol-rpc` context. Main grants contract addresses, read selectors and event signatures. Calls, code reads, head/chain lookup and raw log queries use the authenticated Tor RPC route and retain unverified trust metadata.

Event queries require a known contract and event topic, explicit bounds of at most 5,000 blocks, at most 2,048 returned logs, valid full log metadata, and no removed logs. `latest` resolves to a concrete head before the scan. Indexed-account filters and arbitrary methods are refused. Grants and request parameters are copied before asynchronous work. `_internal` exposes only the same restricted request function.

The inspected PPv2 adapter uses raw `request` for calls/logs and the head convenience method, which this subset supports. Its write-flow receipt/wait methods intentionally fail until an operation-scoped receipt capability is connected to the submission journal. This is not a drop-in qualification of the entire `EthereumProvider` interface. Main still needs to review exact selectors/calldata and deployment grants; response shape checks do not verify chain truth or prevent inference from query contents/timing.

## Artifact and worker controls

`wallet/privacy-artifacts.js` loads only main-selected local files with a pinned SHA-256 digest and exact size. No fetch or gateway fallback occurs. Names cannot traverse directories; final symlinks are refused. Each file is limited to 256 MiB, with at most two active loads. Lock/caller cancellation discards late bytes. Actual deployment manifests and their provenance remain a separate qualification input; matching a supplied digest alone establishes neither safety nor an audit.

`wallet/privacy-worker.js` supervises a main-selected worker entry point. Lock, caller cancellation, deadline, worker errors or premature exit fail the job; success and failure await termination before releasing capacity. At most two workers run, with a configurable bounded JS heap and a maximum two-minute lifetime. Workers get no inherited environment or command-line flags, and their stdout/stderr are drained without forwarding runtime logs.

Tests use a CPU-bound synthetic worker that never cooperatively checks abort and verify its shared counter stops. This establishes the lifecycle boundary in Node and packaged Electron. **It does not qualify an actual prover, sandbox filesystem/network access, bound native/WASM allocations, or guarantee erasure of all secret copies.** Review a concrete runtime and its egress before passing secrets. Consumers must also recheck their context at any later state-write boundary.

## PPv2: a concrete upstream candidate

The earlier npm 404 was for the documentation's old package name. It did not establish availability of other packages. [Kohaku PR #258](https://github.com/ethereum/kohaku/pull/258), open when checked, contains a substantive PPv2 implementation at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. This is an integration candidate, not merged-current-master support.

- Its [package manifest](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/privacy-pools/package.json) names optional SDK `@0xbow-io/privacy-pools-v2-sdk@0.2.0-beta.0`. The [registry configuration](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/.npmrc) routes that scope to GitHub Packages. An unauthenticated request to that exact registry returned **401**. No credentials were sought or used; package access and SDK redistribution rights remain unresolved.
- The [session assembly](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/privacy-pools/src/v2/session.ts) injects RPC, HTTP and storage adapters. This provides a specific host boundary to evaluate instead of inventing a parallel v2 adapter prematurely.
- The [RPC adapter](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/privacy-pools/src/v2/adapters/rpc.adapter.ts) reads full raw logs and scans 5,000-block windows. Its error-driven recursive bisection must be constrained: capability refusal/cancellation must not become thousands of retries. Freedom's provider itself performs no retry.
- The [sample configuration](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/examples/ppv2-sample-app/src/wallet/config.ts) contains circuit CIDs and digests. They are review inputs, not automatically adopted production artifacts. Size, current deployment/verifier correspondence and provenance still need qualification.
- The [sample README](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/examples/ppv2-sample-app/README.md) explicitly distinguishes a stub-prover devnet from live Sepolia. It also documents recovery approximations and a transfer failure against an older SDK/staging combination. Its claims need reproduction against one pinned matching stack; running the demo would not demonstrate real proving or full chain recovery.

The exact PR HTTP adapter was compiled without its type-only SDK imports and exercised through Freedom's host network adapter over local SOCKS/TLS. JSON GET/POST, bounded binary responses, cancellation and refused authorization headers pass. No SDK installation, real circuit proof, relayer request or on-chain operation was performed. Source/build digests are in [the PPv2 boundary report](qualification/kohaku-ppv2-boundaries-2026-09-25.json).

Reproduce with `node scripts/spike-kohaku-ppv2.js /absolute/kohaku/checkout` containing that PR commit, then set `FREEDOM_PP_V2_HTTP_FIXTURE` to the emitted file when running `kohaku-network.test.js`. Existing esbuild is sufficient; no app dependency was added.

## Next implementation gates

1. Obtain legitimate SDK/source access and establish dependency/license provenance; compare/rebase PR #258 against current Kohaku before selecting exact versions. Continue evaluating a maintained Railgun implementation independently of the removed Rust package.
2. Review one matching Sepolia deployment, signer derivation vectors, registration flow, ASP/relayer endpoints and artifact set. Grant exact capabilities; connect reviewed local artifacts and the qualified prover worker. Measure memory, proving time and egress rather than increasing limits speculatively.
3. Add operation-scoped receipt tracking and durable relayer-operation identity/uncertainty handling. Do not adopt high-level re-relay behavior simply because upstream permits it. Test note reconciliation and from-chain restoration separately from exported-cache restoration.
4. Run shield → sync/approval → reviewed unshield with synthetic accounts in a disposable test environment, including restart/recovery. Private transfer has a separate acceptance gate. UI/UX and production activation follow these technical results.

## Validation

- Full regression: **5,555 passed, 25 skipped, 3 baseline failures**. The failures remain the two macOS shortcut-remap cases and Safe fork case previously reproduced on unchanged main. This run preceded the additional optional PPv2 HTTP fixture test.
- Final focused privacy suites, with both pinned upstream HTTP consumers: **76 passed**.
- Source Electron: **5 passed**. Fresh unsigned packaged macOS arm64/Electron 44.4.5: **6 passed**, including packaged preflight.
- Lint and diff whitespace checks pass. No application dependency or managed-node version changed.

Local evidence: `/private/tmp/freedom-reconciliation-full-tests-permitted.log`, `freedom-reconciliation-focused-tests.log`, `freedom-reconciliation-electron.log`, `freedom-reconciliation-packaged.log`, `freedom-reconciliation-build.log`, and `freedom-reconciliation-lint.log` in the same temporary directory. The earlier restricted full run was stopped after denied localhost/native operations; its failures are not the qualified regression result.
