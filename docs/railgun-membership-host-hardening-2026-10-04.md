# Railgun membership host hardening — October 4, 2026

The existing keyless POI membership verifier now makes a broker refusal permanent
before returning the rejected dispatch promise. A malformed or duplicate message
cannot be followed by a successful result, even if a mock supervisor catches the
rejection and continues delivering traffic. A valid result cannot survive a later
invalid message. The actual process supervisor already stops on broker rejection:
this is defense in depth, not evidence of an exploitable supervisor bypass.

Task and source close are guarded separately. Throwing cleanup cannot skip the
awaited child closure or replace the sanitized refusal. Source abort revokes admission;
refusal before the task handle is returned still closes it once assigned. Successful
receipt publication occurs only after child closure and a final genuine service
receipt check. Success leaves that source open, preserving receipt freshness and
revocation. The result schema, inventory/proof checks, query traffic and authority
flags are unchanged.

Broker dispatch performs synchronous validation; it borrows no asynchronous work.
The patch therefore uses a direct synchronous refusal latch inside an async broker
method, without a pending-dispatch manager. It awaits the real utility closure.
A child that never exits keeps its caller pending. Rejected closure fixtures produce
sanitized refusal but do not prove physical child termination. This patch requests
source closure on refusal; physical transport drain is a separate next prerequisite.

## Qualification

Independent tests cover malformed JSON/method/proof traffic before and after valid
messages, duplicate results, discarded broker rejection, refusal during process
startup, delayed exit, throwing task/source cleanup, rejected closure, source/parent
abort and the healthy delayed-publication path. The tests use genuine privacy and
POI source receipts with simulated transport and an intentionally adversarial mock
supervisor. They are host lifecycle tests, not native worker protocol attacks.

All **116 focused tests in three suites pass in 0.286 seconds**, including 32
membership-host cases; lint is clean. A temporary in-memory control removes only
the synchronous broker refusal call: nine baseline cases pass, and all nine then
fail because the fixture incorrectly receives a membership result. The production
supervisor is intentionally replaced in those controls; no production bypass is
claimed. The final source and tests were frozen throughout qualification.

Native [transfer](qualification/railgun-membership-hardening-transfer-2026-10-04.json)
and [unshield](qualification/railgun-membership-hardening-unshield-2026-10-04.json)
compatibility pass 17 membership and seven recovery scenarios each in
43,820/42,890 ms with 209 matching source hashes each. Genuine encrypted
stores, service receipts and guarded utilities run against simulated chain/service/
Tor transport and fixture signature trust. These runs qualify unchanged healthy
composition and existing refusals; adversarial cleanup behavior is unit-level.
They establish neither physical transport drain nor live list/service acceptance.
Earlier -a native and test/control runs predate the simplification and are excluded
from final evidence.

The full regression of 12,621 passed / 33 skipped at `70c93f4d` predates this patch;
it is not represented as a rerun. No dependency, policy input, job/key permission,
renderer, IPC or package boundary changes. Implementation remains in the existing
main-process wallet verifier. No funded account or live private request is involved.

The next step adds an explicit POI-source closure promise and makes ownership release
wait for admitted acquisition and transport cleanup. Receiver-only Transact selector,
genuine membership, actual proof/intent preparation and Transact output recovery
remain separate work. Historical provenance is not a promise of continuing canonical
source freshness, irreversible finality or exact POST acceptance.

Frozen verifier SHA-256:
`6041e7c9f4dfb7d2f353a8039784f5241003f3642d2b54ce46da37b4f0763680`.
Frozen independent test SHA-256:
`bfc642eeb170881d4f3de882949acfd3e0d1a031732cf8e306f839f1bb1829cb`.
Claude reviewed implementation; Codex supplied production, independent tests and
native qualification.
