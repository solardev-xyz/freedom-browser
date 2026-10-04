# Railgun Kohaku public Shield implementation plan — October 4, 2026

The **public facade remains unimplemented**. The lower-level
[Shield lifecycle prerequisites](railgun-shield-prerequisites-2026-10-04.md) now
have focused and controlled native qualification; that is not yet a public Shield
capability. The implementation gaps below describe the original plan, with those
completed prerequisites called out. The current [Kohaku facade](../src/main/wallet/railgun-kohaku-plugin.js)
offers read and private-operation modes. Its
[private broadcaster](../src/main/wallet/railgun-kohaku-broadcaster.js) deliberately
does not accept public Shield operations. Implementation stays in the existing
main-process wallet boundary; renderer/IPC integration and user-facing UX remain
separate work.

## Compatibility and initial scope

The canonical local Kohaku checkout at
`tmp/privacy-build/pinned-inputs/kohaku` is pinned at
`6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Its locally inspected
[transaction feature interface](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/base.ts)
defines `prepareShield(asset, to?) -> Promise<PublicOperation>`, and its
[shared types](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/shared.ts)
define native assets as `{ __type: 'native' }` and amounts as `bigint`.
Its [broadcaster](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/broadcaster/base.ts)
accepts `PrivateOperation`, not `PublicOperation`. These shapes support a narrow
compatible adapter; they do not establish generic Kohaku Host compatibility.

The first public lane should accept one positive native ETH amount and only the
enrolled recipient: omitted `to`, or exactly its genuine `instanceId`. Return a
frozen `{ __type: 'publicOperation' }` token privately bound to the issuing plugin
and genuine Shield controller. A separate main-owned public submitter should
consume that token; it must not use the private broadcaster or expose arbitrary
transaction signing. Names and facade configuration remain implementation choices.

The existing [pins](../src/main/wallet/railgun-shield-pins.json) and
[calldata policy](../src/main/wallet/railgun-shield-policy.js) restrict this to
Sepolia, at most **0.01 ETH**, with a pinned **25 bps** Shield fee. The exact
RelayAdapt operation wraps ETH and shields WETH; the resulting note value deducts
the integer-rounded protocol fee. Preserve these qualification caps. ERC20
approvals, arbitrary recipients, batches, arbitrary RelayAdapt calls, other chains
and mainnet are outside this slice.

## Existing implementation to reuse

- [Preparation](../src/main/wallet/railgun-shield-prepare.js) issues genuine,
  expiring receipts for exact calldata. Its
  [utility job](../src/main/wallet/railgun-shield-job.js) uses fresh ephemeral
  encryption material without wallet-secret, network or storage access.
- [Receiver verification](../src/main/wallet/railgun-shield-receive.js) uses the
  enrolled identity's viewing credential to check that the prepared note is
  recoverable by that account.
- [Deployment preflight](../src/main/wallet/railgun-shield-preflight.js) checks the
  pinned contracts and fee against a single RPC block. This is RPC consistency,
  not authenticated chain state or a guarantee against later governance changes.
- [The Shield operation](../src/main/wallet/railgun-shield-operation.js) combines
  these receipts with EOA-only funding, simulation, gas/nonce/balance review and
  single-use signing authority. The
  [transaction service](../src/main/wallet/transaction-service.js) and
  [transaction network](../src/main/wallet/private-transaction-network.js) enforce
  its genuine guard at signing and broadcast, with durable journal-before-send.
- [Restart recovery](../src/main/wallet/railgun-shield-recovery.js) reads the
  public-address submission journal independently of expired preparation receipts,
  matches the exact Shield event and requires reviewed, rechecked finality for
  resolution. [PPv2's public handoff](../src/main/wallet/ppv2-public-operations.js)
  provides a local precedent for issued, single-use public operations, not a reason
  to bypass Railgun's own controller.

## Required implementation gaps

1. **Propagate reviewed destinations — controllers implemented.** The Shield
   operation and recovery now accept optional caller lifetime and genuine
   destination constraints. The remaining facade must issue and own these;
   pass the protocol restriction through every permitted preflight attempt and
   permanently bind the transaction restriction to its transaction handle. The
   preflight already accepts `destinationConstraint`. Use the genuine
   [private-RPC constraint](../src/main/networks/private-rpc.js), covering hidden
   chain-ID, simulation, gas/nonce/balance and raw-send admission. Keep preview
   clients and restriction owners live until cleanup; never retry through an
   unrestricted replacement. Preserve existing unconstrained callers by default.
2. **Complete host lifetime handling — implemented.** Preparation and receiver
   verification now carry caller signals, bounded budgets and explicit closure
   ownership. The qualified implementation adds permanent
   refusal, cancellation before further key/result admission, borrowed credential
   callback tracking, unconditional child-closure observation and sanitized
   cleanup failures. Operation-level `closed` observes owned work and review/signer
   callbacks. A child or callback that ignores cancellation retains ownership.
   Neither `rpc.release()` nor such a logical barrier proves physical socket drain.
3. **Use the shared account phase — hosts implemented, facade pending.** An adopted
   [account wallet](../src/main/wallet/railgun-account-wallet.js) already holds the
   [wallet phase](../src/main/wallet/railgun-account-phase.js). Close and await it
   before Shield jobs. Preparation and receiver verification now claim the shared
   recovery phase, retaining it through borrowed work and child closure. The gap
   between account closure and the new claim must use a genuine supported phase
   handoff or fail safely on contention, before starting Shield jobs; facade-local
   exclusion does not prevent an external controller from winning that claim.
   The specific phase remains an implementation choice. The existing phase API
   rejects handoff tokens for `recovery`: if using that phase, retain the wallet
   handoff through account closure, then release it and synchronously claim
   recovery before any utility starts. A competing owner must cause a zero-job
   refusal, not an unprotected continuation.
   Release the phase before human transaction review only after the new cleanup
   barriers prove owned work has settled, while retaining facade operation
   exclusion through settlement. Existing Shield-local busy sets are insufficient
   for directory-wide exclusion. Do not allow concurrent private preparation in
   this facade or release a successor's owner during stale cleanup.
4. **Add two bounded review boundaries.** Before admitting new Shield key work or
   RPC requests, review the public funding address, native amount, resulting WETH,
   own recipient, fee and exact destinations. Explicitly disclose that the
   transaction RPC receives the funding EOA, amount and exact RelayAdapt Shield
   calldata, including the encrypted note, through `eth_estimateGas` and `eth_call`
   before the later transaction review. Approving this first review permits those
   simulations, not signing or sending. This is a proposed review boundary, not a
   property of today's controller. Already-admitted work in the adopted account
   has its own drain obligation; a review callback or facade flag cannot establish
   zero traffic or release that work's phase. Then use the existing transaction
   review for exact calldata, gas, balance and nonce. Public preparation needs an
   engine archive, not private spend-prover configuration. Preserve the original
   nonrenewing preparation and deployment freshness limits; time spent reviewing
   must not renew authority.
5. **Issue and consume only genuine public tokens.** Bind each token to its exact
   plugin/controller and reject copies, cross-plugin use, reuse and expired owners
   before signing. Preserve acknowledged or journal-backed uncertain outcomes even
   when later cleanup fails; never turn an attempted send into permission to retry.

Shield does not require input-note selection, a retained-source snapshot, POI
services or private-spend proof machinery. Existing facade owner/currentness checks
can remain without adding source-coordinator queries to this lane.

## Facade implementation decisions after prerequisite review

The planned API is `mode: 'public'` on the existing instance, with
`prepareShield({ asset: { __type: 'native' }, amount }, ownInstanceId?)` and a
separate `createRailgunKohakuPublicSubmitter(plugin).submit(operation)`. This is
not implemented yet. Preserve read/private modes, require the engine archive and
two reviewers, and reject private-prover/artifact configuration in public mode.

Do not copy private preparation's pre-review `getSigner(0).getAddress()` call:
the vault signer borrows its private key to derive that address. Read the public
`identity-manager.getWalletRecord(0)` metadata instead, require a known mnemonic
record with a stored address, and refuse absent metadata without deriving a
fallback. Snapshot and recheck the index/type/address. Resolve the genuine signer
only after approval, and let the existing Shield controller authenticate its
address before signing. Test fixtures must establish real public wallet metadata;
they must not patch this check away.

For index 0, `getWalletRecord` may fall back to the stored
`meta.addresses.userWallet` address and normalize a missing type to mnemonic;
these metadata-only defaults are acceptable. No stored address means refusal.
Use that snapshotted address as the transaction preview's principal and the
controller's owner. Mint both destination restrictions for the entire outer public
budget, covering review, token waiting and submission admission. Expiry during
already-admitted work must preserve journal uncertainty and cleanup ownership.

Retain the genuine wallet handoff through the original preparation-review
callback and awaited account closure. The private lane currently releases its
review handoff on approval; public Shield needs a distinct retention path. Release
the handoff and immediately call `openRailgunShieldOperation` in the same turn,
without an intervening await. Do not preclaim recovery in the facade or pass a
wallet-handoff token to the recovery phase. The hosts claim their own phases;
contention must cause refusal before a utility starts.

Adopt any controller returned after cancellation and observe its `closed` before
checking currentness. A failed opening may itself stay pending if cleanup cannot
be attested. Outward cancellation must not release facade ownership while that
original work remains. Start a nonrenewing public budget before preparation review
and keep it through token waiting and submission; do not copy the private lane's
timer clearing after preparation or its broadcasting exemption. A 120-second
outer budget must not extend the controller's own, shorter remaining authority.

Consume genuine public tokens synchronously before submission. Preserve the
controller's acknowledged and journal-backed uncertain/unresolved outcomes without
a later currentness check hiding them. Cleanup remains separate: an outcome may
settle while the facade's closure still cannot. An unsubmitted Shield token has no
private signed capsule, so do not mark it as private signing recovery merely
because it expired. After the adopted account closes, balance/note reads must
refuse until a refreshed account is adopted; resolving the public journal alone
does not ingest the new private note.

## Fresh recovery review

The restart recovery entry point now accepts optional caller lifetime and a reviewed
transaction destination constraint. Its future facade must obtain a fresh genuine observation
and review; do not deserialize old WeakMap tokens or treat a stored URL as authority.
Keep recovery separate from operation preparation and do not silently reprepare or
resubmit an uncertain transaction.

An included transaction without the exact expected Shield event remains unresolved.
An accepted resolution still uses the existing finality and receipt rechecks, whose
chain evidence remains RPC-based. Wallet note ingestion requires a later explicit
scan/account refresh: resolving a journal entry does not itself establish an updated
spendable balance. Recovery closure should observe its own callbacks and requests;
it must not claim a physical transport barrier that the underlying API lacks.

## Sequenced implementation and qualification

1. Completed in the prerequisite milestone: harden the two utility hosts and Shield operation lifetime/phase ownership;
   propagate constraints into operation and recovery while preserving legacy
   callers. Test malformed-then-valid broker traffic, late credential callbacks,
   cancellation, throwing cleanup, rejected closure and held child/review barriers.
2. Add the narrow Kohaku `prepareShield` capability and separate public submitter.
   Test exact native/self-recipient validation, fee/cap bounds, genuine token
   identity, reuse refusal, account closure before phase claim and no private
   broadcaster route. First-review denial must cause zero subsequent Shield
   traffic/key work/signing. On approval, assert exactly one `eth_estimateGas` and
   one `eth_call` with the expected Shield calldata before transaction review,
   with zero signatures and raw sends at that boundary. Transaction-review denial
   must still leave signing and raw-send counts at zero; it cannot undo the
   already-approved simulation disclosures.
3. The existing
   [Shield submission qualifier](../scripts/qualify-railgun-shield-submission.js)
   now has an entirely offline mode using disposable profiles and intercepted
   services. Set `FREEDOM_RAILGUN_SHIELD_OFFLINE=1` and supply the pinned-bytecode
   fixture; without this opt-in it still performs live deployment reads over Tor.
   The prerequisite report qualifies real preparation, receiver verification,
   deployment-check code, signing, journal-before-send, uncertain acknowledgment,
   held-review cancellation and in-process recovery. Same-host/different-path
   destination changes and reentrant admission are focused-test evidence. Extend
   the native runner with the genuine public facade and both review boundaries;
   the current report does not qualify that unimplemented composition.
4. Run focused and relevant legacy tests, lint and the combined regression on the
   frozen implementation; inventory the exact native sources. Label mocked
   transport/service results separately from genuine utility, signing and encrypted
   journal evidence. Live or funded qualification is a separate decision, not
   authorized or performed by this plan.

This plan does not itself establish compatibility or runtime success. Completed
prerequisite evidence is linked above; the public facade and its composed native
qualification remain open.
