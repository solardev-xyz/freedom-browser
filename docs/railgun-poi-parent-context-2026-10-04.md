# Railgun POI parent-context admission — October 4, 2026

The POI source's derived transport handle now rechecks its retained original
parent context before accepting Tor endpoint currency. Previously the source
checked that parent immediately before calling transport, but the transport's
own handle check evaluated only endpoint identity. A parent predicate becoming
false between those checks could therefore admit the next request.

This is a narrow main-process wallet change with no new options, generic
predicate hooks, methods, dependencies or IPC. It enables the upcoming typed
Transact membership host to enforce its private root-currentness predicate at
each list request admission. It does not assert that already-admitted bytes
cannot arrive after expiry while connecting or queued. Parent failure closes
the child/source promptly; existing acquisition and transport closure barriers
still retain ownership until admitted work drains.

## Evidence and limits

All 57 source tests pass in 0.205 seconds; full lint and diff checks pass.
The final two additions cover a parent predicate closing itself reentrantly
and lazy parent invalidation while an admitted request is still pending.
Both preserve refusal and drain. Final test SHA-256:
`a406dd8e2289225436617bbcb81f10ec07e63eab750ab63e0a13f61a2c334aff`.

Twelve independent admission controls use real parent/child privacy contexts
and a mocked transport entry that authenticates its actual retained handle.
For each of the four list methods, lazy expiry, false currentness and a throwing
predicate occur after the source check but before transport authentication.
All twelve baseline controls pass in 0.222 seconds. Removing the parent traversal
in a temporary in-memory module produces twelve expected failures of the
zero-admission assertion in 0.213 seconds. The old source's eventual refusal
cannot conceal an already-admitted request. No live transport is used.

Native Shield [transfer](qualification/railgun-poi-parent-context-transfer-2026-10-04.json)
and [unshield](qualification/railgun-poi-parent-context-unshield-2026-10-04.json)
compatibility pass in 49,133 / 48,449 ms. Both preserve 19 membership and seven
recovery scenarios, 211 source hashes, the keyless selector and genuine local
membership verification. The reports are byte-for-byte copies of the completed
runs. Production was unchanged afterward; the reports record test hash
`6c7266e09ee29df120b662c2595ab0d1c400009a351b91d02b3cd65b4d4fd0d4`
before two additional unit controls were added. These are production runtime
qualification, not a claim that the final test file ran inside those fixtures.

Native stores and worker crypto are real; chain/root and transport are simulated,
and service signatures use the explicit disposable-key trust seam. The actual
required-list key rejects fixture signatures. No proof submission, live query,
funded profile or durable spend transition is exercised. The preceding selector
commit passed 12,888 regression tests; this narrow follow-up has focused and
native coverage, with the next full regression planned after composition.

Production SHA-256:
`f02bc199ae280c9b2d5e3c15edd9d19b09214dd00336702eee209b4115997610`.
The 24 public/TXID and 30 wallet policy source inputs remain unchanged. Existing
policy-generation rebuild requirements for live profiles remain unchanged too.
