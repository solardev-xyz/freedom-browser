# Partial withdrawal submission and capture — October 5, 2026

The internal Railgun controller can now submit a proved partial withdrawal and
capture its resolved transaction from authenticated active or archived history.
Six native cases pass with real wallet, cryptographic and storage components and
simulated external services. This does not enable partial withdrawals in the
Kohaku facade or complete private-change recovery.

## Production behavior

Submission admits exactly transfer/v1, full withdrawal/v1 and partial
withdrawal/v2 capsules. Both withdrawals require the public recipient to equal
the original Ethereum submitter. Partial submission requires the genuine one-use
controller completion, fresh independent proof verification and the fixed 01x02
preflight. Observed circuit kind must agree in both directions: legacy
observations must not carry an `intentKind` property, even with an undefined value.

The existing account exclusion, stored-record comparisons, destination
restrictions, simulation, transaction review and encrypted submission journal
remain in use. An attempted record precedes raw sending. An uncertain reply
preserves the known transaction hash and does not authorize an automatic retry.

Own-operation capture joins the genuine signed capsule with the exact resolved
EOA journal intent, including both ordered commitments and the gross withdrawal
amount. It supports active and archived records. The detached capture remains
schema 1 with an embedded version-2 capsule; it grants no source, finality, POI
or spending authority. The older own-witness path rejects partial operations
after its initial authenticated capture/selector work, before receipt, source,
TXID or root acquisition. Durable combined POI remains separate work.

## Connected native qualification

Every case uses a fresh disposable profile from the pinned public vector.
Actual enrollment, public and wallet scanning, POI/preflight hosts, protected
signing, proving and independent verification produce the genuine completion.
Received-Transact inputs additionally use the genuine TXID checkpoint and staging
path. The account closes before the actual submission controller runs.

Protocol and transaction destination constraints come from genuine query-free
previews. External chain, list and service responses and Tor transport are
synthetic. A delegating signer observer counts the actual vault's EOA signatures;
it does not substitute a signature. The transport wrapper checks current context,
wire shape, owner, endpoint and exact calldata, with separate entry, closure and
pending-request accounting. This is not live RPC or Tor qualification.

| Input             | Acknowledged | Lost reply | Wrong verifier |
| ----------------- | -----------: | ---------: | -------------: |
| Shield            |    20,071 ms |  23,532 ms |      22,613 ms |
| Received Transact |    24,399 ms |  24,478 ms |      21,926 ms |

Each acknowledged/lost-reply case signs and sends once, with the exact attempted
journal entry already durable. Submission repeats the 01x02 key check and one
selected-nullifier query. Copied and consumed completions refuse without further
activity. Wrong-verifier cases serve 01x01 during submission and refuse before
additional transaction RPC, review or EOA signing; their earlier proof preparation
still made three transaction RPC requests. They do not exercise receipt resolution.

The four submitted cases exercise:

- Canonical receipt observation, which records inclusion in the journal, followed
  by reversed-log rejection before resolution review. Capture remains unavailable
  until successful resolution.
- Exact five-log resolution derived from the signed calldata: nullifier, two WETH
  transfers, unshield and one private-change event. Calldata contains two ordered
  commitments but the Transact event contains only the change commitment.
- Active capture, stable archived binding and identical capture after a
  same-process enrollment/store reopen, without new capture RPC or credentials.
- Genuine partial membership refusal at `preflight:capture`, with one keyless
  selector job and no additional RPC, credentials, proof or output-recovery jobs.
  Subsequent proof/output calls demonstrate missing-authority refusals; they do
  not exercise unreachable inner partial-record guards.

The receipt's change position comes from the genuinely scanned tree length of
three. Resolution treats it as receipt-supplied evidence; it is not independently
verified against an appended source tree. Treasury is the named receipt-policy
baseline, not authenticated inclusion-state treasury. Finality and gas metadata
are synthetic. Archival temporarily advances the process-global clock by
172,800,000 ms and persists `archivedAt` that far ahead; reports measure the
actual offset and clock-patch duration. This is not a fresh-process capture test.

The original private signature, capsule, proof and signing reservation remain
unchanged. All utility/storage-worker exits are observed, key loans are wiped
and pending transport counts reach zero. The
[qualification index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-submission-2026-10-05.json)
binds six raw reports, log hashes, runtime hashes and the same **528 source hashes**,
rechecked against the final source tree.

The first diagnostic run failed because its synthetic receipt omitted the
`gasUsed` required by the strict transaction-network reader. Adding that field
and a canonical observation assertion corrected the fixture; no production
change was required. The failed profile/log remain diagnostic only. All six
reported cases ran against the corrected qualifier in fresh profiles.

## Validation and remaining work

All **2,163 tests across 26 suites pass**: 437 direct tests in 32.883 seconds and
1,726 dependent tests in 81.756 seconds. Full lint and scoped formatting pass.
Coherent alternate-record tests fail when the exact journal-intent comparison is
removed in a detached test copy. Claude reviewed production, fixture corrections
and qualification evidence. Independent Codex review strengthened the exact
journal-intent tests and network-constructor assertions. This is engineering
review, not an external security audit. The earlier 15,178-test full regression belongs to
its recorded sources; it was not repeated or claimed current here.

The changes stay in the existing main-process wallet modules and qualification
scripts. No IPC, UI, dependency, runtime, deployment pin or derived-cache policy
changes are needed. Main `dbfd0e7d` remains an ancestor; no funded profile was opened.

Next are separately reviewed submission of cold-recovered proofs, durable
combined POI, actual change ingestion and restart/second-spend qualification.
The cold-submission design keeps only authenticated data across wallet/TXID
phases and acquires fresh live eligibility in the final recovery phase. It also
requires an atomic no-prior-nullifier-attempt check across active and archived
journal history. Those prerequisites are not implemented by this checkpoint.
Partial facade exposure, live private submission and a qualified broadcaster
remain open.
