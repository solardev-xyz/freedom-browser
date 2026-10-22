# Domain management — experimental first slice

Integrated from `experiment/domain-skills`, this adds shared, profile-owned naming operations
with Freedom Agent as their first interface. It does not add a manual settings or
domain-management screen yet. A future UI can call the same service and continue
the same operations without an Agent conversation.

## Supported operations

Ethereum mainnet `.eth` (qualified ENSv1), `.wei` (WNS) and `.gwei` (GNS):

- Inspect availability, ownership, expiry and supported records.
- Register a top-level name to the selected local, Ledger or remote wallet, with
  separate commit/reveal approvals and a chain-time commitment wait.
- Renew a top-level name. ENS wrapped names use their distinct renewal controller;
  WNS/GNS add one 365-day year per transaction. Renewal does not transfer ownership.
- Point an active name at a completed, retrieval-verified Freedom Swarm website
  publication from the current conversation; remove its website on explicit request.
- Set one ETH-address or text record, preserving other records.

Existing ENS names must use the qualified public resolver; Freedom never replaces
a resolver as an implicit prerequisite. Changed/unrecognized contract runtimes
are refused. ENSv2 mainnet deployments do not imply v2 registration qualification.
The current ENS deployment documentation says v1 remains in use until the v2 launch;
deployment/controller/ABI checks remain mandatory when updating this adapter.

Transfers, primary names, subnames, other-chain addresses, delegate changes,
resolver migration, ENSv2 writes, marketplace/storefront/passport flows and bulk
work remain later slices. The research call matrix is not a claim these shipped.
Legacy WNS/GNS Unicode whose registered bytes differ from the conservative
normalization policy is refused rather than silently converted to another name.

## Shared service and wallet boundary

`src/main/domains/` owns contract-specific encoding, state inspection, semantic
plans, verification and durable operations. It imports no Agent implementation.
`src/main/wallet/domain-transactions.js` reuses Freedom's identity/signers,
chain-data routing, fee quotes and transaction recorder. The Agent adapter
`src/main/agent/pi-domain-tools.js` supplies the current approval surface and run
signal; the bundled `dweb-domains` skill supplies procedures, not authority.

The API is `inspect`, `prepare`, `execute`, `status` and `waitForOperations`.
Preparation has no signature or broadcast. The service chooses a bundled ABI,
deployment and operation; the model cannot supply a contract, calldata or secret.
Every transaction is simulated from the real sender, checked again after the
exact wallet approval, then journaled before handoff to the existing signer.
The approval shows the name, action, term, requested record difference, exact
payment, maximum gas fee and contract bytes. No approval mode auto-authorizes it.
An ETH-address approval also says whether the new address is one of the profile's
own Freedom wallets; main checks the wallet list, not the model's description.
Fee quotes must be complete before approval: an EIP-1559 cap without a priority
fee is refused like a missing or zero quote, never re-quoted at signing.
`domain_inspect` labels its result as untrusted data for the model: records are
set by whoever controls the name.

Registration (reveal) and renewal send the quoted price plus a disclosed 2%
buffer, the same margin the ENS manager app uses
([`CURRENCY_FLUCTUATION_BUFFER_PERCENTAGE`](https://github.com/ensdomains/ens-app-v2/blob/ffd39877139528cf54fc4df2a4db5e6c8cc6b2a5/src/utils/constants.ts)),
so an ETH/USD oracle update between signing and mining does not revert the
payment. The approval's amount is the buffered value and a separate row names the
price and the buffer. Every supported contract refunds the excess to the sender in
the same transaction: the pinned ENS
[ETHRegistrarController](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/ethregistrar/ETHRegistrarController.sol)
`register`/`renew` and the wrapped renewal controller's `renew` (its pinned
`solcInputs` source) via `transfer`, and WNS/GNS `NameNFT.reveal`/`renew` via
`safeTransferETH`. The ENS refund uses a 2,300-gas `transfer`; the pre-approval
simulation from the real sender refuses a wallet that cannot receive it.
The renewal amount is fixed when the operation is prepared: a lower current price
still sends the approved amount (refunding the rest), a higher one is refused.

Reads use Freedom's existing Ethereum chain-data policy. There is no independent
public-RPC fallback, indexer or new connection. Candidate-name queries can disclose
interest to the configured chain-data service. A transaction and its name/records
become public on Ethereum; naming does not make Swarm private or extend postage.

To check a bound Swarm site, the Agent opens `bzz://<name>/` and reports that named
URL. Explicit `https://<name>/` navigation uses ordinary DNS/HTTPS and does not
invoke decentralized-name resolution. Browser tool guidance covers this for
helpers as well as the main Agent; internal error/trust pages remain protected.

The current composition root is Agent runtime; the shared service has no Agent
session requirement. Ordinary browser startup and AI-off do not perform naming
network requests. An unreadable domain journal disables these tools without
overwriting the evidence or disabling browsing/other AI functionality.

## Persistence, secrets and recovery

`domain-operations.json` in the profile stores bounded public plans/receipts and
only **encrypted** registration secrets. Secret protection requires Electron
safeStorage with an OS-backed backend; Linux `basic_text` and unavailable
credential storage are refused. Secrets are generated in main and erased from
the saved operation after successful registration. File replacement is atomic;
in-flight and ambiguous records are not silently pruned. Each record carries a
revision and a save must name the revision it read: a status poll that read the
record before slow chain reads cannot overwrite a newer one (for example a
dispatched reveal's hash) and drops its write instead. A dispatch outcome is
always applied to the current record. The initial limit is
500 operations / 4 MiB; a manual retention/inventory interface is future work.

Secrets/preimages are excluded from model outputs, ordinary conversation history,
tool errors and transaction-error logs. A reveal's exact bytes remain inspectable
in the trusted wallet approval; after broadcast those bytes are public chain data.
`makeCommitment` preimage comparisons run only with public synthetic vectors on a
private fork, never by sending a real private preimage to a public RPC.

State progression is `ready` → `pending` → `waiting_commitment` → `ready` (reveal)
→ `pending` → `completed`. Record updates/renewals skip commitment stages.
Additional outcomes include `declined`, `stale`, `expired`, `dispatch_unknown`,
`verification_needed` and `failed`. Known operation IDs survive conversation
deletion and can be used from a later conversation. Default listing is scoped
to the current conversation; the shared journal remains profile-owned.

Pending confirmations/commitment waits keep the Agent turn alive without model
polling tokens, then return a receipt. Readiness is not authorization to reveal:
that step still needs its own exact wallet approval. Polling observation is
bounded at ten minutes; a later status call continues observing the same operation.
Stop cancels observation/future sends; it cannot undo already submitted effects.
An explicitly declined or provably unbroadcast step can be resumed on a new user
request with `domain_execute`'s `resume` flag and a fresh wallet approval. A paid
commitment is retained. That flag never overrides an uncertain broadcast.

Post-transaction checks use a block at least as recent as the confirmed receipt;
a lagging `latest` block cannot make a mined commitment appear absent. Status
also reconciles registrations previously stuck in `verification_needed` before
reveal: it rechecks the saved commit's successful canonical receipt, exact
transaction digest and current commitment. Valid commitments resume their age
wait or become ready for a separately approved reveal, without another commit.
Missing/reorganized receipts, mismatched transactions and uncertain reveals
remain blocked. An expired commitment is reported as expired, never repurchased.
A reveal that is mined but reverts (for example after a price move) consumes
neither the commitment nor the price. Within the commitment's maximum age the
operation returns to `ready` on the same commitment, and the next `domain_execute`
requotes it for a fresh wallet approval; after that age it is `expired`.

A crash during dispatch is uncertain, even with no returned transaction hash.
Preparing another operation for that name is blocked until reconciled. A recovery
hash from wallet history is accepted only after sender, destination, value and
calldata match the saved dispatch digest. Status never signs. Completed receipts
are checked against canonical blocks when inspected again. Successful writes with
delayed/mismatched resolution are verification problems, not permission to pay twice.

## Qualification and smoke testing

Local macOS evidence (October 22, production source through `9195e432`): lint
passes; the full suite passes **10,906
tests / 129 skipped** across 486 suites. All **50 domain tests** pass after the
fresh-block and saved-commit recovery fixes, including rejected receipts,
restart recovery and protection against repeating uncertain reveals.
The existing real Electron startup/open/close test also passes using a
disposable profile. These are source-build checks, not packaged Windows/Linux
or physical wallet-device qualification.

The maintainer live-tested `.gwei` registration, binding to a verified Swarm
publication and manually opening the named site. `.wei` and `.eth` remain
fork/automated-tested, without live paid qualification. The subsequent Agent
navigation-guidance repair has automated coverage, not a repeated live page check.
The Claude CLI can still report a transaction-tool timeout despite an eventual
successful transaction; reconcile the saved operation rather than resending.

Automated qualification does not purchase, renew or change real domains.
The fork qualifier runs against a deliberately local Anvil fork only, with an
impersonated disposable account and synthetic publication receipt:

```sh
anvil --fork-url <your-read-only-Ethereum-RPC> --host 127.0.0.1 --port 18549 --chain-id 1
node scripts/qualify-domains-fork.js
```

It exercises all three namespaces: commit, restart during the chain-age wait,
reveal, renewal, address/text/website/clear writes, preservation of other records,
receipt verification and completed-operation replay without another send.
It also creates a wrapped ENS fixture with the legacy controller and verifies
that the product's distinct renewal path extends base and wrapper expiries while
preserving ownership. These local-fork results are not live Swarm retrieval,
wallet-device or packaged-platform qualification.

For a safe first user smoke: “Check whether freedom-example-name.eth is available
and show its current domain information. Don’t register it or send a transaction.”
Then use a chosen owned name and an actually verified website publication to
test binding. Live registration needs the maintainer's chosen name and spending
budget; no automated qualification sends real transactions.

Pinned sources, deployment evidence and the broader implementation matrix:
[domain research](agent-domain-skills-research.md),
[ENS deployment docs](https://docs.ens.domains/learn/deployments/),
[ENS registrar](https://docs.ens.domains/registry/eth/),
[WNS source](https://github.com/z0r0z/wei-names/tree/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8),
[GNS source](https://github.com/lucadonnoh/gwei-names/tree/1155c82db1536ff0e1a66674bde84fe7fbf9f918).
