# Kohaku host integration for Freedom's wallet

> September 25 update: the source analysis below is the September 14 snapshot. Current upstream deprecated its Rust implementations and removed the previous Railgun package in commit `8ac0c528f63e1d43be7b662a1f2f7c15514ca61e`. Freedom now has a tested bounded host network adapter, but full protocol qualification remains open. See the [current implementation and source follow-up](../docs/privacy-engineering-followup-2026-09-25.md).

> Later September 25: open [PR #258](https://github.com/ethereum/kohaku/pull/258) provides a concrete PPv2 candidate and the actual GitHub Packages SDK name. Freedom now tests its exact HTTP adapter, restricted protocol reads, reviewed submission reconciliation, local artifact verification and worker cancellation. Full SDK/prover integration remains gated. See [the latest implementation and access findings](../docs/privacy-reconciliation-and-ppv2-2026-09-25.md).


Date: 2026-09-14. Status: source study and proposed implementation sequence.

**September 25 preflight:** the CLI still resolves to this document's `e7d8e9d` snapshot. Rechecked host assembly, protocol lifecycle, storage and Tor behavior for the PPv2 spike. Kohaku master `cae3525` restores only an empty Railgun placeholder. The initial checkpoint was gated by source access. After invitation acceptance, the v2.0 SDK builds and independent derivation plus a real separate-process proof pass. Full adapter typechecking finds missing finalized-block and `EXIT_PENDING` support; Node-worker proving fails in a transitive runtime. [Current SDK qualification](../docs/ppv2-sdk-qualification-2026-09-25.md). [Preflight and resume point](../docs/ppv2-integration-preflight-2026-09-25.md).

This is a new study, not a reconstruction of the earlier document with this filename referenced by the July privacy roadmap. It incorporates the supplied message recommending Kohaku's SDK, plugin/host interfaces, and Kassandra's CLI.

Scope: static inspection of source, tests, package manifests, and upstream issue discussion. No wallet was imported, no transaction was submitted, and no SDK proving, recovery, or Electron packaging test was executed. Findings about supported operations describe the inspected implementation, not independent production qualification. The older roadmap's legal and ecosystem claims were not revalidated.

Inspected revisions:

- Freedom: `b5fd764c67b2eaeb0dee4283018699e584f6413c`.
- [ethereum/kohaku](https://github.com/ethereum/kohaku/tree/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76): `1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76`, September 14, including the Privacy Pools v1 paymaster change.
- [kassandraoftroy/kohaku-cli](https://github.com/kassandraoftroy/kohaku-cli/tree/e7d8e9d54661cbfe3134a7afa415910adad0e711): `e7d8e9d54661cbfe3134a7afa415910adad0e711`, September 7.

The CLI pins plugins `0.0.1-alpha.13`, Railgun `0.0.1-alpha.30`, and Privacy Pools `0.0.2-alpha.16`. These are the CLI's declared versions; this study did not compare installed npm tarballs against the SDK checkout. A prototype must pin and test its actual published dependency set.

## Recommendation

Start the wallet work now by making Freedom a Kohaku host, preserving the existing vault, public accounts, signer factory, transaction approvals, and chain-data router. Build a small protocol adapter layer around the SDK. Railgun supplies an implemented plugin for the first host experiment; **Privacy Pools v2 remains the Privacy Pools product target**. PPv1 is an optional reference/test adapter, not a required shipping milestone.

September 14 follow-up: the initial recommendation conflated the unfinished Kohaku PPv2 adapter with availability of PPv2 itself. PPv2 has [documented Sepolia deployments](https://privacy-pools-v2-docs.vercel.app/deployments/sepolia) and an [early-access SDK](https://privacy-pools-v2-docs.vercel.app/introduction/quickstart). Once access is available, evaluate a direct PPv2 SDK adapter behind Freedom's interface if Kohaku's adapter is still incomplete. See [the updated PPv2 research](privacy-pools-research.md) for access evidence, key derivation, recovery, and deployment gates.

Here, “Kohaku compatible” means implementing the SDK's host contract and interoperating with selected protocol plugins at pinned versions. The reviewed material supplies no universal wallet certification or guarantee that every plugin supports the same chains, assets, accounts, or operations.

The broad gateway roadmap need not block an isolated testnet prototype. A user-facing privacy feature does need controlled networking for every protocol request, including RPC and requests made outside the nominal host interface.

## The integration contract

The [actual Host source](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/plugins/src/host/index.ts) is more current than the README: storage and derivation are asynchronous, storage has a brand field, and an optional external event-sync provider exists.

| Host facility | Freedom implementation proposal |
| --- | --- |
| `network.fetch` | Approved endpoint and transport broker for ASP, indexer, relayer, bundler, and artifact requests, carrying explicit account/service isolation context. |
| `provider` | Adapter over `src/main/networks/chain-data-router.js`, preserving chain policy and tracking verification provenance separately from SDK values. |
| `storage.get/set` | Encrypted, atomic persistence scoped by profile, privacy account, protocol/version, and chain. |
| `keystore.deriveAt` | Vault-mediated derivation with protocol-specific algorithms and explicit path restrictions. Never expose the mnemonic to page or renderer code. PPv2 additionally needs its documented signature-derived key flow; do not force it into PPv1's path-based scheme. |
| `externalSyncProvider` | Optional acceleration for historical events; qualify integrity, completeness, and on-chain anchoring before enabling. |

The [plugin types](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/plugins/src/base.ts) describe balances, optional notes, shielding, private transfers, and unshielding through capability-dependent methods. Those feature flags are TypeScript types, not a complete runtime capability-discovery API. Freedom should own explicit capability descriptors for each pinned adapter.

Broadcast is not universally `broadcastPrivateOperation()` as shown in the README. The current code has a separate broadcaster contract; Railgun implements `broadcast()` itself, while the CLI constructs a separate Privacy Pools broadcaster. Public-operation shapes also vary: Railgun returns transaction arrays, while Privacy Pools v1 returns `{ txns }`. See the [CLI's shield normalization](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/lib/shield-flow.ts) and [broadcast dispatch](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/lib/unshield-flow.ts).

## What exists today

| Adapter | Inspected implementation | Initial Freedom treatment |
| --- | --- | --- |
| Railgun | Shield, private transfer, unshield, notes, sync, and proof-of-innocence integration. Rust/WASM implementation. Built-in chain configuration covers Ethereum and Sepolia. | First experimental vertical slice; qualify sync, recovery, proving, and sponsored submission. |
| Privacy Pools v1 | Shield, unshield, notes, pending/approved balances, sync, and public ragequit. Built-in entrypoints cover Ethereum and Sepolia. | Optional reference/test adapter; retain distinct capabilities if used. No required PPv1 release. |
| Privacy Pools v2 | Kohaku's exported factory returns empty operations/balances and includes placeholder parameters. PPv2 itself has a documented Sepolia deployment and early-access SDK. | Product target. Obtain SDK access and qualify either a completed Kohaku adapter or a direct SDK wrapper. |

Sources: [Railgun plugin](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun-ts/sdk/plugin.ts), [Railgun chain configuration](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun/src/chain_config.rs), [PPv1 interfaces](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/privacy-pools/src/v1/interfaces.ts), [PP configuration](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/privacy-pools/src/config.ts), [PPv2 placeholder](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/privacy-pools/src/v2/index.ts).

Do not infer Base/Gnosis support from Freedom's chain support, or other Railgun deployments from the wider Railgun ecosystem. The inspected adapters' default configurations are narrower. Likewise, protocol support does not imply private transfers between different pools or protocols.

Both the [Railgun](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun-ts/README.md) and [Privacy Pools](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/packages/privacy-pools/README.md) packages explicitly identify themselves as unaudited and not production-ready. This supports starting engineering now with an experimental boundary, not declaring a production wallet integration complete.

## Compatibility and lifecycle findings

### 1. Railgun derivation needs its own algorithm

Kohaku's default `MnemonicKeystore` uses standard secp256k1 BIP-32. Railgun's reference tree uses the `babyjubjub seed` HMAC construction. Identical mnemonic and path strings therefore do not imply identical Railgun keys. This is documented in [issue #243](https://github.com/ethereum/kohaku/issues/243) and proposed [fix #244](https://github.com/ethereum/kohaku/pull/244), which were open in the inspected upstream pages.

The [CLI keystore](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/host/keystore.ts) already selects `deriveRailgunKey` for Railgun and ordinary derivation for other protocols. Freedom needs known-answer tests against the reference implementation and a restore test into an independent compatible client. Copying only the host method signatures would miss this.

Restrict derivation separately for each plugin. A generic method accepting arbitrary paths must not expose Freedom's existing public-wallet, Ant, IPFS, Radicle, or publisher keys. Keep protocol paths stable for portability and persist an explicit derivation/version descriptor.

### 2. The CLI's public-account paths collide with Freedom's Ant identity

The [CLI derives public accounts](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/utils/public-accounts.ts) as `m/44'/60'/0'/0/index`.

Freedom's `src/main/identity/derivation.js` derives user wallets as `m/44'/60'/accountIndex'/0/0` and reserves `m/44'/60'/0'/0/1` for Ant. Therefore CLI public index 1 would be Freedom's Ant address if initialized from the same seed. Account zero agrees; subsequent indices do not.

Preserve Freedom's public accounts. Map protocol account indices explicitly; do not import the CLI's fresh-address allocator. Any future per-origin account scheme needs its own recovery specification.

### 3. Host networking alone does not cover all traffic

Railgun's Rust implementation creates HTTP clients for [Subsquid](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun/src/indexer/syncer/subsquid.rs), [proof-of-innocence services](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun/src/poi/client.rs), and [proving artifacts](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/railgun/src/circuit/remote_artifact_loader.rs). These are not simply calls through the supplied host fetch function.

The [CLI's Tor integration](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/utils/tor.ts) patches global fetch and provides a local bundler proxy to cover WASM/worker paths. It deliberately leaves Ethereum RPC direct. Freedom's current `tor-proxy.js` is also explicitly limited to `.onion` page traffic, while chain-data RPC uses Node fetch.

Consequently, neither an installed Arti binary nor a Tor-aware `Host.network` establishes complete transport coverage. Prefer upstream injectable transports; meanwhile evaluate a controlled plugin subprocess with all egress brokered. A JavaScript fetch wrapper alone is not an OS network sandbox. Verify routing and failure behavior experimentally before making privacy claims. Do not apply the CLI's global fetch patch to Freedom's whole main process.

Tor routing must also isolate public addresses and private accounts. Pass an explicit privacy context through the router and all SDK transports, map it to opaque local Arti SOCKS isolation tokens, partition connection pools and account-specific state, and split/refuse RPC batches that mix unrelated accounts. The inspected CLI host has no explicit per-address isolation policy; this is a source finding, not a live traffic test or a claim about every Kohaku consumer. Chromium's SOCKS proxy configuration cannot supply authentication tokens, so Freedom needs a wallet transport connector or scoped local bridge. See [Tor circuit isolation research](tor-circuit-isolation-research.md) for the mechanism, residual correlation, and acceptance tests.

Keep circuit artifacts distinct from wallet-private state. Pin artifact versions and trusted digests; the inspected Railgun loader defaults to a mutable GitHub branch path and does not itself check a pinned content digest. A cache hit is not an authenticity check.

The [Ethereum Reads / anon-rpc follow-up](ethereum-reads-anon-rpc-research.md) identifies a possible network-client layer beneath this broker. It is distinct from Kohaku's protocol adapters and must receive no keystore/signing capabilities or PPv2 derivation signatures. Its draft browser harness does not automatically provide account isolation or content-private queries. Retain native Arti as the immediate baseline; evaluate anon-rpc and PIR separately without delaying PPv2 access and wallet work.

### 4. Public signing and private spending have different trust boundaries

Freedom already has `getSigner()` and a transaction service that keeps raw public-account keys out of callers. Ordinary shield transactions should use these paths with normal approval and fee handling.

Kohaku plugins also hold protocol spending/viewing material derived through the host. Railgun's current sponsored broadcast path prepares an ERC-4337 UserOperation, signs using an EIP-7702 account, submits, waits, and syncs. Its exposed [WASM signer constructor](https://github.com/ethereum/kohaku/blob/1c54b37854ee080cd16fbb5ec6844cfd8ddc3f76/crates/userop-kit-ts/src/signer.rs) takes a private key. This is not automatically compatible with Freedom's Ledger/remote signer abstraction. The CLI uses a wallet-owned delegator key; do not silently hand a primary public-account key to a plugin to reproduce that convenience.

Start private-account support with vault-backed accounts. Treat Ledger, phone, and Safe support as separate capabilities. A device being able to fund a shield transaction does not mean it protects the resulting shielded spending key.

PPv2's [current key documentation](https://privacy-pools-v2-docs.vercel.app/concepts/keys) derives protocol keys from a canonical EIP-712 signature. Use the SDK's derivation and preserve its exact signing payload and rotation metadata; do not copy PPv1 BIP-32 derivation. Protect this internal signature as secret key material. Qualify deterministic re-derivation and independent restore for each signing backend. Current documentation does not establish a blanket requirement to wait for “Ledger support in v2.1,” nor does hardware signature support imply device custody of the resulting protocol keys.

Railgun's high-level `broadcast()` also performs preparation and fee work before signing, and returns no receipt value. The CLI wraps its bundler method to recover the operation hash. Freedom needs a deliberate prepare/review/execute/track adapter, with approved fee limits and resumable submission status, rather than relying on that workaround as a durable API. Some lower-level SDK operations are exposed, but the exact composition needs a prototype or upstream API change.

### 5. Runtime objects and storage need browser-grade lifecycle handling

Railgun operations contain WASM builders and can contain callback functions. They are not renderer-facing JSON transaction objects. Keep them in the runtime and return opaque operation IDs plus reviewable summaries. Bind IDs to profile, privacy account, chain, exact intent, and an unlock generation; invalidate them on cancellation, profile changes, or lock.

The [CLI reuses Railgun sessions](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/lib/railgun-session.ts) and its [storage adapter](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/host/storage.ts) retains a decrypted map and password in closures. This is useful reference code for a CLI, but Freedom must terminate private workers, stop signing and new egress, and release secret-bearing state when the vault locks. If submission already occurred, track its public status rather than suggesting lock can undo it.

Use atomic persistence, single-writer serialization, schema versions, and tested restoration. Distinguish reconstructible chain state from imported secrets and metadata. Prove seed-only recovery for the supported deterministic path; do not promise seed-only recovery for arbitrary imported material.

## Proposed Freedom shape

Keep privileged ownership in the main process. The renderer receives capabilities, balances, progress, and transaction summaries through narrowly scoped IPC. A main-owned privacy coordinator mediates approvals and runs SDK work in a dedicated runtime; whether to use an Electron utility process or another subprocess should be decided by the packaging and isolation spike.

The adapters should expose a stable Freedom-facing vocabulary: sync, list balances/notes, prepare shield, prepare transfer where supported, prepare unshield, review, execute, cancel, and retrieve status. Include protocol/version/chain on balances and actions. Separate spendable amounts from pending or restricted amounts and fee reserves. Privacy Pools' pending tag and Railgun's POI status should remain visible in the model.

Use a single privacy-account concept that can own multiple protocol-specific balances. Do not display them as one fungible balance or automatically move funds between protocols. Likewise, PPv1's current `instanceId()` returns a placeholder `0x1`; it cannot be used as a universal receive address or stable account identifier. Supply recipient/address semantics per adapter.

## First milestones

1. **Host, runtime, and isolated networking spike.** Pin the SDK dependency set in an isolated experiment. Verify ESM/WASM loading in development and a packaged Electron app. Establish derivation vectors, restricted keystore access, profile/account storage, RPC adaptation, and a network inventory. Implement and test account-scoped Tor routing, connection separation, and fail-closed behavior alongside the host. Demonstrate lock cancellation and restart. In parallel, seek PPv2 SDK access and confirm the matching deployment/artifact versions.
2. **Railgun testnet flow.** Shield a test asset, sync, distinguish spendable state, prepare and approve a private transfer/unshield, track the UserOperation and transaction receipt, restart, and restore from the declared backup. Measure cold/warm sync, memory, proving latency, and cancellation. Test POI explicitly: the inspected upstream plugin broadcast integration test states that it does not verify TXID/POI functionality.
3. **Privacy Pools v2 testnet flow, once SDK access is available.** Qualify signature-derived keys and restore; register the keystore before presenting the deposit flow; exercise deposit, ASP pending/active state, private transfer, withdrawal, and recovery. Verify all RPC/HTTP/prover/relayer paths obey the transport policy. Wrap the SDK directly if necessary; do not wait solely for Kohaku's adapter. PPv1 can optionally exercise a second host adapter while access is pending, but is not a dependency of this milestone.
4. **Product integration.** Add the experimental wallet controls after these boundaries work, then decide production scope. Gate mainnet on the actual contracts, artifacts, audits/license, recovery, and egress tests. Extend chain coverage and device support only with independent qualification; Base/Gnosis availability need not block Sepolia engineering.

The first user-visible slice should be small: one software privacy account, one test network, explicit protocol balances, shield, and unshield to a selected or fresh Freedom account. Private transfer can follow where supported. Defer dApp APIs, automatic pool selection, cross-protocol routing, and per-origin funding until the core lifecycle is reliable.

## Follow-up topics for Kohaku maintainers

- Stable derivation vectors and the intended resolution of #243/#244; recovery compatibility with existing Railgun clients.
- Injectable transports with explicit account isolation context for every WASM/worker request and artifact loader.
- A supported separation between preparation, exact fee review, signing, submission, and receipt/status retrieval.
- Callback/device signers for the sponsored path, without exporting existing public-wallet keys.
- Runtime cancellation/disposal and multi-account isolation expectations.
- Which published versions are recommended for Electron, what their audit scope covers, and the plan for connecting PPv2's early-access SDK to the exported Kohaku placeholder. Coordinate SDK access/deployment compatibility with 0xbow separately.

These are proposed discussion topics; no maintainer messages or issues were sent.
