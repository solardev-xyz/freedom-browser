# Ethereum Reads and anon-rpc: implications for Freedom

Date: 2026-09-14. Status: research and proposed experiments; no runtime changes.

Scope: the two supplied sites, Reads' foundations/projects/roadmap and linked technical articles, and static inspection of `ethereum/anon-rpc` at `8a59cccd7df458e53da25eaa95a2e9dc07e729ff` (August 28). The public npm metadata reports `@anon-rpc/browser-harness` version `0.3.0`, MIT, with a different publishing gitHead; the published tarball was not compared to this checkout. No packages were installed, demo workers executed, contracts queried, transactions submitted, or maintainers contacted. The GitHub Pages site was retrieved with curl after the web reader failed. Clone and retrieval snapshots are in `/private/tmp/freedom-anon-rpc-study`; this document carries the durable findings.

## Recommendation

Keep the Kohaku wallet foundation and account-isolated native Arti transport as immediate work. Add an anon-rpc compatibility experiment behind Freedom's network broker. Track private information retrieval (PIR) as a separate content-privacy capability. Neither a new remote-code loader nor a production PIR service is a prerequisite for the first wallet testnet flow.

The useful change is to make the broker express separate requirements for origin privacy, query privacy, correctness/freshness, and authorization/payment. A transport name alone cannot describe them. This follows the direction of [Reads](https://reads.ethereum.foundation/), rather than claiming its proposed common interface is already a finished standard. [Foundations](https://reads.ethereum.foundation/foundations/) distinguishes obtaining a canonical trust anchor from proving facts against it and making data reachable.

| Concern | Mechanism to evaluate | What remains outside it |
| --- | --- | --- |
| Who made this query? | Account-isolated Arti; qualified anon-rpc network client | RPC contents, API-key linkage, timing correlation |
| Which record was queried? | PIR over supported state/proof data | Source IP, correctness, unsupported methods and side channels |
| Is the response authentic and current? | Proofs against a canonical trusted head; preserve Freedom's source evidence | Query confidentiality; a provider quorum is not a cryptographic proof |
| Is the transfer graph public? | PPv2 / Railgun protocol adapters | RPC metadata and transport privacy |

These mechanisms can compose; none substitutes for all the others.

## What is available

[Reads' project index](https://reads.ethereum.foundation/projects/) separates implemented TorJS and PIR reference specifications from in-development anon-rpc and retrieval infrastructure. Its [roadmap](https://reads.ethereum.foundation/roadmap/) lists a Q4 2026 PIR Genesis target beginning with ETH balance retrieval; that is a plan, not a service we verified. The binary-trie work is marked paused, so it must not become a prerequisite for Freedom's current verification path. Dates on that page are planning information, not delivery evidence.

anon-rpc's [normative specification][spec] is draft 0.3.0. Its [browser harness README][harness-readme] explicitly calls the implementation prototype-grade and browser-only. The [adopters registry][adopters] lists a TorJS worker and a passthrough reference, with no wallet/app adopters recorded. That registry is not an independent ecosystem survey. The guide's default address selects the **passthrough worker, which provides no anonymity**. The listed TorJS gateway is described as a capacity-limited demonstration service that may disappear. We did not verify its uptime, chain state, or audit status.

## How anon-rpc fits

The [wallet guide][guide] constructs `AnonRpcWorker` from an Ethereum specifier address and exposes `ready`, a bound `fetch`, and `close`. The host reads `workerHash()` and resolver locations, obtains bundle bytes, checks their Keccak hash, then executes them in a Web Worker inside a null-origin iframe. The worker receives fetch requests and capabilities for KPS transport, scoped persistence, and logs. It gets no wallet signer.

KPS authenticates stream peers by certificate hash and supports browser WebRTC/native QUIC implementations. It is a connectivity mechanism, not onion routing or PIR. A peer reached directly still sees its network counterparty. TorJS uses gateways to bridge browser transport into Tor; Freedom's native Arti already avoids that browser-specific bridge requirement. This is a reason to preserve native Arti while evaluating portability, not proof that one implementation is more anonymous.

Kohaku and anon-rpc have different jobs: Kohaku hosts privacy-protocol operations; anon-rpc hosts a network client. Freedom's broker can supply an approved transport to Kohaku's provider/fetch interfaces and eventually use anon-rpc beneath them. The network worker must never receive Kohaku keystore access, spending keys, or PPv2 derivation signatures. SDK HTTP paths bypassing host injection still require separate mediation.

## Concrete gaps to address before adoption

1. **Account isolation is not standardized here.** The spec's fetch/KPS calls have no per-address isolation field; `config` is worker-defined and opaque. The guide suggests one long-lived worker per network. For Freedom, independent accounts need enforced contexts in worker routing, transport pools, and persistence. Separate worker instances alone are insufficient: [reference storage][storage] uses a shared host-origin IndexedDB keyed by specifier address and storage key. Two instances using the same specifier can share state. Add a host-controlled outer profile/context partition, preserving specifier scoping within it, or negotiate a tested worker-specific isolation contract. Do not transmit local context identifiers as RPC headers.

2. **Sandboxing does not enforce anonymous egress.** The [runtime][runtime] loads code in a normal worker; the [host][host] creates a sandboxed iframe without adding an explicit network-deny policy. The passthrough implementation intentionally uses ambient fetch. This protects different boundaries from Freedom's fail-closed transport policy. Test ambient fetch, WebSockets, further imports, and KPS dialing under the actual Electron configuration. Constrain bootstrap and runtime egress; do not infer a complete network sandbox from null-origin isolation. A permitted network worker also sees request bodies and can misuse them, so source review and approved code remain necessary.

3. **Hash identity needs an authenticated, controlled update path.** The [specifier reader][specifier-reader] makes two `eth_call` reads at `latest`; it does not itself verify chain identity, canonicality, or execution. A lying bootstrap RPC can substitute the expected hash. The [reference contract][contract] lets its owner change both bundle hash and resolvers until ownership is renounced. Pin chain, specifier, and reviewed bundle hash in Freedom's release policy; reject unexpected changes even when an on-chain lookup accepts them. Authenticate discovery using a qualified verification path, or use release-reviewed bundle identity as an independent trust anchor. Hash pinning detects substitution relative to the expected hash; it is not a code audit.

4. **Bootstrap is part of the privacy boundary.** Bundle resolution uses host fetch or KPS before the anonymous worker is ready. The stock API injects a bootstrap RPC provider, but does not expose a general resolver-fetch hook. Use a separate account-independent bootstrap context via native Arti or reviewed cached bytes, while verifying chain/specifier identity. Do not let this silently become direct traffic in Tor-required mode. Cached content still needs integrity and update policy. Resolver destinations, redirects, and resource limits need host enforcement.

5. **Lifecycle and diagnostics need qualification.** The host forwards worker log arguments to console; only top-level byte arrays get summarized. Strings and objects can contain queried addresses or request bodies. Default to suppressed/redacted logs and bounded storage/queues. Source inspection also suggests an early-close race: asynchronous boot continues after resolver waits without a closed-generation check before iframe creation. Treat this as a reproduction target, not a demonstrated exploit: test close during discovery/download, failure after ready, stalled startup, and late KPS completion. A rejected fetch is not proof that network work stopped.

6. **Browser packaging is not a main-process integration.** The package relies on `document`, iframe/Worker APIs, IndexedDB, and browser KPS. Do not import it directly into Freedom's privileged main process or move key ownership into a renderer to accommodate it. Compare a tightly restricted browser runtime with a separately implemented native harness; process placement requires the architecture playbook before implementation. Claim full anon-rpc conformance only after satisfying the actual spec, not merely exposing a fetch-shaped Arti adapter.

## PIR: the additional privacy layer

The [sharded PIR proposal](https://ethresear.ch/t/sharded-pir-design-for-the-ethereum-state/24552) targets hiding selected state records while retaining ordinary RPC-facing semantics. Our first useful test would be a balance and its authentication evidence against a known head. An ordinary address-specific proof request alongside a private balance query would disclose the same interest. Token balances, nonce reads, logs, and simulation need individual coverage decisions; an ETH-balance demonstration does not qualify them. The proposal discusses decoy queries and stateful schemes whose reusable client material can itself link sessions. Treat these as experimental requirements, not solved wallet behavior.

For Freedom, keep separate records of supported methods, chain/deployment, privacy assumptions, proof type, canonical block/freshness, and performance. If a content-private operation cannot be satisfied, fail that mode or require a deliberate mode change; do not silently fetch the same address through ordinary RPC. Origin privacy still matters with PIR. Ordinary RPC over Tor should be described as exposing query contents to the endpoint.

## Proposed experiment and acceptance criteria

1. Define the broker's privacy requirements and returned evidence independently from its transport implementation. Keep quorum evidence distinct from proof verification; never translate `anon-rpc` into `verified` or `content-private` automatically.
2. Finish native Arti context/connection tests from [the isolation study](tor-circuit-isolation-research.md). Then compare a reviewed anon-rpc Tor worker using synthetic addresses, in an isolated prototype. The passthrough worker is a negative control that must never qualify for an anonymous mode.
3. Exercise two accounts sharing a specifier, persistence across restart, pin changes, dishonest bootstrap replies, direct egress attempts, cancellation, and outage. Inspect all traffic, including discovery and bundle retrieval. Measure cold startup, steady-state latency, memory, and per-context cost before choosing instance granularity.
4. When a usable PIR implementation/deployment is available, test balance plus proof retrieval, unsupported methods, stale heads, and downgrade behavior. Preserve the existing PPv2 access/recovery work in parallel.

Potential upstream discussion: a standard isolation-context contract, stronger storage partitions, controlled resolver transport, native harness support, update authentication, and lifecycle cancellation. No outreach has been sent. Existing tests were read selectively; none were run during this source study.

[spec]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/SPEC.md
[guide]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/docs/integrate-wallet.md
[adopters]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/adopters.json5
[harness-readme]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/browser-harness/README.md
[storage]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/browser-harness/src/host/idb-storage.ts
[runtime]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/browser-harness/src/worker/worker-runtime.ts
[host]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/browser-harness/src/host/AnonRpcWorker.ts
[specifier-reader]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/browser-harness/src/host/specifier.ts
[contract]: https://github.com/ethereum/anon-rpc/blob/8a59cccd7df458e53da25eaa95a2e9dc07e729ff/impl/specifier/src/WorkerSpecifier.sol
