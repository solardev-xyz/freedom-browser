# Railgun note provenance host hardening — October 4, 2026

This bounded prerequisite makes a broker refusal permanent inside the detached
note verifier before its evidence is composed into Transact-input preparation.
Offline qualification is complete.

The production process supervisor already stops on broker rejection. The added
host check is defense in depth: even if a supervisor catches a rejected dispatch
and delivers later traffic, a malformed message cannot be followed by a successful
result. A previously valid result cannot survive a later malformed or duplicate
message. This is not evidence of a bypass of the actual supervisor.

Cleanup must revoke the invocation synchronously, tolerate throwing close
callbacks, and still await the admitted child's closure. Abort listeners and timer
callbacks must not leak a close exception as an uncaught process error. A rejected
closure promise produces the same sanitized refusal. Adversarial close failures
in unit fixtures do not prove physical termination; the real process wrapper's
closure promise is nonrejecting. A child that does not close keeps its caller
pending rather than returning usable evidence.

Healthy results retain the same detached comparison facts and false ownership,
source-authentication, root-acceptance and spending flags. The utility, protocol,
key permissions, service routes and cache policies are unchanged. No identity
credential or funded profile is used by this slice.

Transact composition remains a separate step. It must join the complete creator
event group from the same authenticated source visit to its own checkpoint witness,
then derive a receiver-only selector and obtain genuine type-bound membership.
Membership for a later spend must never resolve the earlier uncertain POST or
consume its remaining recovery reserves. Both self-created and foreign-created
inputs need qualification before genuine preparation and output recovery are
extended. No encrypted intent seeding or proof-registry substitution is planned.

## Qualification

All 114 focused tests pass across four suites in 3.343 seconds, including 39
provenance tests (21 new) and the existing own-TXID, Transact provenance and staging
consumers. Lint passes. Nine refusal-order controls pass normally and all nine fail
when the synchronous broker close is removed in a temporary in-memory transform:
the verifier incorrectly returns comparison evidence despite the fixture swallowing
the earlier rejection. No production source is changed by the mutation control.

The [guarded Electron qualification](qualification/railgun-note-provenance-hardening-2026-10-04.json)
passes all eight existing synthetic path/event scenarios in 1,206 ms with 20
matching source hashes. It preserves healthy cryptographic verification and seven
corruption refusals, with explicit false-authority assertions. Exceptional callback
behavior and swallowed broker errors are unit controls, not native worker attacks.
No native lifecycle, membership, encrypted-store or sender composition is newly
qualified by this small run.

The previous full regression (12,487 passed / 33 skipped) belongs to `c332c53a`
and predates this hardening. It is not represented as a rerun. Earlier whole-source
reports containing the changed host are historical; policy inputs remain unchanged.
The implementation stays within the existing main-process verifier responsibility,
without another process or public controller.

Frozen verifier SHA-256:
`a9c12ef169ecb296f0561df6af633807a717124b602ed0ed520b867740030f20`.
Frozen test SHA-256:
`ce6d7fdcb46f7f88bc390d08edba5817a34dfce3ef760476c66bb70c03c0e683`.
Claude reviewed production and evidence; Codex supplied production and independent tests.
