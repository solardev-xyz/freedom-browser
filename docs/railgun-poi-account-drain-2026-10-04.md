# Railgun account and private-window POI cleanup — October 4, 2026

Account POI operations now expose a nonrejecting `closed` promise. Closing revokes
receipts immediately; completion waits for source closure and the entire admitted
acquisition, including membership verification. Healthy and non-Valid diagnostic
results preserve their existing retry behavior. Failed acquisitions finish their
inner bookkeeping before awaiting closure, preventing self-wait. Constructors
request cleanup on failure without claiming awaited construction-time drainage.
Missing barriers refuse; rejected source barriers revoke and remain pending.

The private-operation controller now revokes its signing permit, requests both
POI and provenance cleanup, then awaits both available barriers before its intent
callback returns. Each close is guarded independently. Invalid POI contracts refuse
before reservation or key work; cleanup failures never turn into successful returns.
A closure that never completes retains the callback indefinitely. If cleanup crosses
the window deadline after signing, the enclosing wallet check yields
`signed-unfinished`, preserving the durable hold and capsule without enabling retry.

This adds no comprehensive transport guarantee: provenance retains its existing
root-work completion contract, and private preflight still exposes synchronous
close only. The standalone owned-POI live qualifier awaits the new operation barrier;
it was edited but **not executed**. Wallet closure is not a registry of all detached
POI operations.

## Evidence

Independent tests pass: **117 tests, two suites, 1.884 seconds**; lint passes.
Tests cover source/verifier completion in both orders, healthy retries, rejected
barriers, constructor failure, guarded simultaneous cleanup failures, and expiry
after signing. The latter uses a mock matching the real wallet's post-callback
window and signal checks. Five temporary baseline controls pass; removing account
busy tracking exposes two failures, bypassing controller POI waiting exposes two,
and removing the immediate rejection latch exposes one pre-key-refusal failure.

Native [transfer](qualification/railgun-poi-account-drain-transfer-2026-10-04.json)
and [unshield](qualification/railgun-poi-account-drain-unshield-2026-10-04.json)
qualifications exit successfully, each preserving 19 surrounding wallet scenarios
and **130 matching source hashes**. Their production controller steps take
**4,036/3,349 ms**. A resource-free synthetic POI barrier is held first after a
refused diagnostic, then after a real disposable-vault signature is persisted.
Both calls remain pending; the first releases no key, and the second starts no
proof before closure. Release permits real guarded proving and independent
verification. Each uses one disposable spending-key reply, wipes borrowed bytes,
persists signature/proof, and preserves duplicate-input refusal and recovery state.
No live POI query, transaction submission or funded profile is used.

Native evidence here establishes controller ordering with simulated service inputs.
The actual account POI wrapper's source-plus-verifier barrier and post-signature
expiry are unit-level coverage. Actual source composition was qualified natively
in the [preceding milestone](railgun-poi-source-drain-2026-10-04.md); the synthetic
barriers here do not establish physical socket closure or real Tor performance.
Independent engineering review is not a security audit. Claude reviewed code and
fixture scope; Codex supplied implementation and independent tests/controls.

The preceding full regression (12,679 tests) predates this patch. A new combined
run is deferred until the newly discovered main `cdd014f2` merge and explicit node
refresh; the briefly started pre-merge run is excluded. No full-patch regression is
claimed at this checkpoint.

## Scope and next work

Responsibilities remain in existing main-process wallet modules; fixtures stay
in scripts. All 24 public/TXID and 30 wallet policy source files are unchanged;
public policy `d454092c` and TXID policy `03a45fd1` remain unchanged. No dependency,
key/job permission, IPC, UI or funded-profile change occurs. Earlier unrelated
policy changes still require the reviewed live public-generation/mirror rebuild.

Next: merge main, refresh pinned installations, and run the combined regression;
then implement receiver-only Transact selector recovery, genuine typed membership,
actual proof/intent preparation and shared output recovery. Owned-note live
disclosure remains separately pending; this patch grants no consent or spending
authority.

## Frozen source hashes

- `railgun-account-poi.js`: `e32c4843eb62e8931eedd5ed98505ec345bf58a629aea59aa114bba898c111b6`
- `railgun-private-operation.js`: `d96765ab643f88fd82f601807b2bfffc36ac1386c267437a622bfd20abb3cc73`
- `railgun-account-poi.test.js`: `834673e63f130a2e8d7dcf3cfeeeb991926f06f49c415392deeb7ff3ce01095f`
- `railgun-private-operation.test.js`: `08194a883e4456d3a61726ee477e4799aaa1993dc2989198d70282c56b1f350a`
