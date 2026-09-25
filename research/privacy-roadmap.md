# Freedom Browser — Privacy Roadmap (synthesis)

**Date:** 2026-07-08 · **Updated:** 2026-09-25 (main/node refresh, durable submission tracking, current Kohaku transport) · **Status:** context/transport/balances implemented locally; scoped live Arti and packaged macOS checks passed; durable transaction tracking and bounded Kohaku host transport tested; reconciliation, full SDK egress and production activation pending
**Companion docs:** `services-consent-spec.md` (Outbound Services Gateway), `nym-integration-research.md`, `fingerprinting-defense-research.md`, `privacy-pools-research.md`, `kohaku-wallet-integration-research.md`, `daily-driver-roadmap.md`, plus in-flight PRs: adblock #144, Tor/Arti #112, permission prompts #152, private windows #157.

The September revision updates transport and wallet planning from current PPv2 docs, Kohaku source, Tor specifications, and Ethereum Reads/anon-rpc. See `tor-circuit-isolation-research.md`, `ethereum-reads-anon-rpc-research.md`, and the September update in `privacy-pools-research.md`. Other July claims and PR references remain historical and have not been comprehensively revalidated. Several named companion documents are absent from this checkout; establish their status before relying on them.

**September 25 implementation:** current main is merged and its locked dependencies/node installations refreshed. Submission hashes are durably encrypted before broadcast, survive real Electron restart, and block new sends pending explicit reconciliation. A bounded current Kohaku network capability passes SOCKS/TLS and actual upstream client interoperability tests. Upstream deprecated the Rust implementations and removed the prior Railgun package on September 24; the original WASM spike is historical, and maintained protocol selection must be revisited. PPv2 remains the target; no PPv1 or Tornado shipping phase was added. See [the current engineering follow-up](../docs/privacy-engineering-followup-2026-09-25.md) for exact evidence and remaining gates.

## 1. Threat model — six distinct adversaries

Privacy work fails when features are matched to the wrong adversary. Freedom's map:

| # | Adversary | Sees today | Pillar |
|---|---|---|---|
| T1 | **Network-position observers** (RPC providers, DoH resolvers, CCIP gateways, ISPs, netflow-level chain-analysis firms) | IP ↔ wallet addresses, queried records/access patterns, names resolved, tx origin timing | Gateway + isolated transports + private retrieval (§3, §4) |
| T2 | **Sites & trackers** (ads, analytics, fingerprinting scripts) | fingerprint surface, tracking requests | Adblock #144 + fingerprinting posture (§5) |
| T3 | **dApps specifically** (a subset of T2 with web3 superpowers) | provider fingerprint ("this is Freedom"), wallet address as a cross-site super-cookie | Provider hygiene (§5.2) — highest ROI item in this doc |
| T4 | **Local/physical access** | history, cookies, session traces | Private windows #157, vault auto-lock (exists) |
| T5 | **Us (the vendor) + our defaults** | update pings, default endpoints chosen for users | Services consent + BYO endpoints + ledger (§3) |
| T6 | **On-chain observers** (chain-analysis firms, any dApp, anyone forever) | the entire transaction graph — every payment, balance, counterparty, permanently public regardless of transport | Transactional privacy (§6) |

Already strong and worth stating: no telemetry at all, deny-by-default permissions (now with prompts, #152), per-profile isolation, ENS light-client verification (Colibri), cache clear on boot, local-first nodes.

## 2. The architecture that ties it together

```
                    ┌─ consent? ─ endpoint (default│BYO) ─ transport ─┐
 browser service ──►│            Outbound Services Gateway            │──► network
 (RPC, DoH, CCIP,   │  ledger: what·where·when, per service           │
  updates, lists)   └── transport = direct │ tor (Arti) │ mixnet (Nym)┘
```

One gateway for consent, endpoint selection, transport, and an explicit privacy context. That context follows requests through providers, workers, retries, connection pools, and broadcasters. Minimize local activity records; never record derivation signatures, note secrets, or a persistent token-to-address tracking map. Page traffic is *not* gated by this wallet/services gateway; browser page isolation is a separate workstream.

Following [Ethereum Reads](https://reads.ethereum.foundation/), represent origin privacy, query-content privacy, correctness/freshness, and authorization/payment separately. Carry requirements into route selection and retain the evidence actually obtained. Tor routing does not prove a response; provider agreement does not equal a cryptographic proof; proof verification does not hide the queried address. `anon-rpc` is a candidate network-client interface below the gateway, distinct from Kohaku's protocol-plugin interface.

## 3. Pillar: consent + visibility (T5, T1)

Per-service consent, BYO endpoints, minimized activity records, and schema-change review. The transport field is `direct|tor|mixnet`; add a privacy context before wallet integration. The July draft referenced a completed services specification, but `services-consent-spec.md` is absent from this checkout. Recover or restate its contract before implementation. A small wallet broker can establish the required behavior without waiting for every browser service to migrate.

## 4. Pillar: transport privacy (T1)

Two tools, deliberately split by payload profile — don't force either to do the other's job:

- **Tor (Arti):** intended transport for wallet RPC, ASP/indexer requests, and relayers, with performance to be measured. Arti 2.6.0 is installed locally, but Freedom's PAC currently routes only `.onion` page traffic; wallet Node-fetch RPC is not covered. Circuit isolation is an application responsibility. Tor reduces source-IP exposure; it does not hide addresses in RPC payloads or eliminate timing correlation.
- **Nym mixnet (later, narrow):** 480–1100 ms RTT, 9–18 Mbps — unusable for browsing, **ideal for transaction broadcast**: fire-and-forget, latency invisible, and timing-correlation resistance matters most at the instant a tx is revealed. Secondary candidate: background balance polling. Integration is a `nym-socks5-client` **sidecar** (Apache-2.0 — the GPL-3.0 `nym-vpn-core` is avoided), same managed-binary shape as Ant/Radicle/Arti; reuses #112's SOCKS plumbing. Access is currently free at the SDK/SOCKS tier; paid zk-nym credentials are coming — and Nym is building programmatic credential purchase, which an x402-capable, wallet-holding browser could automate for unlinkable access. Go/no-go: a 2–3 day exit-gateway→public-RPC reachability spike.
- **Explicitly not doing:** whole-browser VPN mode (NymVPN 2-hop is Tor-class anyway; Arti covers it), and a Freedom-hosted proxy (see services spec non-goals).

**RPC defense in depth:** isolated transport reduces source-IP exposure; PIR is a separate candidate for concealing selected records; canonical-head/proof verification establishes correctness where supported. A local light client may still send revealing requests upstream. Qualify its data paths rather than equating local execution with private retrieval. Transaction broadcast has its own metadata and on-chain exposure.

### 4.1 Required: wallet circuit and connection isolation

Tor explicitly recommends isolating different accounts inside one application. The application must supply those boundaries. Tor VPN's per-Android-app isolation is a useful precedent; wallet addresses require finer separation. [Tor specification](https://spec.torproject.org/path-spec/stream-isolation.html), [September 9 Tor VPN article](https://blog.torproject.org/tor-vpn-beta/).

- **Public reads:** context = profile + canonical public address + chain + service role + session generation. Carry the subject explicitly, including for `eth_call` calldata; the RPC URL or token-contract address cannot identify it. Normalize equivalent address encodings.
- **Private operations:** separate private account + protocol/deployment + chain + role contexts; use operation-specific contexts where funding, receiving, and withdrawal should remain distinct. Never default private-note traffic to the funding address's context. Fetch genuinely account-independent metadata/artifacts separately.
- **Connection boundaries:** segregate HTTP keep-alive/HTTP2 pools, WebSockets, auth/cookie state, and in-flight deduplication. Refuse/split mixed-address RPC batches and multicalls. Review synchronized all-account polling. Applying a new token to an existing socket does not isolate requests on it.
- **Arti mechanism:** authenticated SOCKS5 using username `<torS0X>0` and a random, nonempty opaque isolation token as password. Assign tokens locally; do not use wallet addresses or keys as credentials. Arti 2.6.0 source supports this format. A native adapter can instead use `StreamPrefs::set_isolation`. [SOCKS specification](https://spec.torproject.org/socks-extensions.html).
- **Wallet broker required:** Chromium does not support SOCKS5 authentication. Use a main-owned SOCKS connector or a scoped local bridge/native adapter, and verify worker/WASM coverage. A PAC-only change is insufficient; one Arti daemon can serve many contexts. [Chromium proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md).
- **Failure/lifecycle:** preserve context through redirects, provider fallback, retries, and reconnects. No silent direct-network fallback in private mode. Lock/profile changes stop private work, close owned connections, and revoke handles/tokens. Allocate contexts on demand with idle/resource limits; do not create a fresh circuit for every request or alter Tor's normal guard selection.

**Limits:** separate isolation groups cannot share circuits, but different circuits may select the same exit. This is not a unique-IP or complete-unlinkability guarantee. Shared provider API keys, mixed-address payloads, on-chain links, and timing can still correlate accounts. Mixing notes within one explicitly selected private operation differs from accidentally combining unrelated host contexts.

**Acceptance criteria:** concurrent A/B address reads use different SOCKS tokens and pools; repeated A reads can reuse A's context; an instrumented Arti/controlled Tor test confirms incompatible contexts never share a circuit (different observed exit IPs alone are not a test); mixed-context batches are refused/split; all SDK/worker/RPC/relayer egress is accounted for; Tor failure causes neither direct requests nor local destination-DNS lookups; retries and lock/restart cannot reuse revoked contexts. Detailed design: `tor-circuit-isolation-research.md`.

### 4.2 Candidate: anon-rpc and private retrieval

**anon-rpc:** evaluate draft 0.3.0 behind the wallet broker after the native Arti baseline. Its browser harness runs a hash-checked network worker with fetch/KPS/storage/log capabilities. It is prototype-grade, not a privacy certification. The default example is passthrough (no anonymity); the adopter registry also lists TorJS using a demonstration gateway. A deployed specifier contract does not establish production readiness. [Specification](https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/SPEC.md), [wallet guide](https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/docs/integrate-wallet.md).

**Freedom adoption gates:** explicit account-context routing and outer storage partitions (the reference scopes only by specifier within its host origin); enforced bootstrap/runtime egress; authenticated chain/specifier discovery and release-reviewed bundle hashes; no automatic acceptance of owner-updated code; bounded resources, redacted logs, and cancellation tests. Separate workers alone do not prove circuit or storage separation. Keep network workers isolated from signers and protocol secrets. The browser harness needs a separate runtime decision for Electron; do not move wallet authority into a renderer to accommodate it.

**PIR:** track an experimental ETH-balance-plus-proof flow when an implementation and endpoint can be qualified. Reads lists PIR Genesis for Q4 2026; this is a target, not confirmed service availability. Require compatible private proof retrieval, supported-method/chain coverage, canonical block/freshness evidence, and no silent ordinary-RPC fallback from content-private mode. ETH balance support alone does not cover token balances, logs, or simulation. Binary-trie work is marked paused and is not a prerequisite for our existing verification paths. [Reads roadmap](https://reads.ethereum.foundation/roadmap/), [PIR design](https://ethresear.ch/t/sharded-pir-design-for-the-ethereum-state/24552).

Detailed source findings and test plan: [Ethereum Reads and anon-rpc research](ethereum-reads-anon-rpc-research.md). Neither experiment blocks the wallet foundation or PPv2 access work.

## 5. Pillar: fingerprinting (T2, T3)

### 5.1 The honest engineering position (from `fingerprinting-defense-research.md`)

Web content runs in `<webview>` with contextIsolation; the robust noising defenses (canvas/WebGL/audio farbling, worker coverage) live in Blink C++ and are **fork-only** — Helium ships them as Chromium patches; Brave keys noise per-eTLD+1+session. JS preload shims are detectably fake (fresh-realm iframe bypass, unpatched Workers, `toString` introspection) and per CreepJS-style "lie" scoring **make users more identifiable, not less**. Brave itself sunset its Strict mode over this. Therefore:

- **Ship (robust below JS):** timezone normalization option (`process.env.TZ`), WebRTC policy (`setWebRTCIPHandlingPolicy` — public-IP leak still needs the Tor transport), UA normalization (`setUserAgent`, blend into Chrome), Accept-Language reduction — all via existing `webrequest-dispatcher.js`/session APIs.
- **Skip, and say why publicly:** canvas/audio/hardwareConcurrency JS noising. A half-measure here is worse than nothing. Positioning: Freedom is a privacy-*hygiene* browser, not an anti-detect browser — Helium-style honesty as brand.
- **Long-term fork question (strategic, not now):** Brave-grade farbling requires engine patches. Options when the time comes: adopt Helium's noise patch stack (they're MIT-style open patches on Chromium — license check needed), or accept the positioning permanently. Parked in §7.

### 5.2 The web3 fingerprint — our own house first (T3, highest ROI)

EtherVeil's core insight applies to us directly: injecting `window.ethereum` at all puts users in <1% of web sessions; Freedom then stacks `isFreedomBrowser: true`, static `rdns=baby.freedom.browser`, fixed name/icon, `isMetaMask: true`, *and* a second `window.swarm` global — on **every page, pre-consent**. Any site (not just dApps) can read "this is Freedom Browser, a wallet-holding user." Fixes are policy, entirely under our control, no engine work:

1. **Gate `window.swarm` behind per-origin connect/consent** (stop announcing it globally).
2. **Trim the always-on provider surface**: nothing Freedom-unique before the user connects. The EIP-6963 announce flow needs review — what can defensibly be lazy/gated without breaking discovery UX (tension is real: dApps must be able to find the wallet; the 6963 uuid is already correctly per-session-random).
3. **`isMetaMask: true` decision**: it's a compat shim and a lie with fingerprint cost either way — decide deliberately, document the choice.
4. **Private windows already remove the whole surface** (#157 ships no providers) — that's the right maximal case.
5. **Per-origin address derivation** (EtherVeil-adjacent, big product question): the wallet address is a cross-site super-cookie the moment the user connects to two sites. Deterministic per-origin child addresses would break that linkage but change wallet semantics profoundly (funding, balances, UX). **Discussion item, not a commitment** — but it is the kind of feature that would make Freedom's privacy story genuinely novel.

## 6. Pillar: transactional privacy (T6)

Transport privacy (§4) reduces source-IP exposure; it does not hide public transaction contents or guarantee sender anonymity. The chain is a permanent public ledger, and the wallet address is both a cross-site identifier (T3) and a financial history (T6). Full analysis: `privacy-pools-research.md`.

**Product direction: PPv2, with a protocol-adapter wallet foundation that also supports Railgun. PPv1 is optional reference/test coverage, not a mandatory product milestone.** PPv2 exists independently of Kohaku's adapter. Its documented private transfers, payment requests, and selective disclosure fit the intended wallet. A v2 frontend/docs site does not establish that a working Kohaku v2 plugin ships.

**Verified September 14:** current 0xbow docs list Sepolia-only deployment (V9) and partner early access for `@privacy-pools-v2/sdk`. The public npm endpoint and unauthenticated monorepo lookup returned 404; that establishes lack of public access there, not absence of an SDK. Kohaku revision `1c54b378` implements v1 but its `createPPv2Plugin` is a stub. Keep protocol deployment, SDK access, and adapter readiness separate. [Deployment](https://privacy-pools-v2-docs.vercel.app/deployments/sepolia), [quickstart](https://privacy-pools-v2-docs.vercel.app/introduction/quickstart), [Kohaku v2 source](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/privacy-pools/src/v2/index.ts).

**Start now:** build the Kohaku host/runtime and isolation-aware broker, using Railgun as an available implementation and PPv1 only if useful for compatibility tests. Resolve PPv2 source/artifact access and distribution rights in parallel. When accessible, wrap its `PoolSession` behind Freedom's adapter if Kohaku's v2 adapter is still missing; preferably coordinate an upstream contribution. Preserve the existing vault and public-account paths.

**PPv2 requirements:** derive keys via the documented EIP-712 signature and SDK HKDF flow, preserving the canonical payload and derivation metadata. Do not substitute PPv1 BIP-32 paths. Treat the internal derivation signature as secret key material; never return it to pages or logs. Test repeatability/recovery for each signer backend. The current docs do not establish the older blanket “Ledger requires v2.1” gate. Register the keystore before the first deposit flow: spending and ragequit require owner registration. Pin SDK, circuits, verifiers, and contracts to one deployment set; retain note/request state and key-rotation metadata. [Keys](https://privacy-pools-v2-docs.vercel.app/concepts/keys), [session builder](https://privacy-pools-v2-docs.vercel.app/sdk/pool-session-builder).

**Composition opportunities:** pool-funded fresh/per-origin accounts and x402 budgets remain candidates. Private withdrawals can reduce direct funding links, but timing, amounts, address reuse, provider credentials, and later chain activity can still correlate them. Apply §4.1 to funding, note-sync, and relay paths. Nym remains a later experimental transport, not a prerequisite for the first testnet wallet or an already implemented broadcast path.

**Release gates:** reviewable SDK/source and acceptable redistribution rights; matching deployment/artifact set and applicable audit/setup evidence; recovery, isolation, and Electron proving/packaging tests; current legal review of the questions in `privacy-pools-research.md` §7. Mainnet shipping needs a qualified mainnet deployment on a supported chain. Base/Gnosis expansion is a separate capability gate. July legal/TVL claims are historical, not current assurances.

**Next PPv2 experiment:** software account on Sepolia; canonical derivation → registration → deposit → ASP approval → private transfer → withdrawal/recovery. Measure proving and cold/warm sync, exercise injected RPC/HTTP/storage/artifact interfaces, and verify isolation at each network boundary. This roadmap update does not implement or launch the feature.

**Steps 4–5 technical update:** context-bound transaction preparation/submission/receipt hooks, exact signed-intent review checks, restricted Railgun derivation and encrypted atomic storage now have passing tests. An isolated Kohaku bundle initializes WASM and reconstructs a synthetic address in packaged Electron from ASAR. These are main-only technical prototypes; SDK sync/proving and durable transaction recovery are not complete. Application dependencies and the production gate are unchanged. PPv2 remains the target; its tested public npm SDK endpoint remains unavailable.

**Next engineering work:** durable submission journal/restart recovery; mediation of every reachable SDK indexer/artifact/POI/Rust/WASM network path; approved dependency/license and artifact inputs; real protocol persistence/restore; broader platform and egress qualification. Final UI/UX can be discussed separately. The versioned [engineering status and evidence](../docs/privacy-engineering-status.md) records exact versions, test results, limits and reproducible probes.

## 7. Phased plan

The wallet work is broken into concrete PRs and acceptance gates in [the implementation plan](../docs/wallet-privacy-implementation-plan.md). Start with context ownership and authoritative lock cancellation, then authenticated Arti transport and the existing balance flow. Kohaku packaging and PPv2 access can proceed alongside transport work. The first milestone covers isolated balance reads; complete transaction/SDK egress qualification precedes a shielded-wallet release.

**Step 1 status:** account/profile-scoped opaque contexts, bounded task lifetimes, vault/session cancellation, and a separate router option are implemented locally with passing new tests. Context-bound requests require the development gate and narrow balance route added in Step 3; no production circuit-isolation claim is made. Full-suite baseline failures and exact validation counts are recorded in the implementation plan.

**Step 2 update:** the managed-Arti endpoint lifetime, strict authenticated SOCKS connector, and bounded context-specific HTTP/TLS pools are implemented with passing controlled tests. No dependency was added. A subsequent live macOS Arti probe observed separate A/B circuit groups and same-context reuse. Complete egress/platform qualification is still required before production activation. See the implementation plan for tested behavior and limits.

**Step 3 update:** Sepolia native/ERC-20 balance reads now use account contexts through a dedicated authenticated route, with separate profile/account caches and preserved observation timestamps on failures. Unmediated sources and stronger unsupported correctness/privacy requirements fail closed; private reads never enter the ordinary fallback chain. The experimental setting is development-gated and disabled for packaged execution. Unit and controlled Electron tests pass for the new behavior, including both-theme settings, outage, restart and lock paths. The subsequent live Arti probe and controlled packaged macOS checks passed. Complete OS egress tracing, representative latency/load tests and other platforms remain pending. Details, test counts and scope limits are in the implementation plan.

| Phase | What | Effort | Depends on |
|---|---|---|---|
| **A. Quick wins** | §5.1 engine-level items (WebRTC policy, UA/lang normalization, TZ option) + §5.2 items 1–3 (provider hygiene: gate window.swarm, trim always-on surface, isMetaMask decision) | ~1–2 weeks total, parallelizable | nothing — can start now |
| **B. OSG Phase 1–2** | Gateway, registry, consent UI, ledger, onboarding, enforcement | per services spec | spec review |
| **W. Wallet foundation — start first** | Kohaku host/runtime, vault/provider adapters, capability model, recovery tests; Railgun reference flow; PPv1 optional test adapter | estimate after runtime spike | existing vault/signers; privacy-context contract shared with C |
| **C. Isolated wallet transport — alongside W** | Arti broker, per-address/private-account contexts, separate pools/batches, fail-closed and worker-egress tests (§4.1); later expand through OSG | dedicated spike before estimate; not just a proxy switch | Arti exists; explicit context contract; required before isolated-wallet claims |
| **C2. anon-rpc compatibility experiment** | Compare reviewed Tor worker to native Arti; qualify pins/bootstrap, account/storage separation, egress, and lifecycle (§4.2) | estimate after source findings are reproduced | C baseline; isolated runtime; optional, not a W/G prerequisite |
| **P. Private retrieval experiment** | ETH balance plus proof; method/chain/freshness evidence; no content-privacy downgrade (§4.2) | revisit when usable deployment is available | qualified PIR implementation/endpoint; separate from transport and PPv2 |
| **D. Nym spike → narrow integration** | 2–3 day reachability spike; if go: sidecar + `mixnet` transport for tx broadcast, Experimental flag | spike 3d; integration ~2–3 wks | C (shares SOCKS plumbing) |
| **E. Per-origin addresses** | Design doc + team debate first — evaluate pool funding (§6) | doc: days; feature: large | product decision |
| **F. Fork-or-position** | Decide: adopt engine-level farbling (Helium patch stack) vs codify hygiene positioning | strategic | revisit after A–D shipped |
| **G. PPv2 target integration** | Resolve SDK/source/artifact access and license now; then direct-SDK or upstream Kohaku adapter plus Sepolia slice; qualify mainnet separately | initial spike budget 1–2 wks after access; revise from measurements | W, C, matching deployment, recovery/review gates; no mandatory PPv1 product or Base/Gnosis prerequisite |

## 8. Decisions needed from the team

1. **Provider surface (§5.2.2–3):** what's the minimum pre-connect announcement that keeps dApp discovery working? Keep or drop `isMetaMask`?
2. **Positioning statement:** commit publicly to "hygiene, not anti-detect" (recommended), or leave ambiguous?
3. **Per-origin addresses (§5.2.5):** worth a design doc now?
4. **Nym timing:** run the spike now (cheap, informs OSG) or after Tor transport ships? (Recommendation: after C — the spike result can't be acted on before the SOCKS plumbing exists anyway, and Nym's payment model will be clearer by then.)
5. **Services-spec open questions** (carried over): eth-rpc consent placement, ledger retention, offline-mode semantics, Helium-style blunt copy.
6. **PPv2 (§6):** who obtains SDK/artifact access and confirms license/audit coverage? Who owns current legal review? Prefer contributing a Kohaku v2 adapter or initially wrapping the direct SDK? No maintainer outreach was sent by this research task.
7. **Per-origin addresses:** specify funding, derivation recovery, and remaining correlation risks before making unlinkability claims.
8. **Circuit isolation (§4.1):** the wallet-scoped authenticated SOCKS connector and context contract are implemented. Complete SDK egress, supported-platform and lifecycle qualification before production activation; these are engineering gates, not a pending UI choice.
9. **Reads/anon-rpc (§4.2):** define minimum privacy/correctness requirements per operation; evaluate a restricted browser versus native harness and an explicit reviewed-worker update policy. Consider upstream discussion of isolation/storage/bootstrap hooks; no outreach has been sent.
