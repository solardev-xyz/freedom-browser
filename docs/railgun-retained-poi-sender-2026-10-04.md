# Railgun retained POI sender — October 4, 2026

Implementation and offline qualification are complete for this slice. This is an unwired main-process
controller with a trusted review callback. No production UI, IPC or live command
invokes it, and a synthetic approving callback does not establish human consent.

## Fixed invocation and claim

`submitRailgunRetainedPoi` lives beside the genuine disclosure-plan registry. It
accepts the owners, pinned artifacts, an existing opaque plan, a trusted review
callback and caller lifetime. It accepts no raw proof, endpoint, capsule override,
request ID, observed validation result, transport or approval Boolean.

One synchronous claim burns the plan for reuse before awaited work. The existing
per-directory exclusion remains held through all admitted work, including ignored
callback cancellation and transport closure. A busy second invocation cannot
revoke the admitted owner. Denial requires a new plan, without changing a prepared
intent. At least 60 seconds of the original 120-second display lifetime must remain
at admission. Closing the original plan still cancels its running invocation.

Initial local inspection fixes the prepared entry and capture. The sender binds a
genuine source destination and prepares one receipt reader without querying it.
After the first review, one strict local capture/entry reattestation must finish
inside the original display lifetime. Only then does the consumed claim continue
under its separately established operation deadline. This never renews the reader
or makes the public plan reusable.

## Receipt and validation binding

`assertPreparedRailgunOwnReceipt` uses the existing reader registry. It checks the
exact enrolled owner, current parent context, unclaimed reader, retained destination
identity and deep equality to its detached capture. It returns no data or permission.
A mismatch does not consume an otherwise healthy reader; lifetime revocation still
applies. The fixed validator asserts and claims the same reader synchronously,
then obtains the observation itself before selector work. No result registry or
caller-supplied observed diagnostic is introduced.

The cold-validation, output-recovery and witness modules share existing private
cores through narrowly named submission entry points. The actual result remains
invocation-local between those fixed call sites. Fresh downstream captures must
match the reviewed baseline and the receipt's capture digest/transaction hash.
These internal module seams do not protect against malicious trusted main code.
The public sender and legacy diagnostic APIs accept no observed-result override.

The completed-only source path remains mandatory. Validation derives the selector,
compares the exact output, independently verifies the saved POI proof, authenticates
existing TXID mirror/history and reattests the prepared record. No proof rerun,
spending key, owned-note lookup, mirror repair or EOA transaction is included.
Legacy receipt and diagnostic order remain unchanged.

## Two review scopes

Only strict `true` returned by this invocation's callback advances its next stage.
Callbacks are sequential, at most two, and hold no recovery/TXID phase. Late answers
after cancellation do not authorize work. The trusted adapter must settle when
its offered signal aborts. If it never settles, this controller deliberately retains
the directory exclusion and leaves both the returned invocation promise and
`plan.closed` pending indefinitely; it cannot
promise bounded cleanup for uncooperative trusted code. It does not race away from
the callback or silently release its operation.

- `validate-retained-poi` describes the selected source/receipt origins, fixed
  service, known-transaction/range and current-TXID queries, local viewing-key
  output checking for transfers, and timing/session/transaction correlation.
  The maximum is 551 RPC plus 12 current-TXID service requests. Source checks are
  always cold; pending state can refuse after earlier receipt/TXID disclosure.
- `submit-retained-poi` describes the two original proof-root queries and at most
  one fixed POI POST, including its one-time local timestamp request ID. Root
  acceptance remains unknown when this review occurs.

The conservative whole path is at most 566 logical requests. These are not packet,
connection or Tor-circuit bounds. Main retains exact destinations privately; the
review object exposes origins. The old plan inventory remains a display inventory,
not a consent or request-budget token.

## Deadlines and drainage

The outer admission budget is 790 to 840 seconds from invocation (840 by default);
a shorter caller budget refuses locally before preparing a reader or querying,
and burns the recognized plan.
Promotion requires at least 730 seconds remaining for validation and later stages.
The conservative stage allocation is 790 seconds: setup 15, first review 30, strict reattestation 15, receipt 60,
remaining validation 540, final review 60, pre-root reattestation 15, parallel
original roots 15, durable attempt 15, attempt read-back 5 and final recovery/POST/outer
check 20. Actual remaining budgets can be smaller; no stage renews the outer bound.

Preparing the reader after setup leaves at most 105 planned seconds for first
review, reattestation and receipt observation inside its original 120 seconds.
The 30-second first-review limit is a deliberate prototype constraint. Product UI
review timing remains a future design discussion; expiry never selects another
client or silently grants a longer reader lifetime.

Root age starts at acquisition, independently of the outer deadline. Both root results
need a strict 40-second handoff margin before durable begin. Root-path allocation
is 55 seconds. The final 20-second recovery window contains a maximum 10-second
POST and its outer account checks. Cancellation stops later admissions but does
not race away from already admitted work. Drain can exceed admission deadlines.

The POST uses a fresh invocation-bound private-account POI scope and dedicated
transport. The two root readers and POST request three separate isolation
credentials under the same fresh invocation operation; that does not establish
separate circuits or unlinkability. Its response cap is 2,048 retained body bytes with explicit framing;
redirects, retry and fallback remain absent. The controller waits for the dedicated
transport's actual closed barrier. Root-reader closure has its existing logical
drain contract; it does not claim physical closure of every root-service socket.

## Durable attempt and uncertainty

Only this invocation's successful `beginAttempt` can open its internal one-use POST
slot. A pre-existing attempt, lost reply, floor failure or possible-commit refusal
cannot send. The sender authenticates the exact attempted entry and canonical
stored body/ID before transmission, preserving both remaining transition reserves.

The strict capture comparator retains archive representation/anchor checks before
persistence. A new stable comparator is used only after persistence: capsule,
selector, facts, submitter, proved transaction, intent, projection and binding must
still agree, while genuine recovery independently authenticates journal evolution.
A valid archive-only change therefore does not itself strand a just-recorded
attempt. No global exclusion of every journal writer is claimed.

Before possible persistence the result is `refused` with a stage and optional
authenticated diagnostic `sourceOutcome` from a validation refusal. Afterward it
is `recovery-required` with a stage and optional redacted response classification.

After possible persistence every outcome remains `recovery-required`, including
matching JSON-RPC replies. The response classifier is diagnostic only; it proves
neither service acceptance nor non-delivery or safe retry. No response is persisted,
no resolution transition is spent, and attempted records block reuse after reopen.
An expired or failed post-commit handoff can still leave a zero-POST attempt stranded
until authentic resolution exists. The separate intent/floor writes retain their
documented rollback limitation; this is not cross-file atomic irreversibility.

## Qualification status

The stable comparator/attempt tests pass 272 cases across two suites (8.684 s).
Prepared-receipt assertion and destination suites pass 92 cases (7.158 s), including
legacy behavior. These tests combine real normalization/encrypted writes or reader
logic with mocked recovery/network authorities; they are not live qualification.

The frozen independent composition run passes 601 tests in six suites (29.173 s),
including 107 sender cases. The three core consumer suites separately pass 599
cases (62.762 s). The six-suite total includes the stable/receipt suites above;
these figures must not be added as disjoint coverage. Full lint passes.

Four temporary source mutations produce six expected assertion failures against
four passing baseline cases: bypassing the first review admits 15 mocked RPCs;
omitting the complete attempted-entry comparison constructs a transport for an
unexpected stored field; removing the inner transport-close wait releases the
actual recovery phase early (two cases); removing both waits settles the invocation
early (two cases). The initial drain controls checked too early and survived the
mutation. The permanent tests now wait for unrelated continuations and contend for
the real recovery phase; only the final controls count as evidence.

The sender tests execute the genuine plan registry, prepared-reader claim and
assertion, structural normalization and real account-phase exclusion. They mock
crypto/source validation, store authority and root/POST transport. The separate
store tests execute actual encryption and atomic writes. Static call-site tests
are regression guards, not protection against hostile trusted-main code.

Native sender [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-sender-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-sender-unshield-2026-10-04.json) pass in
146,006 / 142,310 ms with 209 matching hashes each. Each preserves 17 base
scenarios, seven recovery and thirteen proof exercises, plus two historical-root
refusal/recovery cases and four sender/reopen cases. Durable-attempt compatibility [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-sender-attempt-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-sender-attempt-unshield-2026-10-04.json)
also pass, in 124,983 / 123,950 ms with 209 matching hashes and eleven attempt
cases each. Exact envelope/revision/reserves survive reopen; all existing prepared
consumers still refuse attempted entries before queries or key work. Full combined regression passes 12,398 tests with 33 skipped across 488 passing
suites in 448.327 seconds; full lint passes. Claude reviewed implementation, tests,
controls and native evidence. Independent engineering review is not a security audit.
The first full run failed native Electron/loopback tests under sandbox restrictions;
the rerun with native permissions, production and unit tests unchanged, passes
all of those suites.
Only that successful rerun is counted. Fixtures intercept services beneath genuine
RPC clients and test denied reviews, independent expected wire bytes, one exact
persisted POST, held close/exclusion and attempted cold reopen using disposable
synthetic data. Their review objects are checked for exact origins, request
inventories, false authority flags and an 8,192-byte bound. Each original-root
request checks that persistence is still prepared. The held transport barrier is
simulated; it does not independently qualify physical socket closure. No funded
profile or live disclosure is involved.

First-review denial has zero RPC/service/root/POST traffic. Final-review denial and
synthetic approval each perform 34 headers, one transaction, one receipt, two head
reads, one logs request, one chain-ID handshake and six current-TXID latest/root
pairs. One planner and one verifier execute per validation; transfer additionally
releases one viewing key. Source maintenance remains zero. Approval then adds two
original roots and one synthetic POST; all three dedicated fixture clients close.
The matching result remains `recovery-required`, and cold attempted reuse makes
no queries. Root calls overlap, with a peak of two during inspection; only their
fixture-owned store inspection reads are serialized, without retry.

Excluded runs: the initial `preliminary` transfer/unshield runs reached the final
inventory assertion while included files were still changing. The later
`final-a` pair and `diagnostic-b` unshield refused at roots after fixture assertions
introduced concurrent reads against the exclusive intent store. The diagnostic
captured the exact failing `get` site, one unexpected fixture error, two closed
root clients and zero POSTs; `STORE_BUSY` is inferred, not a captured error code.
Serializing those fixture inspections made both final-c runs pass with production
unchanged. None of the earlier runs is counted as qualification.

The previous milestone is `cab4c713`. All 24 public/TXID policy inputs were rechecked
and remain unchanged: `d454092c` / `03a45fd1`. Main `6b5c2ea7` remains fully merged;
the earlier explicit pinned-node refresh still applies. The changed intent store
makes prior durable-attempt whole-source reports historical. No dependency, UI,
IPC or package-boundary changes occur.

## Reproduction

From the repository root with the existing pinned engine/prover archives and
artifact directory, use a new disposable directory for each native run:

```sh
npm test -- -- --runInBand --runTestsByPath src/main/wallet/railgun-poi-submission.test.js src/main/wallet/railgun-poi-disclosure-plan.test.js src/main/wallet/railgun-own-receipt.test.js src/main/wallet/railgun-own-receipt-destination.test.js src/main/wallet/railgun-own-poi-binding.test.js src/main/wallet/railgun-poi-intent-store.test.js
npm run test:unit -- --runInBand src/main/wallet/railgun-poi-cold-validation.test.js src/main/wallet/railgun-poi-output-recovery.test.js src/main/wallet/railgun-own-witness.test.js
node_modules/.bin/electron scripts/qualify-railgun-own-poi-membership.js NEW_DIRECTORY ENGINE_ASAR transfer PROVER_ASAR ARTIFACT_DIRECTORY submission
node_modules/.bin/electron scripts/qualify-railgun-own-poi-membership.js NEW_DIRECTORY ENGINE_ASAR unshield PROVER_ASAR ARTIFACT_DIRECTORY submission
```

Repeat the native commands with `attempts` in place of `submission` for durable
compatibility, always using a fresh directory. Paths must be absolute. Services
are intercepted by this fixture; neither mode needs a funded profile or live
POI request. Full regression uses the repository's existing OpenLV exclusion:

```sh
npm run test:coverage -- --runInBand --forceExit --testPathIgnorePatterns=openlv-protocol.test.js --reporters=default
npm run lint
```
