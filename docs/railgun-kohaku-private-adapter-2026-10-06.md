# Restricted Kohaku private adapter — October 6, 2026

The wallet now has a restricted private-operation adapter with a separate, fixed Freedom host. A consumer can read the account’s current scanned balances and notes, prepare an existing supported self-transfer or full/partial withdrawal, then broadcast its one-use operation. The host retains account ownership, private keys, proof generation, disclosure reviews and durable recovery state. This is infrastructure for a future wallet experience; it does not enable a user-facing privacy feature.

Core source checkpoint: `3e24dc906852fc17b07a51ed3cbf98236bdc2628`; corrected runtime/native-fixture checkpoint: `f84da57a8ef9234d63447774c240ce4dfeb92f6b`. The adapter is restricted to the existing Sepolia/direct WETH integration and its 10^16 base-unit input ceiling. That ceiling is an integration restriction, not Railgun's protocol limit. The fixed host checks the entire selected input, including when only a smaller amount is withdrawn. No chain-independent package, generic Kohaku Host or arbitrary-recipient support is claimed.

The later [public-adapter checkpoint](railgun-kohaku-public-adapter-2026-10-06.md) at `deb34394` also corrects native Promise-observation failure in this private adapter. An unobservable promise now closes admission and causes closure to reject while other observable work remains retained. Nine distinguishing private regressions pass in the combined 823-test run. The five native reports below remain evidence for `f84da57a`; they are not refreshed private-native qualification for this correction. The [five-factory Node prototype](railgun-kohaku-public-node-prototype-2026-10-06.md) includes the corrected private source and its independent runtime checks.

## Contract and ownership

The adapter exposes asynchronous instance ID, balance and note reads while ready. Results are detached mutable copies with explicit host-supplied provenance; data alone confers no spending or eligibility authority. Preparation refuses while admitted reads are pending. A session allows one preparation attempt, and a denied attempt closes it.

Successful preparation returns an opaque private-operation token. Module-local identity, not its visible shape or TypeScript brand, authenticates that token. Copied, foreign and replayed tokens are refused. The adapter consumes the token before invoking broadcast and keeps the underlying handle private. The fixed host adopts the genuine Freedom facade; closing it logically drains the adopted account and admitted operations while leaving borrowed identity, enrollment and coordinator ownership intact.

A valid host outcome is forwarded unchanged, including object identity. Acknowledged sender and recipient fields must be 0x-prefixed 20-byte hexadecimal strings, checksum-validated when mixed case. ICAP or unprefixed host results are not accepted as acknowledgements; a unique canonical transaction hash can still be retained as uncertain. There are three fulfilled result forms:

- An acknowledged transaction with hash, nonce, sender, recipient, zero value, chain ID, direct broadcast source and explorer URL.
- An uncertain submission with the known transaction hash and unknown submission status.
- A recovery-required result naming the stage that needs reconciliation.

The private acknowledged result intentionally follows the actual private submission contract. The private journal, rather than ordinary public-wallet journal status fields on the result, tracks submission state. An error is not permission to retry. A malformed host result can preserve a single unambiguous canonical transaction hash as an uncertain outcome; otherwise it produces an adapter-contract recovery result.

Cancellation preserves the distinction between an outward result and full drainage. Once broadcast is invoked, the adapter does not add another abort race or discard a valid original settlement. Its closed promise waits for admitted work and host closure; cleanup failure remains a failure. Trusted host callbacks are not sandboxed, and a structural host object does not authenticate Freedom ownership.

## Completed core verification

The core checkpoint passes 630 tests in 19 suites with natural runner exit, full lint with no warnings and changed-source formatting. The initial native-fixture checkpoint at `3557d403` passes 646 tests in 19 suites with natural exit, full lint and six-file formatting. The request-purpose correction at `d4ff68a0` passes 647 focused tests in 19 suites. The final combined address-shape and denied-RPC correction at `f84da57a` passes 664 focused tests in 19 suites (1.533 seconds), natural exit, strict lint and four-file formatting. Sixteen address cases cover accepted spelling/identity and malformed-result uncertainty; the old source fails precisely the four ICAP/unprefixed cases. A separate regression derives the two independently cached transaction RPC chain checks skipped by preparation denial. Tests cover lifecycle ordering, one-use admission, outcome preservation, malformed promises and cleanup failure. Review corrected post-adoption constructor cleanup, thenable re-assimilation, pending-work drainage and retained abort listeners. Eleven distinguishing mutation controls support those checks. This is a focused core run; the earlier broad regression retains its historical source scope.

Strict TypeScript 6.0.3 qualification passes one positive program and 23 negative programs against the actual pinned Kohaku graph: six upstream-binding controls and 17 Freedom declaration controls. Each program loads 222 source files; nine upstream blobs match revision `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. The qualified targets are a specialized PluginInstance and a Broadcaster whose result is the private outcome union. The default void-result broadcaster, generic Host and generic factory are unsupported.

The compiler checks declaration consumers, not the JavaScript implementation. A typed token spread still compiles and must be rejected at runtime. Widening to the actual upstream method type permits tailCalls, while the concrete adapter refuses them; assignability does not establish static exclusion. Installed ox differs from the upstream provider range, so this is not an upstream lockfile build or portable package-resolution test. The publication archive records those limits and distinguishes original evidence bytes from explicitly normalized local paths.

The exact strict compiler evidence is archived [here](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-private-types-2026-10-06/README.md). It predates the final JavaScript-only correction and retains its declaration-consumer scope.

## Native qualification

All five fresh disposable-account processes passed at `f84da57a`; the original driver also exited 0. The [native evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-private-adapter-2026-10-06/INDEX.json) joins exact report hashes, original child exits, source/runtime pins and completed root checks. Raw report bytes are preserved.

| Case                                                                 | Observed result                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shield-origin self-transfer                                          | Acknowledged, original outcome identity preserved                                                           |
| Transact-origin full withdrawal, response lost                       | Known transaction hash retained as uncertain; no retry granted                                              |
| Shield-origin partial withdrawal                                     | Acknowledged through the adapter and original controllers                                                   |
| Transact-origin partial withdrawal, final review held then cancelled | Original recovery-required outcome preserved; zero EOA signatures or sends; closure waits for admitted work |
| Shield-origin preparation denied                                     | One attempt closes the session; no new proof or submission; protected state unchanged                       |

Each case exercises thirteen successful ready-state projections against the genuine account and tests detached mutation isolation without additional measured work. Subsequent read refusals and copied/replayed operation refusals are checked in the relevant lanes. The full cases separately retain the existing wallet baseline: 741, 761 and 731 archived requests for transfer, full withdrawal and denial. Their utility/worker starts are 106/78, 118/83 and 101/78. Those totals include baseline activity; refusal does not mean the entire process did no work. Denial has 736 transport calls, including ten chain-ID checks, and four baseline private-operation jobs.

The run uses actual local cryptography, controllers and constrained signers with public vectors and synthetic chain/services. The full-case harness supplies synthetic account-POI/private-preflight authority; the partial cases use the original controllers with disposable service observations. Neither lane establishes live service eligibility. The three full reports retain their inherited allowance for up to two unsettled public workers before finalization; original process exits are checked separately. Logical shutdown and observed process exit are not physical socket-drain evidence.

The selected-source union and broader source freeze are inventories, not execution coverage. Request metrics distinguish private-prepare and private-receive purposes; they count requests before dispatch, not successful replies or all keys. Private-operate requests are explicitly outside those narrow fields. Address-format adversarial cases are focused-test evidence, not additional native scenarios.

Two earlier campaigns failed fixture assertions and remain excluded. The first misattributed a private-operate key request to the legacy private-prepare counter. The second passed four cases but failed the denial RPC prediction: the successful path creates two independently initialized transaction RPC clients, while denial reaches neither. Stack-only diagnostic wrappers preserved the original assertions; their failed children are not qualifications. Both corrections were source-derived and regression-tested before this fresh successful five-case run.

## Remaining work

Live private-service and broadcast qualification, a releaseable reusable package, browser/platform integration and UI/product design remain separate work. Existing public deposit and cold recovery evidence does not establish successful live private transfer or withdrawal. Owned-note disclosures to an external POI service require the specific approval discussed in the roadmap; the disposable tests do not use the funded profiles.
