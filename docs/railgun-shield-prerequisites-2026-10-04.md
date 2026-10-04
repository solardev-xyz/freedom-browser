# Railgun Shield lifecycle prerequisites — October 4, 2026

The existing native Shield controllers now support caller cancellation, reviewed
RPC destinations and explicit cleanup barriers. This prepares the separate
[Kohaku public lane](railgun-kohaku-public-shield-plan-2026-10-04.md); it does not
yet expose `prepareShield` or a public-operation submitter. Main-process wallet
ownership is unchanged. There is no new UI, IPC channel, dependency or live transaction.

## Lifetime and destination contracts

Preparation and receiver verification accept optional `signal` and `timeoutMs`
(1–180,000 ms, default 180,000; startup capped at 120,000). Each synchronously
claims the shared account recovery phase before starting its utility. An open
account wallet or reserved wallet handoff therefore refuses these jobs. The
future facade must close and drain its adopted account, release the handoff and
invoke the Shield controller without an intervening asynchronous gap. Contention
must refuse before a utility starts. The two hosts do not hold one continuous
phase across the gap between their separate calls.

Broker refusal is permanent. Receiver credentials must be exactly 32 bytes;
copied key material is wiped, and borrowed credential callbacks and actual child
closure must settle before releasing the phase. Failed child closure cannot
prove exit and keeps exclusion. The process binary-key allowance for the receiver
now requires a private-account subject. Preparation and receiver receipts also
follow the caller lifetime.

`openRailgunShieldOperation` accepts an optional caller signal and genuine
`destinationConstraints: { protocol, transaction }`. It checks both constraints
without RPC before either host executes. Every deployment-preflight attempt uses
the protocol constraint; the transaction handle remains bound to the transaction
constraint for hidden chain checks, simulation, gas/balance/nonce reads and send.
Destination changes cannot trigger an unrestricted fallback. Existing callers
may still omit the options.

The operation starts its nonrenewing 120-second budget before the first await,
passes remaining budgets to the hosts and retains the 60-second deployment
freshness limit. `close()` revokes admission without throwing. `closed` observes
opening, acquisition, submission and the original review/signer promises, even
if an outward cancellation wins first. If owned cleanup throws or rejects,
`closed` stays pending: neither rejection nor `allSettled` can masquerade as a
safe handoff. An already acknowledged result or genuine journal uncertainty is
preserved. A failed open also waits for the same drain before refusing; it stays
pending if owned cleanup failed. Facades must own or bound that wait while retaining
exclusion, as the qualifier does. Callback-forged uncertainty/unresolved errors are sanitized; genuine
`PRIVATE_SUBMISSION_UNRESOLVED` still blocks another send.

Recovery independently accepts `{ signal, destinationConstraint }`, binds a fresh
transaction route and tracks admitted list/observe/resolve work before calling
downstream code. Closure prevents late reads or permits but preserves an outcome
already persisted by the journal. Its borrowed parent privacy session remains
open. Neither controller's barrier establishes physical socket or service-lease
termination.

The standalone Shield controller still performs simulation before its transaction
review. The next facade must add the earlier explicit disclosure review described
in the public-lane plan; these primitives do not implement that product boundary.

## Qualification

The combined focused run passes **346 tests across eight suites** in 3.944 seconds.
It covers hosts, process admission, operation, recovery, receipt/preflight and the
offline deployment fixture. Cases include malformed broker traffic followed by a
valid message, held credentials and callbacks, cancellation between preparation
and receiver verification, stale protocol and transaction destinations separately,
cleanup failures, callback-forged outcomes, and durable recovery after closure.
Repository lint passes. The [full regression](qualification/railgun-shield-prerequisites-regression-2026-10-04.json)
passes **13,658 tests / 33 skipped**, across **501 passing suites / five skipped**,
in **510.538 seconds**. All 1,489 source/test/configuration hashes remain unchanged.
It uses native permissions, the existing OpenLV exclusion and explicit force-exit;
this does not prove natural application-handle drainage.

The [native report](qualification/railgun-shield-prerequisites-2026-10-04.json)
records 60 source hashes, verified again against the final sources. Four cases
pass in one disposable Electron profile. Offline mode supplies genuine constraints
for both roles on every operation open and a fresh transaction constraint on
every recovery open; the report does not serialize these capability tokens.

| Case                         | Measured result                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Acknowledged deposit         | Attempt journaled before transport; exact Shield event matched and resolution survives vault lock/unlock   |
| Lost acknowledgment          | Genuine uncertain hash retained; matching evidence and resolution survive reopening                        |
| Cancelled transaction review | Outward refusal precedes original callback drain; late approval produces zero signing or raw-send attempts |
| Dropped send                 | Unknown outcome remains unresolved; resolution and another submission refuse                               |

There are three real signatures by an unfunded synthetic EOA, three simulated
raw-send attempts, two simulated acceptances, four transaction reviews and zero
unexpected transport failures. The signed sender, target, amount, calldata, gas
and recomputed intent must match the current preparation and journal before
simulated acceptance. Unexpected transport assertions remain counted even if a
preflight retries, so a later success cannot hide them.

The Railgun engine, vault-backed viewing identity, receiver cryptography, actual
deployment-preflight implementation, signing and encrypted journal execute.
Protocol replies include the four real public bytecodes matching production pins.
Headers, storage slots and getters are synthetic; funding RPC and receipt/finality
observations are also synthetic. Both RPC roles are intercepted before clients
load, and offline mode never loads the live Tor helper or constructs its transport.
The source inventory is not execution coverage; overridden modules are identified
in the report. Funding signing is not the vault funding-signer path. Reopening is
in-process vault/session reopening, not application restart. Native cancellation
qualifies a held transaction review; held utility credentials and recovery
callbacks are covered by focused tests. No physical Tor, live deployment state,
mined finality, funded private operation or post-Shield balance ingestion is proven.

## Reproduction and next work

Run `scripts/qualify-railgun-shield-submission.js` with Electron, setting both
`FREEDOM_WALLET_TOR_EXPERIMENT=1` and `FREEDOM_RAILGUN_SHIELD_OFFLINE=1`. Pass absolute
paths for the pinned engine archive, a **new** disposable output directory and the
public-bytecode JSON fixture. The fixture schema is
`railgun-public-contract-bytecodes-v1`, chain 11155111, with `code` entries `proxy`,
`relayAdapt`, `wrappedNative`, `implementation`; every Keccak hash must match
`railgun-shield-pins.json`. This run's input SHA-256 is
`a1f3a1c51c6272eca7940313bf3b8d6b8229527db3aaf3334acc76d8314c0427`.
Opening and closure waits are bounded; a stuck cleanup writes a failed report
and exits unsuccessfully. Without the offline variable, the legacy qualifier
still performs public deployment reads over Tor.

Next is the genuine Kohaku public token and separate submitter, including its
preparation disclosure review and adopted-account handoff. Partial unshield/change
and second spend follow. Prior native private-operation reports remain evidence
for their recorded sources; this Shield run does not refresh that private matrix
after the shared process-host change. Their sole changed inventory file is
`railgun-process.js`: it narrows the Shield receiver's binary-key allowance to
private-account subjects; private-operation job admission is unchanged.
Live private qualification and its pending
specific disclosure authorization are unchanged. Engineering review is not an
external security audit.
