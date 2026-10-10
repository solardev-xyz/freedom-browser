# Wallet Tor circuit isolation

Date: 2026-09-14. Status: research and proposed acceptance criteria; no networking code changed.

## Finding

The supplied polymutex screenshot identifies a valid wallet design concern. Tor can hide the client's source IP while the wallet still joins unrelated addresses through shared connections or circuits. The [Tor specification](https://spec.torproject.org/path-spec/stream-isolation.html) explicitly names accounts within one application as contexts that should generally be isolated, and requires the application to communicate their relationship. The [September 9 Tor VPN article](https://blog.torproject.org/tor-vpn-beta/) describes isolation per Android app. That does not automatically isolate multiple wallet addresses inside one app.

The screenshot's criticism of Kohaku is a lead, not an ecosystem-wide audit. In the inspected [CLI revision](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/utils/tor.ts), one active Tor client is reused for a session, its fetch calls carry no explicit public-address isolation context, and Ethereum RPC is intentionally direct. This establishes a missing address-aware host policy in that code; it does not establish the circuit behavior of every underlying `tor-js` version or every Kohaku application.

Isolation prevents specific shared-circuit linkage. It does not erase common API credentials, requests containing several addresses, address reuse, public transfers, or timing/volume signatures. Circuits can select the same exit; unique exit IPs are not an acceptance criterion. Keep the distinction between logical isolation and statistical anonymity explicit.

## Freedom today

- `src/main/tor-proxy.js` applies an `.onion`-only PAC to Electron sessions. It does not implement wallet-address contexts.
- `src/main/networks/chain-data-router.js` performs remote RPC through Node fetch. Its `routingContext.origin` is for page workload routing, not a Tor account-isolation token.
- `src/main/wallet/balance-service.js` knows the subject address, including when constructing token `balanceOf` calldata, but does not pass an isolation context to the router.
- Account separation in Electron partitions, profile ports, or storage does not by itself partition the network requests issued by these modules.
- Railgun has WASM HTTP paths outside Kohaku's `Host.network.fetch`; those paths need mediation as described in `kohaku-wallet-integration-research.md`.

## Mechanism available in the installed Arti

The [SOCKS extension specification](https://spec.torproject.org/socks-extensions.html) defines format 0: SOCKS5 username `<torS0X>0`, with the password carrying the stream isolation token. Different values identify incompatible groups. It recommends this extension rather than new use of legacy username/password isolation.

The installed Arti 2.6.0 source was inspected under the Cargo registry: `arti-2.6.0/src/proxy/socks.rs::interpret_socks_auth` accepts format 0, then `get_prefs_and_session` passes the parsed value to `StreamPrefs::set_isolation`. `src/proxy.rs::StreamIsolationKey` considers contexts compatible only when their listener and provided isolation values match. Public source: [Arti 2.6.0 SOCKS implementation](https://docs.rs/crate/arti/2.6.0/source/src/proxy/socks.rs), [proxy isolation key](https://docs.rs/crate/arti/2.6.0/source/src/proxy.rs).

A custom Rust transport could use [Arti stream preferences](https://docs.rs/arti-client/latest/arti_client/struct.StreamPrefs.html) directly. Its per-stream isolation option should not be used indiscriminately: it increases circuit load without making each circuit inherently more private. Prefer a reusable group per intended context.

There is no requirement to run a Tor daemon per address or rotate guards manually. One managed Arti instance can handle many incompatible stream groups.

## Proposed context contract

The main process assigns opaque handles. A handle resolves locally to a context with:

- profile and unlock/session generation;
- principal kind: public address, private protocol account, or account-independent service;
- canonical principal identifier;
- chain, protocol/deployment when applicable, and service role;
- optional private-operation identifier when a finer split is needed.

Assign an unpredictable random token to each live context; do not encode an address, mnemonic-derived identifier, or persistent account ID into SOCKS credentials. Keep the mapping in memory and omit it from logs. The token is a local routing label, not an upstream HTTP header or authorization credential.

Public address A and public address B must not share a context even if they use the same RPC URL. Repeated reads for A within its context can reuse connections. Private-note indexing and withdrawal submission must not automatically inherit the original funding address's context. Distinguish protocol/account/service roles; use finer operation grouping when a stable private-account context would itself join otherwise independent withdrawals. This granularity is a design policy to validate, not an anonymity guarantee.

Supply the context explicitly from the operation owner. Parsing arbitrary JSON-RPC data cannot reliably recover intent: `eth_call` can embed an account address, and a transaction can refer to several parties. Public, account-independent calls such as chain ID or circuit downloads can use a distinct service context if their payload is genuinely independent.

## Networking requirements

1. **Own the transport.** Use an authenticated SOCKS connector in the wallet broker or a scoped bridge/native transport. Chromium's [proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) says SOCKS5 authentication is unsupported, so adding credentials to Electron proxy settings is not a solution. A local bridge would need authenticated, profile-scoped access and a fixed upstream policy; it must not become an unauthenticated open proxy.
2. **Partition connections before sending.** Key HTTP agents, HTTP2 sessions/coalescing, WebSockets, auth/cookie state, and in-flight deduplication by context. Never multiplex unrelated contexts on one socket. Caches that can suppress/trigger account-specific requests need a context review; shared immutable public artifacts can be separate.
3. **Partition requests.** Reject or split mixed-context JSON-RPC batches and multicalls. Aggregate balances locally. A deliberately public multi-address operation needs its own explicitly acknowledged policy, not an accidental optimization in private mode.
4. **Preserve routing on every path.** Thread context through RPC verification/quorum/fallback sources, ASP, relayer, bundler, worker/WASM requests, redirects, retries, and receipt polling. Data verification and transport privacy are independent properties. The private broker must not lose isolation when the preferred provider fails.
5. **Fail closed.** No implicit direct retry or local resolution of remote destination hostnames in Tor-required contexts. Cover request libraries beyond global fetch, persistent sockets, workers, and child processes. A fetch monkey patch is not an OS egress sandbox.
6. **Bound lifetime and resources.** Allocate on demand, cap concurrent contexts/connections, and expire idle pools. Revoke on lock/profile changes and discard queued private work. An already submitted transaction cannot be undone; public receipt tracking needs an explicit permitted lifecycle. Old retries must not recreate a revoked private context.

Shared provider credentials are a separate correlation channel. A user-specific API key sent from A and B identifies both to the provider despite circuit separation. Explain that property for BYO providers; consider unauthenticated endpoints or a genuinely private local node as alternatives, while separately reviewing upstream traffic from local light clients. Avoid claiming that a third-party light-client backend is automatically private merely because its results are verified.

## Verification before shipping

- Connector tests capture SOCKS5 negotiation: A and B receive distinct nonempty tokens; repeated A work uses A's token; destination names are sent to SOCKS rather than resolved locally.
- Concurrent same-host RPC tests verify separate sockets/pools, no cross-context HTTP2/WebSocket reuse, and no mixed-address batches.
- Tests cover token propagation through fallback, retry, redirect, worker, SDK, and bundler routes, including failure injection with Arti unavailable. Observe all egress rather than only the nominal fetch wrapper.
- Use instrumented Arti or a controlled Tor network to verify incompatible contexts never share circuits. Exit-IP comparison cannot prove or disprove circuit isolation.
- Lock/profile/restart tests reject stale handles, stop queued work, and close private connections. Keep public receipt tracking separate from signing and secret-bearing operations.
- Examine logs, credentials, request bodies, and synchronized polling for remaining linkage. Measure cold/warm latency and resource use before choosing idle limits or more granular operation isolation.

These are proposed tests. No live circuit-isolation or egress test was run during this research.

## Ethereum Reads / anon-rpc follow-up

The [September source study](ethereum-reads-anon-rpc-research.md) adds a candidate network-client interface, not a substitute for these requirements. anon-rpc draft 0.3.0 has no standard per-account isolation field; its reference persistence is shared by specifier within the host origin. Separate worker instances therefore do not automatically isolate all account state. Bootstrap resolution and ambient worker networking also need explicit policy. Keep native Arti as the first baseline and test any anon-rpc worker against the same egress, lifecycle, and context criteria.

Tor hides neither the queried account from an ordinary RPC endpoint nor the response's trust requirements. Reads' PIR work targets query contents; Freedom should evaluate it separately, including private retrieval of associated proofs and fail-closed behavior for unsupported methods. Preserve the distinction between origin privacy, content privacy, and correctness in the broker's requirements and returned evidence.
