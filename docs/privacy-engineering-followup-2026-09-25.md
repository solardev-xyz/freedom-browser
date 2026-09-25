# Wallet privacy: recovery and current SDK transport

Date: 2026-09-25. Follow-up to the [September 14 foundation](privacy-engineering-status.md). Production activation remains disabled; this work adds no wallet UI or live fund movement.

## Main and managed nodes

Merged `origin/main` at `2983dc62` into `feat/wallet-privacy-foundation` in `39003e39`. The only textual conflict was shutdown: privacy-session revocation now runs first inside main's revised `windDown()`. The new settings-search test was reconciled with our experimental row. Main's profile, node and renderer changes are retained.

Installed the merged lockfile with `npm ci`, then explicitly refreshed the downloaded nodes and required bundled assets. No independent npm dependency or node pin was changed by the privacy work.

| Component | Installed/verified version | Verification |
| --- | --- | --- |
| Electron | 44.4.5 | Installed-version guard and unsigned packaged Electron tests |
| Ant | 0.5.45 | Pinned checksum download, all published targets; host `antd --version` |
| Myotis | 0.1.11, ABI 29 | Official pinned addons, all published targets; host constructor checks; supervisor rebuilt |
| Radicle | 0.7.1 | Host addon downloaded against pinned checksum manifest |
| freedom-ipfs | 0.4.3 | Pinned host asset installed in development and packaging locations |
| Arti | 2.6.0 | Existing host executable reports the current main pin; no version change |

`npm run check-binaries` passes. Adblock lists and scriptlet resources were refreshed too. Version pins in the repository govern this synchronization; it is not an independent upgrade to arbitrary upstream releases. The [binary playbook](agent-playbooks/bundled-binaries.md) now records this post-merge step explicitly.

## Durable submission tracking

`wallet/private-submission-journal.js` replaces the transaction experiment's session-only attempted-hash set with an encrypted write-ahead record. The record contains hash, nonce, attempt time and whether the RPC acknowledged the submission. It contains no signed transaction bytes, mnemonic or private key.

The active vault derives a domain-separated local encryption key. Storage binds the profile/account/chain/context; normal restarts and lock/unlock reconstruct the same journal in the same profile directory. `privacy-storage.js` adds a synchronous read/modify/fsync/rename operation so two adapters in the owning main process cannot race past the reservation. The application already owns the profile's process lock; the primitive is not a standalone multi-process database.

Before broadcasting, the journal must durably record the attempt. A pre-handoff storage failure prevents broadcast. A lost response or failure to persist the acknowledgment returns an unknown outcome and the deterministic hash. Lock revokes the old capability. After reopening, the recorded hash permits receipt lookup through a fresh context. New signing is blocked when a submission is recorded, and the same hash cannot be submitted again through the experimental route. Review expiry is checked again at the broadcast boundary.

**This is recovery tracking, not complete reconciliation.** The current gate conservatively blocks further sends even after an RPC acknowledgment; unverified receipts do not clear it. The next stage must integrate the transaction recorder, chain/finality/reorg evidence and an explicit reviewed resolution/replacement policy. Receipt polling remains unlocked-session work. No background unlocked signing or automatic resubmission was introduced.

The storage format is experimental and versioned. Profile relocation, seed replacement, backup migration, deletion/rollback detection and hostile local modification are not solved by AES-GCM or atomic rename. No promise of seed-only submission-history recovery is made. Windows durability and cross-platform crash testing remain pending.

Tests exercise a real child-process exit immediately after reservation, fresh-session restoration, lock, concurrent adapters, mismatched profile/key, corrupt state, failure before rename, failure saving the RPC acknowledgment, changed transaction attempts, and recovery of a lost-response hash for receipt queries. An Electron test uses the real vault and profile, then closes/relaunches the application and recovers the encrypted record; it passes in both source and packaged macOS builds.

## Kohaku changed upstream

On September 24, [Kohaku commit `8ac0c52`](https://github.com/ethereum/kohaku/commit/8ac0c528f63e1d43be7b662a1f2f7c15514ca61e) deprecated the Rust implementations and removed the previous Railgun package from the current tree. Our earlier pinned Railgun/WASM loading result remains valid historical evidence, but does not qualify the current upstream SDK. Do not extend or adopt that old runtime by default merely because its loading test passed.

The inspected current host still exposes [`network.fetch`](https://github.com/ethereum/kohaku/blob/8ac0c528f63e1d43be7b662a1f2f7c15514ca61e/packages/plugins/src/host/index.ts). Freedom now provides `networks/kohaku-network.js`, a main-owned capability backed by the authenticated Tor transport:

- A private-account context, Sepolia and an explicit ASP/indexer/relayer/artifact role are required, behind the development gate.
- Main selects reviewed HTTPS origins, paths, methods and optional fixed public pool scope. URLs cannot carry userinfo; cookies, authorization, referrer and arbitrary identifying headers are refused. Query contents remain visible to the endpoint.
- String/byte request bodies are bounded to 1 MiB; buffered responses to 4 MiB. The supported fetch subset provides standard `Response` JSON/text/bytes access, GET `Request` objects and caller cancellation. Streaming request bodies and unsupported fetch options fail explicitly.
- TLS is verified, destination DNS stays with SOCKS, redirects/compression/retries/direct fallback are refused. Tor replacement or vault lock revokes the capability. Returned cookies are stripped.

The current upstream Tornado relayer client was compiled from its exact pinned Git blob into a scratch fixture, then exercised through this adapter using local SOCKS/TLS responses. Both status GET and a synthetic withdrawal-shaped POST passed. **This is host-interface interoperability evidence, not Tornado integration or a change to our PPv2 target.** No real relayer or on-chain transaction was contacted. Source/build digests are in [the qualification report](qualification/kohaku-network-macos-arm64-2026-09-25.json).

Reproduce with `node scripts/spike-kohaku-network.js /absolute/kohaku/checkout` at revision `8ac0c528f63e1d43be7b662a1f2f7c15514ca61e`, then set `FREEDOM_KOHAKU_CLIENT_FIXTURE` to the emitted `.cjs` path when running `src/main/networks/kohaku-network.test.js`. It uses the repository's existing esbuild; no protocol dependency was installed in the application. The optional upstream test skips without that fixture; all adapter boundary tests still run.

## Current egress inventory and next gates

| Surface at inspected revision | Evidence / next work |
| --- | --- |
| Host ASP/relayer HTTP | Explicit injection exists. Adapter and current relayer-client fixture pass. Validate complete operation-specific endpoints and payloads before granting capabilities. |
| Chain provider | Separate `host.provider` surface. Our public transaction/balance RPC restrictions do not cover private pool log scans or arbitrary protocol calls. Add method/contract/range capabilities; do not grant unrestricted EIP-1193 access. |
| External synchronization | Host adds `externalSyncProvider`; Privacy Pools also has a Saga-backed log-source path. Review its fetches, manifests, integrity checks and fallback before enabling it. |
| Proving artifacts | Tornado's default circuit loader still calls ambient fetch, with an injectable `artifactsLoader`. Privacy Pools has a `proverFactory` dependency boundary. Require pinned local artifacts or a qualified bounded loader; the 4 MiB HTTP adapter is not a large-artifact solution. |
| Workers/provers | Passing this host adapter is not an OS network sandbox. Qualify every worker/library path and cancellation/resource limits before loading real secrets. |
| Railgun | Select and review a maintained adapter/runtime after upstream's Rust deprecation; do not assume the old package is the current route. |
| PPv2 | The currently inspected Kohaku Privacy Pools implementation identifies itself as PPv1. The public `@privacy-pools-v2/sdk/latest` npm endpoint returned HTTP 404 again on September 25. PPv2 source/SDK/artifact access remains unresolved. No PPv1 shipping phase is implied. |

Source anchors: [PPv1 host wiring](https://github.com/ethereum/kohaku/blob/8ac0c528f63e1d43be7b662a1f2f7c15514ca61e/packages/privacy-pools/src/plugin/base.ts), [Saga log source](https://github.com/ethereum/kohaku/blob/8ac0c528f63e1d43be7b662a1f2f7c15514ca61e/packages/privacy-pools/src/data/saga-log-source.ts), [Tornado artifact loader](https://github.com/ethereum/kohaku/blob/8ac0c528f63e1d43be7b662a1f2f7c15514ca61e/packages/tornado-cash/src/utils/circuit-loader.ts). The plugins package still lacks a license field in the inspected package manifest; distribution approval remains open.

## Validation

- Lint and `git diff --check` pass.
- Full regression with the upstream client fixture: **5,519 passed, 25 skipped, 3 baseline failures**. Those same two settings shortcut cases and one Safe fork case were reproduced against an untouched archive of current main `2983dc62` (42 passed, 3 failed in the two affected suites).
- Source Electron: **3 passed** (balance behavior, settings in both themes, real-process journal recovery).
- Packaged macOS arm64 / Electron 44.4.5: **4 passed**, including executable preflight and the same three scenarios.
- The new work does not requalify all live Tor/platform/SDK egress. The September 14 live Arti result is still scoped to its original probe.

Local logs: `/private/tmp/freedom-sep25-final-tests.log`, `/private/tmp/freedom-sep25-baseline-tests.log`, `/private/tmp/freedom-sep25-final-lint.log`, `/private/tmp/freedom-sep25-electron.log`, `/private/tmp/freedom-sep25-packaged.log`, and `/private/tmp/freedom-sep25-package-final.log`. No changes were pushed or published.
