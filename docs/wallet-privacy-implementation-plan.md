# Wallet privacy implementation plan

Date: 2026-09-14; updated 2026-09-27. Status: current main and managed nodes synchronized; reviewed submission reconciliation, restricted protocol reads, local artifact verification and worker cancellation have unit and Electron coverage. Complete protocol qualification and production activation remain pending.

## Implementation status

**Latest September 27 continuation:** [Reviewed public handoff and note recovery](ppv2-lifecycle-2026-09-27.md) binds issued operations to sender/calldata/fees/deadlines, serializes registration, persists operation fingerprints before submission and restores uncertain deposits plus real encrypted notes across a new Electron process. Full rescan reports discrepancies without replacing the cache. Source and packaged macOS pass; 56 focused tests pass and full regression has 5,605 pass, 33 skip and the same 3 baseline failures. Next: private-operation circuits, durable relayer recovery, ASP/ERC-20 coverage and live qualification. Older dated “next” statements below are historical.

**September 27 deposit continuation:** [Controlled native deposit](ppv2-controlled-deposit-2026-09-27.md) connects the real Kohaku/SDK session to the utility-process prover, with exact local artifacts, proof verification, native amount/fee bounds and prepared-calldata checks. Real deposit preparation, vault cancellation, reopen-after-unlock and corrupted-artifact refusal pass in source and packaged macOS Electron. Full regression: 5,590 pass, 33 skip, the same 3 baseline failures; 23 focused unit tests pass. Next is reviewed wallet transaction handoff and encrypted-note recovery. ERC-20 approval sequencing, relayer journaling, live deployment qualification and production activation remain pending.

**Latest September 26 continuation:** [Controlled Kohaku PPv2 session](ppv2-controlled-session-2026-09-26.md) assembles a restricted signer, encrypted/version-bound state and separate RPC/ASP/relayer capabilities. The real factory prepares registration calls and restores a sync cursor against controlled services. Owner/signer rotation recovery, stale cached indices, unsafe log retries and the SDK manifest-format mismatch are corrected. Full regression: 5,574 pass, 33 skip, the same 3 baseline failures; final focused tests: 38 pass. Next: connect the process proof service and qualify registration/shield preparation in Electron, then durable relayer recovery and a recoverable Sepolia flow. No live transaction or production activation is claimed.

**September 26 implementation:** [Adapter compatibility and prover process host](ppv2-adapter-process-2026-09-26.md) adds a pinned Kohaku finality/pending-exit patch and an Electron utility-process host with vault cancellation, forced termination, bounded results, sampled memory limits and inherited network guards. The patched adapter typechecks; real deposit proving, cancellation, restart-after-unlock and egress refusals pass in source and packaged macOS. Full regression: 5,573 passed, 25 skipped, the same 3 baseline failures; final focused checks: 36 passed. Next is a controlled session and recoverable Sepolia flow, while final identity constants, audit/deployment matching and state provenance remain gates. No application SDK dependency or product UI was added.

**PPv2 source qualification:** [The accessible SDK experiment](ppv2-sdk-qualification-2026-09-25.md) pins 0xbow `v2.0` at `fe0244e3`. SDK build and 96 upstream tests pass; four independent derivation cases and a separate-process deposit proof verify. Kohaku PR #258 needs finalized-block and `EXIT_PENDING` support, and its prover dependency fails inside our Node worker. Next: a narrow adapter update and a qualified main-owned process prover host, then a controlled session and recoverable Sepolia flow. Final `APP_IDENTIFIER`, audit/deployment matching, full egress and recovery remain release gates; no application SDK dependency or wallet flow was enabled.

**Earlier September 25 host work:** [Reconciliation and PPv2 boundaries](privacy-reconciliation-and-ppv2-2026-09-25.md) records explicit review of unverified inclusion, reorg invalidation, restart recovery, bounded protocol reads, pinned local artifacts and forced worker termination. Full regression: 5,555 passed, 25 skipped, the same 3 baseline failures; final focused suites: 76 passed. Source Electron: 5 passed; packaged macOS: 6 passed. Open Kohaku PR #258 is now a concrete PPv2 candidate; its exact GitHub Packages SDK returns 401 without authentication. SDK access/provenance, deployment grants, actual prover egress/memory and recoverable shielded operations remain gates. The removed Railgun runtime is not the default continuation target.

**Earlier September 25 work:** [Recovery and SDK follow-up](privacy-engineering-followup-2026-09-25.md) records main/node synchronization, the encrypted attempt journal and host HTTP transport. Its remaining-work list is superseded where the newer report records completion.

**September 14 handoff:** [Wallet privacy engineering status](privacy-engineering-status.md) records the original live circuit evidence, packaged results, transaction hooks and Kohaku runtime findings. Its counts and the chronological Step 1–3 notes below preserve their original scope.

Step 1 adds `src/main/networks/privacy-context.js` and the wallet-owned `privacy-session.js`. `openPrivacySession()` requires an active profile and unlocked vault. Its scope creates opaque context handles, limits allocation to 256 contexts and 32 pending tasks, and exposes cancellation-aware `run` plus a synchronous `commit` guard. Consumers must pass the task signal to their I/O, return results without unchecked writes, then validate the handle again at the state-write boundary. These guards cannot stop side effects inside an uncooperative task; the Step 2 transport below also honors cancellation at the socket boundary.

The authoritative vault supplies a revocable session signal. Manual lock, automatic lock, replacement unlock, and application shutdown revoke privacy work. A decrypt completing after a lock cannot reopen the vault. Current profile ownership is checked before context use; the runtime is process/profile scoped, with shutdown wired before asynchronous application teardown.

The router accepts a separate `privacyContext` option. Context-bound reads remain unavailable unless the Step 3 development gate and balance-specific eligibility checks pass. Forged, revoked, or wrong-chain handles fail earlier. Ordinary requests retain their existing route selection. Requirements record origin/content/correctness/freshness separately; they do not assert protection has been delivered. The Step 3 setting is unavailable in packaged builds; no dependency was added.

Step 1 validation: `npm run lint` passes. `npm test -- -- --runInBand` reports 4,308 passed, 10 skipped, and 3 failed tests across 223 passing suites, 3 skipped suites, and 2 failing suites. All new tests pass. The two shortcut-remap failures in `settings-store.test.js` and the Safe fork send-orchestrator failure were reproduced against an unchanged `HEAD` archive. The full run also emitted asynchronous websocket logging warnings. The baseline failures were not changed as part of this work.

### Step 2 implementation and qualification

`tor-manager.getWalletSocksEndpoint()` now supplies an immutable loopback endpoint, generation, and revocable signal only after managed Arti bootstrap and successful startup. Stops, crashes, errors, and replacement starts revoke it. External SOCKS remains available for its existing browsing use but supplies no qualified wallet endpoint.

`networks/isolated-socks.js` implements only authenticated SOCKS5 CONNECT to that loopback endpoint. It advertises method 2 exclusively, sends the Tor format-0 username and opaque context token, and supplies the destination name to Arti. It bounds negotiation, handles fragmented replies, and aborts on cancellation, malformed replies, or authentication downgrade. There is no destination DNS lookup in Node.

`networks/wallet-tor-transport.js` owns context-specific HTTP/HTTPS agents and tracks pending sockets through SOCKS and TLS setup. Context revocation, endpoint revocation, and transport shutdown destroy those connections. Inactive pools expire. HTTPS verifies certificates and hostnames; TLS bypass options are not exposed. Requests use a deadline and bounded buffers (1 MiB request, 4 MiB response). The initial API supports GET/POST, DNS/IPv4 destination names, and buffered bodies; it does not yet support IPv6 destination literals, streaming artifacts, HTTP2, or WebSockets. HTTPS is required by default; a main-only explicit HTTP option exists for controlled fixtures/future qualified use. No cookies, automatic redirects, retries, or direct fallback are provided. The transport refuses requirements for PIR, proofs/quorum, or freshness because it cannot establish those properties alone.

Dependency decision: use Node's existing HTTP/TLS clients plus a narrow CONNECT helper. The inspected [socks client](https://github.com/JoshGlazebrook/socks/blob/master/src/client/socksclient.ts) offers no-auth alongside username/password; the [proxy-agent wrapper](https://github.com/TooTallNate/proxy-agents/blob/main/packages/socks-proxy-agent/src/index.ts) does not expose a strict authentication requirement. Owning this small handshake also lets cancellation destroy its socket before negotiation completes. This does not introduce a general proxy server or protocol stack, and no dependency was added.

Controlled loopback tests cover distinct A/B tokens and sockets, same-A reuse, remote DNS, authentication downgrade/failure, malformed replies, stalled negotiation cancellation, active-response outage, deadlines, restart, idle expiry, lock cleanup, redirects, size limits, TLS trust/hostname failures, and redacted diagnostics. Test-only certificate/key material is a public fixture, never used by the application. These tests require permission to bind local listeners; they were rerun outside the restricted sandbox after its EPERM rejection. Lint passes. The full Step 2 regression run reports 4,321 passed, 10 skipped, and the same 3 baseline failures; the final focused transport/manager/context run passes all 44 tests after diagnostic hardening.

**Original Step 2 boundary:** loopback tests alone established connector/token behavior, not real circuit selection. The subsequent live macOS Arti probe observed separate A/B circuit groups and same-context reuse; see the engineering handoff. Complete packaged/platform egress qualification remains a release criterion. No user wallet traffic was used.

### Step 3 implementation and qualification

The existing `balance-service` and wallet balance IPC now dispatch to `wallet/private-balance-service.js` when `walletTorBalanceReads` is selected. The coordinator owns per-profile/session/address refresh deduplication and cache state. `networks/private-balance-router.js` owns RPC eligibility, payload checks, and transport use. These modules preserve existing main/renderer ownership; ordinary balance fetching keeps its current route selection.

The first route supports Sepolia native balances and ERC-20 `balanceOf`/`decimals` only. Metadata requests stay in the same account context to avoid a separate timing/egress path. Mixed-account calls, arbitrary calls, batches, other chains, PIR, quorum/proof requirements, and freshness requirements are refused. Myotis, Colibri, and ordinary quorum are ineligible because their egress is not mediated here. A configured read policy must permit the `direct` trust tier; this route never silently replaces a quorum-only policy. It selects one unkeyed HTTPS endpoint, excludes URL userinfo/query credentials, checks `eth_chainId`, validates RPC version/id/result, and does not retry or fall back. A manually configured URL can still embed an identifier in its path; use a genuinely public endpoint for qualification.

Responses retain `trust.level = unverified`, `method = direct`, no verified block, and explicit experimental transport evidence with circuit isolation marked unqualified. The observation timestamp is the response-receipt time, not proof of chain freshness. Native/token values preserve that time on failure. Separate persistent records are keyed by hashed profile and canonical account, with chain/token keys inside each snapshot. Ordinary-cache merges cannot change them. Cached startup reads do no network work; a cache hit is stale unless this live session has a successful recent observation from the current Tor endpoint generation. Tor outage, lock, profile change, and setting changes prevent late private writes. Renderer refresh generations and account/identity checks prevent superseded results from repainting another wallet.

Settings → Experimental contains **Tor balance reads (experimental)**. Packaged builds cannot enable execution, even if a settings file contains the flag. For controlled development, launch an unpackaged build with `FREEDOM_WALLET_TOR_EXPERIMENT=1`, use a disposable profile and synthetic accounts, configure Sepolia and a public HTTPS RPC through the existing chain registry, start bundled Tor, unlock the vault, then select the setting. It does not start Tor automatically. Selecting the mode makes other-chain balances unavailable. Sending, dApp RPC, node traffic, and other wallet operations retain their existing paths and are outside this experiment. The sidebar states the limited scope and displays stale/unavailable results.

Validation on macOS: `npm run lint` passes. Final unit regression: **4,342 passed, 10 skipped, 3 pre-existing failures** (the same two shortcut-remap cases and Safe fork case). Coverage includes context propagation, account deduplication/separation, source/protection refusals, malformed responses, no fallback, late completion after lock, profile cache separation, observation timestamps, renderer account-switch races, and the packaged gate. **Two Electron tests pass** using real wallet IPC, balance/router code, a controlled SOCKS peer, and a local TLS RPC fixture: distinct A/B credentials, ERC-20/native reads, outage/stale timestamps, restart, manual lock, automatic lock, and the disabled setting in both themes. The settings screenshots were visually inspected in dark and light. The SOCKS fixture is shared with the transport tests. Sandbox restrictions required rerunning Electron and loopback tests with approved local process/listener access.

Subsequent qualification: the live Arti probe and controlled packaged macOS balance checks passed, with measured bootstrap/request times and fetch/DNS tripwires. These are scoped observations, not a representative latency study or complete OS egress trace. Supported-platform qualification and Linux screenshot baselines remain pending. The production gate remains closed.

### Steps 4–5 technical progress

Main-only transaction hooks now bind nonce, gas, simulation, signing, submission and receipt polling to a context. Review binds the frozen populated transaction and expiry; signer output must match. Unknown submission outcomes retain a deterministic hash without automatic retry. Tests cover lifecycle cancellation and refusal boundaries. No UI/IPC activates these hooks. Durable submission/restart recovery and reviewed PPv2 public handoff now have controlled coverage. Product approval/recorder integration and live qualification remain necessary before this milestone is complete.

Restricted Railgun derivation and encrypted atomic storage primitives have behavioral tests. An isolated pinned Kohaku SDK bundle initializes WASM and reconstructs a synthetic address from ASAR in Node and packaged Electron. No SDK dependency was added to the application. Packaging work identified ESM import defects, an undeclared runtime dependency, missing plugins license metadata, and Rust/WASM network paths requiring mediation. Actual sync/proving/restore and complete egress coverage remain unqualified. PPv2 public SDK access is still unresolved. Exact versions, reports, limits and follow-up tasks are in the [engineering handoff](privacy-engineering-status.md).

## First deliverable

An experimental software wallet can refresh ETH and ERC-20 balances for two addresses on Sepolia through separate Tor isolation contexts. Repeated requests for one context can reuse its connections; unrelated contexts cannot. Tor failure stops the refresh without direct-network or destination-DNS fallback. Cached balances remain visibly stale. Manual lock, auto-lock, profile shutdown, and Tor restart cannot revive old work.

This establishes useful behavior in the existing wallet before adding shielded balances. It is an origin-privacy feature: the RPC endpoint still sees query contents and may correlate shared API credentials. It is not PIR or transactional privacy.

Use synthetic accounts and a disposable development profile first. Add Sepolia through the existing network registry/custom-chain mechanism for the experiment; it is not a current built-in default. Begin development/packaging qualification on macOS arm64, then qualify every supported target before enabling it there. An unavailable or unsupported Arti build means the feature is unavailable on that target.

## Scope and ownership

Preserve the README's process boundaries. Main-process services own policy, identity, approvals, persistence, and managed runtime lifecycle. Renderer code displays serializable state and sends narrow allowed intents. Protocol execution/proving may run in a main-owned worker or utility process, but receives only the capabilities it needs. That runtime is not an OS network sandbox by default.

| Existing area | Planned responsibility |
| --- | --- |
| `src/main/wallet/` | Privacy-account coordinator, capability descriptors, protocol adapters, operation review/state |
| `src/main/networks/` | Privacy contexts, controlled HTTP/SOCKS transport, route eligibility and response evidence |
| `src/main/tor-manager.js` | Arti lifecycle and trusted endpoint/readiness generation; reuse existing managed instance |
| `src/main/identity/` and `identity-manager.js` | Authoritative lock lifecycle, restricted protocol derivation and encrypted-state access |
| `src/main/wallet/transaction-service.js` | Existing public signing/review path, context-aware preparation and submission |
| `src/shared/ipc-channels.js` and existing preload | Only narrow UI-facing calls when the first surface is ready |
| `test-e2e/` | Electron and packaged integration checks; controlled network tests |

No change to public-account derivation or the Ant identity path. No migration of private keys into UI contexts. PPv2 remains the Privacy Pools target; PPv1 is optional reference coverage.

## Implementation sequence

### PR 1 — Context ownership and cancellation

Create a small context service under `src/main/networks/`, owned by the wallet coordinator. A context binds profile, session generation, canonical public address or private-account ID, chain, protocol/deployment, and service role. Allocate opaque random transport tokens in memory; never use addresses or derived keys as tokens. Keep private-operation contexts available for later withdrawal separation.

Add a privacy-context option separate from `routingContext.origin` in the chain-data router. The latter currently controls page-workload latency; using it for wallet identity would change routing behavior accidentally. Define requirements separately from evidence: origin transport, content privacy, minimum correctness/freshness, and permitted endpoint credentials. Unsupported requested protection fails explicitly. Do not implement a general policy language or PIR backend in this PR.

Publish cancellation from the authoritative vault lifecycle so the automatic timer in `identity/vault.js` and explicit `identity-manager.lockVault()` reach the same cleanup. Profile/runtime shutdown revokes contexts too. Cancel queues, invalidate operation handles, and prevent late completions from updating state. Keep this cleanup scoped to the new wallet privacy runtime; existing node identities/lifecycles retain their ownership.

Acceptance: normalized address variants share a context; A/B addresses, profiles, and generations do not; both lock paths revoke handles; stale async work cannot allocate a replacement context or update cache. Existing wallet routing and identity tests still pass. No new dependency is required for this first PR.

### PR 2 — Authenticated SOCKS transport

Extend the Arti manager with an internal readiness/endpoint snapshot and generation notification. A listening port alone is insufficient. Initially qualify bundled managed Arti; externally configured SOCKS servers need separate proof that they implement the required isolation semantics.

Implement a narrowly scoped wallet HTTP transport using SOCKS5 isolation credentials, with TLS validation for HTTPS and remote destination-name resolution. Partition agents, persistent sockets, retries, and in-flight work by context. Use the documented Arti format-0 token mechanism. Do not modify global fetch or use Electron PAC settings as the authenticated connector.

Before selecting a connector dependency, compare the smallest maintained implementation against the required SOCKS/TLS/abort behavior and present its exact version/license for dependency approval. Do not rely on an undeclared transitive dependency or build a general proxy stack to avoid that review.

Acceptance: a controlled SOCKS fixture observes distinct A/B tokens and separate same-host sockets; repeated A calls reuse only A; TLS errors fail; destinations are not locally resolved; cancellation and Tor generation changes close pools. A real instrumented Arti/controlled Tor test must establish circuit separation before an isolation claim. Exit-IP differences are not proof. Measure startup and steady-state latency; avoid one circuit per request.

### PR 3 — Existing wallet balance flow

Thread context through native and token balance reads, refresh deduplication, and eligible chain-router sources. Keep account-independent metadata separate where its payload and timing policy permit. Split/refuse mixed-context batches. Bind cached values to profile/account/chain and record actual observation time, source evidence, refresh failure, and privacy mode.

The current balance service catches errors, retains old values, and advances the aggregate `lastUpdated`. For this mode, an unsuccessful refresh must not make preserved values appear newly observed. Return a stable unavailable/stale result to the wallet UI, with a small experimental setting and existing sidebar status treatment.

Apply privacy requirements before selecting a source. Every quorum member, fallback, light-client backend, and direct-source branch must satisfy them. In this router, the source name `direct` means a single-provider trust tier; it does not have to mean clear-network transport. Preserve that distinction. Sources with unqualified upstream egress are ineligible in Tor-required mode; if the remaining sources cannot meet the requested correctness level, fail instead of silently lowering it. Preserve detailed trust evidence rather than treating the existing aggregate `verified` flag as a proof claim.

Acceptance: the first-deliverable scenario passes in Electron, including background refresh, outage, stale cache, account switching, both lock paths, and restart. Ordinary wallet behavior has regression coverage. This release scope is explicitly balance reads, not all wallet traffic.

### PR 4 — Transaction and SDK network coverage

Extend context ownership across fee estimation, simulation, nonce reads, public shield-transaction construction, signed submission, transaction lookup, and receipt polling. Inspect the independent ethers provider caches in `provider-manager.js`; their current chain-only cache key is not suitable for context-bound operations. Integrate only the relevant consumers while inventorying every reachable path.

Treat an uncertain broadcast as possibly submitted. Track the deterministic transaction/UserOperation identity and query status; do not automatically repeat a high-level operation or create a replacement with new fees. Public receipt tracking after lock needs an explicit permitted lifecycle, separate from private work. Remote signers that broadcast through their own RPC cannot inherit Freedom's transport guarantee and are outside the initial supported mode.

Acceptance: outage and retry tests account for all network calls; approval binds chain, account, recipient, amount, calldata, fees and expiry; changed intent requires renewed review. No preparation/signing/worker path bypasses the transport policy. Logs omit sensitive payloads and credentials.

### PR 5 — Kohaku host and runtime spike

After approving an exact SDK dependency set, demonstrate ESM/WASM loading in development and a packaged app. Implement restricted network/provider, encrypted atomic storage, and protocol-specific keystore facilities behind a Freedom adapter. Start with software-backed accounts. Use known-answer derivation vectors and preserve version/account metadata for recovery.

Define capabilities per protocol and chain; do not infer private-transfer or broadcast support from a shared interface. Keep runtime objects in the privileged runtime; expose opaque operation IDs and summaries. Lifecycle states must distinguish sync/proving/review/submitting/submitted/confirmed/failed/cancelled and unknown submission outcome. Bound memory and cancel proving on lock.

Run packaging and network-injection experiments early, alongside PRs 2–4 where independent. Inspect each Rust/WASM/indexer/artifact/bundler path. If one cannot be mediated, stop that adapter's qualification and resolve the transport seam upstream or in a reviewed wrapper. A global JavaScript fetch patch is not sufficient.

Acceptance: packaged loading, derivation vectors, authenticated encrypted persistence, crash/restart recovery, cancellation, and a complete egress inventory. Pin and verify proving-artifact digests. No production privacy controls are enabled merely because a host method returns a value.

### PR 6 — First shielded protocol flow

The September 14 proposal used Railgun as the Kohaku reference; after the September 24 Rust deprecation, select and qualify a maintained Railgun adapter or accessible PPv2 implementation first. The intended flow remains: Sepolia shield, sync, note/spendability status, reviewed unshield, and restart/independent restore. Add private transfer and POI qualification explicitly. Resolve the sponsored broadcast path's raw-key/signer mismatch before enabling it; never hand it the existing public-account private key for convenience. Keep receive/change semantics, fee reserves, and operation tracking explicit.

The smallest user-facing scope is one software privacy account, one qualified test chain, explicit public/private balances, shield, and unshield to a chosen Freedom account. Follow the existing UI/approval patterns and test both themes. This milestone depends on the complete relevant egress and approval boundaries, not just PR 3's balance-read success.

### Parallel PPv2 access, then PPv2 implementation

Resolve SDK/source/artifact access, reproducible versions, redistribution rights, and deployment compatibility while building the foundation. No outreach is authorized by this document. Once access is available, implement either a completed Kohaku adapter or a direct PPv2 SDK adapter behind the same Freedom interface; no PPv1 shipping phase is required. If PPv2 becomes practical before Railgun qualification, it may supply the first shielded product slice without changing the foundation.

Implement the canonical EIP-712 signature-derived key flow using the SDK; protect that internal signature as key material. Test repeatable derivation, rotation metadata, note/request recovery, and independent restoration. Guide registration before deposit, then Sepolia deposit → ASP pending/active → private transfer → withdrawal/ragequit. Pin matching SDK/contracts/circuits/verifiers. Hardware, remote, and Safe accounts require separate recovery/custody qualification.

## Release gates and later work

The first two milestones are (1) isolated balance reads and (2) a complete recoverable testnet shield/unshield flow. Do not assign a mainnet release date before proving, packaging, recovery, signer, and egress measurements exist. Production qualification includes applicable audits/setup evidence, dependency/license review, current legal questions, supported-chain deployment, and platform-specific tests.

anon-rpc compatibility, PIR, Nym, additional chains, hardware private spending, dApp privacy APIs, and pool-funded per-origin addresses remain later experiments. Leave narrow adapter seams for them; do not build their infrastructure into PR 1. The broader browser services gateway need not be finished before a wallet-scoped broker can work.

## Validation and first action

For each code PR, read the active ESLint configuration and run `npm run lint`; run `npm test` for changes to tested modules, including existing router, balance, transaction, identity, and Tor suites as applicable. Add behavioral tests for the security boundaries above. Renderer work also follows the UI playbook's both-theme, style, and Linux screenshot checks. Use deterministic SOCKS/HTTP fixtures for routine tests and separate controlled live tests for circuit and packaged egress claims. Record the exact tested dependency/artifact/platform versions.

Steps 1–3 and the scoped live/packaged macOS probes are complete locally. Steps 4–5 include durable submission/reconciliation, managed real deposit proving, reviewed PPv2 registration/deposit handoff and encrypted-note recovery across a real process restart. Their full acceptance gates remain open. Next: qualify transfer/unshield/ragequit circuits and intent binding, add durable relayer-operation recovery, cover ASP status and ERC-20 approvals, then exercise matching live deployments and broader egress/platform behavior. Product UI, final upstream identity/distribution, and remote-state trust policy remain separate decisions.

Research basis (versioned with this feature branch): `research/privacy-roadmap.md`, `research/kohaku-wallet-integration-research.md`, `research/privacy-pools-research.md`, `research/tor-circuit-isolation-research.md`, and `research/ethereum-reads-anon-rpc-research.md`. These five research files are tracked explicitly; the general research-ignore policy remains unchanged. Public references: [Kohaku](https://github.com/ethereum/kohaku), [PPv2 documentation](https://privacy-pools-v2-docs.vercel.app/), [Tor isolation](https://spec.torproject.org/path-spec/stream-isolation.html), [Reads](https://reads.ethereum.foundation/), [anon-rpc](https://github.com/ethereum/anon-rpc).
