# ENSv2 registration and renewal repair (#1005)

Research snapshot: 2026-11-09. Branch: fix/ensv2-domain-registration.

## Verified facts

- ENS officially retired v1 registration and direct renewal. New registrar is 0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81; legacy renewer is 0x56c447f308f463a01121c41e72b0e7e7557fcb68.
- Official deployment/source revision: ensdomains/contracts-v2@4f47cbcc11462fb413196e6b5c0f8090247a6c08.
- Read-only mainnet snapshot 0x192817e, independently checked through ethereum.publicnode.com and rpc.flashbots.net: v1 controller authorization false; seven new runtimes agree between RPCs and match the published artifacts after masking constructor immutable slots.
- New registrations/renewals pay ERC20 USDC or DAI; ETH remains required for network fees. No ETH price-buffer/refund semantics apply to the new registrar. It transfers the actual quoted token price with safeTransferFrom.
- Legacy reserved names renew through ETHRenewerV1; registered/migrated v2 names through ETHRegistrar. ENSv2 grace is 28 days. Legacy reservation/grace handling is contract-derived, not guessed from v1's old 90-day rule.
- New names also need a usable resolver. PublicResolverV2 uses the legacy NameWrapper.names mapping; blindly assigning it to fresh names does not provide a complete record-writing flow. The official permissioned resolver supports DNS-encoded-name setters and can be deployed through the VerifiableFactory.

## Implemented boundaries

Keep domain service/journal/wallet responsibilities. Extend the typed naming adapter rather than accept arbitrary contracts or ABIs from Agent.

1. Pin official ENSv2 registrar, registry, legacy renewer, oracle, resolver implementation and factory with mainnet runtime identities and immutable bindings; maintain v1 read/record support.
2. Default ENS payment to USDC, optionally DAI, with token balance/allowance inspection. Require a separate exact bounded ERC20 approval where needed, and disclose token price separately from ETH gas. Never request unlimited approval or reuse an unrelated larger allowance as an undisclosed spend ceiling.
3. Preserve commit/reveal secrets, age waits, exact wallet approval, journal-before-signing and uncertain-broadcast recovery. Persist additional setup/payment steps instead of treating them as completed purchases. Old v1 commitments cannot be silently replayed on v2.
4. Deploy/reuse a pinned official permissioned resolver with the wallet controlling its records, explicitly approved and verified; support website/address/text writes with v2 encodings. Never silently replace an owned name's custom resolver.
5. Route v1/v2 renewal from current registry state, retain ownership/records and verify post-receipt expiry.
6. Qualify with unit tests plus isolated local Anvil forks of mainnet and Sepolia. No real name was purchased and no real wallet was used.

## Qualification and limitations

- Mainnet runtime identities were checked from two independent RPC responses at
  block `0x192817e` and matched official artifacts with constructor immutable
  offsets masked. Product writes require the full observed runtime identity and
  the expected oracle/registry/legacy-renewer bindings, not just a matching ABI.
- Official Sepolia deployments in `scripts/fixtures/ensv2-sepolia.json` were checked
  from PublicNode and 0xRPC at `0xb89db4`, with exact runtime agreement and artifact
  comparison. Those overrides exist only in the local qualifier.
- The fork qualifier uses production DomainChain, DomainService, operation store
  and DomainTransactions with an isolated Anvil signer. It checks registration,
  USDC/DAI payment stages, renewal, text/address/website/clear, restart during the
  commitment wait, preservation of unrelated records and replay without sending.
  Mainnet also checks legacy unwrapped/wrapped renewals and WNS/GNS regression.
- The Electron fixture renders production ENSv2 approval presentations at 1000px
  and 600px in both themes. It verifies separate headings, token prices, bounded
  permissions, responsive overflow and reachable approval controls.
- All 145 focused domain/tool/wallet/approval tests passed, plus 44 changelog
  guard tests; lint and diff checks passed. The native Electron approval test
  passed in both themes at 1000px and 600px.
- Unit coverage includes changed price/allowance/resolver authority, token balance
  rejection before commit, canonical setup-event/receipt recovery without archive-state dependence, uncertain setup
  nonce floors, explicit resume after reverts, old v1-plan retirement, custom
  resolver reads, long ENS labels and legacy wrapper-expiry synchronization using the pinned v1 wrapper’s 90-day constant (no public getter).
- Final production-source fork runs passed 33 approved fixture transactions on
  mainnet state and 15 on Sepolia state. An additional mainnet fork run verified
  that the browser’s existing Universal Resolver returns the new name’s exact
  Swarm contenthash through its permissioned resolver (not just direct adapter
  reads). Claude independently reviewed three rounds; no material findings remain.
- Fork transactions do not leave localhost. ERC20 balances are seeded only in
  Anvil's disposable state, registration secrets use a temporary encrypted store,
  and website references are synthetic. This is not a paid mainnet transaction,
  live Swarm retrieval, physical hardware-wallet or packaged-platform smoke test.
- An oracle or immutable deployment change intentionally blocks writes until
  qualified. Unknown resolvers remain readable as ownership/expiry information,
  but record contents and writes are unavailable. No automatic resolver
  replacement, migration, token swap, currency bridge or name transfer is added.

Reproduction commands and user-facing scope are in
[domain management](domain-management.md#qualification-and-smoke-testing).

## Primary references

- https://docs.ens.domains/registry/eth/
- https://docs.ens.domains/ensv2/eth-registrar/
- https://docs.ens.domains/learn/deployments/
- https://docs.ens.domains/web/ensv2-readiness/
- https://github.com/ensdomains/contracts-v2/tree/4f47cbcc11462fb413196e6b5c0f8090247a6c08
