# PPv2 live qualification prerequisites

This is the concrete handoff needed to move the controlled Kohaku/PPv2 experiment onto live Sepolia. It does not authorize a transaction, enable a product feature, or assume the final upstream release is available. No new outreach has been sent.

**September 29 result:** [Read-only live qualification](ppv2-live-preflight-2026-09-29.md) confirms matching proof verifiers and ASP leaves. The concrete blockers are relayer HTTP 403 through Tor and incomplete historical logs from the tested public RPC. Staging quotes have approximately 60-second lifetime; that is not an upstream blocker. Complete the unfunded session/recovery checks before requesting Sepolia ETH. The generic checklist below remains the production handoff, not a request to ask PP again for every already published value.

## Published environment checked on September 28

The [live v2 frontend](https://v2.privacypools.com/) publishes Sepolia staging configuration. The [Sepolia deployment documentation](https://privacy-pools-v2-docs.vercel.app/deployments/sepolia) already provides a V9 deployment and service configuration; discovering a deployment is not an upstream blocker. These are candidate configuration values to verify against our pinned SDK and on-chain state, not an approved signing configuration.

- The public [dev ASP entrypoint feed](https://api-dev.0xbow.io/global/public/entrypoints) responded with Sepolia pool ID `4`, pool `0x09b94d3127019298757A6ceeB7911922085f7C01`, entrypoint `0xEB3e3961008952348445513e418ad6F43C23ca9a`, and `fromBlock: 10994884`. The feed also lists an older Sepolia pool, so selecting only by chain ID is insufficient. Its response carried `cacheTimestamp: 2026-09-24T19:09:31.909Z`; this is not fresh on-chain evidence, nor proof of the correct keystore recovery start block.
- The public [staging relayer details](https://relayer-v2-staging-149184580131.us-east1.run.app/v1/details) responded with chain `11155111`, the same pool/entrypoint, and ETH, USDC and USDT assets. Service-reported assets and fees still need comparison with contract configuration.
- **Concrete documentation drift:** the relayer reports processor `0x7430cc030d7eb8C83E76cD983996982C8C054204`. The current frontend's public `CURRENT_RELAY` constant agrees, whereas the Sepolia docs and quickstart show `0x762665Dc7aAeeA25DC1759AEBef1F61730497f6e`. Do not copy the older processor into our configuration. Verify the current contract, quote signer and signed-quote binding before use; `/v1/details` did not identify the quote signer.
- The downloaded frontend publishes staging ASP `https://api-dev.0xbow.io`, the documented Sepolia pool and keystore, and the same staging relayer URL. Inspection was static, read-only inspection of public JavaScript and GET service responses, not a connected-wallet flow or proof that deposits/relaying currently succeed. No wallet identifiers or secrets were sent.

Extract and cross-check these published values before asking PP for information. Remaining questions should focus on compatibility/provenance, any unresolved signer or deployment discrepancies, and test onboarding/approval behavior. The production audit remains a release gate; a completed audit is not required merely to conduct a bounded disposable testnet experiment.

## Information to confirm with Privacy Pools

| Item | Exact information needed | Why it matters |
| --- | --- | --- |
| Source and distribution | Intended SDK commit/tag; matching Kohaku adapter revision; maintained package/artifact distribution and redistribution terms | Our current SDK pin is `fe0244e3f14110efd83db02c60c96517dea9cd5a`, with a local compatibility patch. A new release requires a deliberate diff and qualification. |
| Derivation and recovery identity | Final signing message/domain, derivation paths, account and revocable-key index rules, rotation discovery and legacy migration expectations | The same wallet must recover the same keys and notes after reinstall; changing the identity silently can strand funds. |
| Audit and setup | Audit report(s), exact audited commits, unresolved findings, circuit/verifier revisions and trusted-setup provenance | A version label or ready-for-mainnet statement is insufficient to bind the tested bytes to the reviewed deployment. |
| Sepolia deployment | Chain ID; pool, entrypoint, keystore, ASP registry and relay processor addresses; deployment blocks; implementation/proxy/admin details; expected runtime bytecode hashes and verifier addresses | Host grants, synchronization windows and proof verification must target one consistent deployment. |
| Circuits | Supported input/output shapes, zero-change/full-value withdrawal semantics, WASM/proving/verification key sizes and hashes | We currently qualify deposit, ragequit and positive-change transact 1×1. |
| ASP | Base URL; public key and identifier; applicable registry/set policy; test onboarding; pending/revoked behavior and expected update intervals | We must test real note eligibility and recovery, including outages and changing association sets. |
| Relayer | Base URL; EIP-712 quote signer/domain/processor; fee recipient; supported assets; quote lifetimes; exact retry/status semantics; test service availability | We must verify the complete signed handoff and uncertain-delivery recovery under actual Tor latency. |
| Assets and test conditions | Supported native/ERC-20 assets, decimals, minimum amounts, fees and test-funding route; service rate/body/range limits | Synthetic service defaults and fixture token addresses are not deployment configuration. |

## Work we can prepare locally

- Compare the provided revision against the currently qualified SDK and compatibility patch, especially registration, rotation, proof signals, note encryption, events, quote schema and broadcaster behavior.
- Bind reviewed code and circuit digests to explicit application configuration. The runtime archive pin authenticates the selected experimental bytes; it does not authenticate an audit or release process.
- Assemble a preflight report that checks matching chain/deployment/service configuration before making any signing capability available. Keep failure messages free of wallet secrets.
- Preserve the original source/package qualification as a historical record. A new runtime pin needs fresh controlled tests before live tests.

## Live Sepolia acceptance sequence

Run only after the configuration is established, using an explicitly authorized disposable test account and bounded test funds:

1. Confirm the expected derivation identity and registration. Refuse a conflicting immutable key; exercise viewing-key repair separately.
2. Deposit a supported asset through the reviewed host path and observe ASP pending → active state through Tor.
3. Withdraw with private change, restart, independently recover the change and perform a second spend. Record signed-quote timing from creation through delivery.
4. Exercise controlled uncertain handoff and subsequent reconciliation without automatic resend. Coordinate failure injection with the test-service operator; do not disrupt a shared service.
5. Exercise reviewed emergency exit and recovery. Verify the competing-relay warning and the separate resolution review.
6. Repeat the applicable flow for an explicitly supported standard ERC-20, including reset/exact approval.
7. Qualify a small explicitly reviewed archival batch through Tor after its age delay: inspect both canonical/finalized passes, review latency and the shared 120-second deadline; verify that reopening preserves reuse/exit guards. Archival deliberately stops revalidation of accepted remote evidence.
8. Record the exact source/package/artifact hashes, deployment configuration, platform, outcomes and remaining trust assumptions. Remote RPC/ASP evidence remains unverified unless a separately qualified verification mechanism is used.

Portable backups, whole-profile rollback protection, supported-platform containment, product approvals and mainnet activation remain separate release decisions. A successful Sepolia run does not close those gates.
