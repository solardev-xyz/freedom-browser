# Railgun independent proof receipts — October 3, 2026

Main now runs the keyless verifier through an account-bound wrapper. It checks
that only proof coordinates changed, authenticates the prover runtime, accepts
one strict verified result, and observes the child exiting before issuing an
opaque receipt. The receipt matches the exact enrollment, original intent, final
transaction and expected public inputs. It grants no ownership, POI, reservation,
signing or submission permission by itself.

The process has a bounded timeout. A successful receipt has a separate 60-second
lifetime from observed exit and ends immediately on caller/account abort or close.
The per-account busy lock remains held until the child actually exits, including
on failure. Enrollment allows only the specific `prover/private-verify` context.
No key or wallet database enters the verifier. All verification errors are
sanitized. This remains in main's wallet subsystem with no renderer API, dependency
or package-boundary change.

[Actual Electron evidence](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-receipt-2026-10-03.json)
contains 87 matching source hashes and 19 enrolled recovery runs. Both synthetic
self-transfer and unshield prove and independently verify after the preparing
utility exits. The main-owned receipt checks include a forged receipt, a non-enrollment
object, altered transaction and closed receipt. The two report flags record
passing assertions on those paths; they are not separate measurements. Both refusal windows transfer
zero synthetic spending keys. The successful windows each transfer one key from
the public test mnemonic; neither uses a real vault spending key. No live
acquisition, owned POI query or submission occurs.

The 38 focused tests cover the verifier and real enrollment context, including
duplicate results, invalid proof/digest, attempted key requests, child failure,
deferred exit, abort and the two deadlines. Lint is clean. Claude reviewed the
implementation and sanitized qualification evidence, including the real-enrollment
context correction now included.

The private controller remains unfinished. It must require a fresh receipt for
the exact transaction before persisting or submitting it, and rerun verification
after restart. Capsule storage checks structure only; persisted transaction data
cannot replace this receipt. Chain/root/unspent checks and POI evidence retain
their own lifetimes and do not inherit proof-receipt validity.
