# Normal Railgun change scan and disposable list membership — October 5, 2026

This follows the [durable combined-proof checkpoint](railgun-combined-poi-integration-2026-10-05.md)
at `c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff`. That checkpoint remains historical
evidence for its recorded sources. The current fixture composition passes both Shield-input and received-Transact
native cases, plus the default first-stage compatibility case. It does not establish a second spend,
real service acceptance or a partial Kohaku flow.

The optional `change` qualifier stage advances the ordinary wallet over the
actual first partial transaction. It checks the original input is spent by that
transaction and that the unique self-owned change matches the commitment,
coordinates, token, amount conservation and blinded output from the registered
combined proof. While genuine account/proof owners are live it constructs a
bounded disposable list service, then closes the wallet. That service keeps the
outer identity lifetime across intentional enrollment reopening.

Before the proof POST, the normal account POI query must report Missing. The
fixed sender records its existing attempt and submits the exact stored payload.
The disposable service verifies the actual proof and independently checks its
transaction path, final unshield hash and scanned change binding before signing
its one-leaf list event. A fresh ordinary query must then verify the simulated
Valid membership through the normal source and verifier. The second withdrawal
will need its own new reservation, staging and fresh window-bound membership;
the diagnostic query does not grant spending authority.

The scan inventory covers the full accounts parent directory and profile
privacy-inventory marker. Only the active wallet SQLite database (including
coverage) and its encrypted scan journal may change during advance. The catalog,
private/POI stores, enrollment manifest and other scanned files must remain
byte-identical, with no added or removed files. EOA submission history is
separately compared as a logical journal snapshot. This is not a byte comparison
of vault metadata or the entire profile. Both input cases confirm that active restores change only the wallet
journal; the SQLite file and other protected files remain unchanged. The original ten-second proof POST budget is
shared by the held gate and actual verifier work, with no renewed timer.

The five focused fixture suites currently pass 86 tests (6.448 seconds), and
full lint is clean. A subsequent 38-test list-helper run passes in 4.942 seconds
after explicitly asserting the mock capture separates the public submitter from
the proved transaction. These overlap the 86 tests and are not added again.
Their authority/crypto mocks qualify orchestration only.
An independent Codex agent and Claude both flagged the overly broad catalog allowance,
which was removed; a proposed document-label finding was withdrawn after checking
the exact source. Shield-a's refusal was not localized because the sanitized error filter omitted
the new helper files. After extending that diagnostic filter, Shield-b showed
the refusal in the list factory, after the ownership and change joins passed. The factory had reconstructed a journal intent without the authenticated
public submitter; genuine proved transactions store that sender separately.
The latent defect was present in the previous checkpoint's unit-only helper;
that helper was not used by its native pair. The fixture now mirrors the
production capture derivation and the tests use that
actual shape, including a substituted-sender refusal. Failed runs remain preserved.

The final Shield-d and Transact-b runs pass in 97,146 and 105,876 ms. Both
execute twenty connected stages against the same 856 source hashes. Shield
uses 295 utility children and 28 storage workers; Transact uses 338 and 31.
Each has exactly two expected wrong-output revocations, all remaining utilities
close normally, all storage workers exit zero, no fixture violations remain,
and all three observed key copies are wiped. Each signs and sends one Ethereum
transaction and posts the retained combined proof once. The POST paths take
489.141 and 448.454 ms from route entry through verification and reply
preparation, within their original ten-second budgets. This is synthetic-service
latency, not a live network measurement; route-entry timing also excludes
request setup before interception.

The default Shield case passes its original seventeen connected stages in
95,242 ms against the same source inventory, with 289 utility children and
25 storage workers. It keeps change scanning disabled. The earlier successful
Shield-c and Transact-a runs remain diagnostics under their earlier report-label
source hash; their reports have not been relabeled. The final qualifier reports
normal scan credit explicitly while keeping second-spend qualification false.

The [evidence index](qualification/railgun-combined-change-integration-2026-10-05.json)
records raw report hashes, source inventories, commands, targeted checks and
preserved diagnostic outcomes. The reports use public test vectors and fresh
disposable profiles. No funded profile or real service was accessed.

This checkpoint changes fixtures and documentation only. Production, package,
dependency and policy bytes are unchanged from `c5d75f05`; its recorded frozen
regression passed 15,731 tests across 517 suites, with 33 tests/five suites
skipped, the existing OpenLV exclusion and forced exit. That regression belongs
to its original source snapshot and was not repeated or relabeled here.

Normal second spending, new-process combined recovery, partial Kohaku facade
integration and real-service/live qualification remain outstanding. The next
step must stage the actual scanned change with its own nullifier and current
roots, acquire fresh operation-bound membership and preflight checks, and sign,
prove and submit a second transaction while preserving the first attempt.
The fixed sender still returns `recovery-required` at its response stage; a
successful POST reply alone never establishes real service acceptance.
Diagnostic membership grants no spending authority. Portable adapter extraction
and a qualified private broadcaster remain separate roadmap work.

Claude reviewed the implementation, final native evidence and documentation.
This is engineering review, not an external security audit.
