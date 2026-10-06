# Authenticated Railgun recovery access

Checkpoint at source `cf25d54c0f074b9e6f6a3ff1f0631888e7856870`: core, fixture and four-process native checks passed. An independent engineering review revalidated all four archived stages and confirmed that a flipped companion flag is refused. This review is not an external security audit.

A fixed Freedom main-process companion now connects retained-operation discovery to explicit proof recovery and separate cold submission. An integrator can select an authenticated local history row without recreating an old in-memory operation token. The existing recovery and submission controllers continue to decide whether each action is currently admissible.

History returns at most sixteen detached records per page, ordered by hold ID, together with a cursor and the authenticated signing-reservation count. Each record contains only its selector, operation kind and local state: signed-unfinished, proof-present, signature-unavailable or capsule-unavailable. It exposes no note, amount, recipient, signature, proof, recovery receipt or account handle. Pages are separate observations, not a stable multipage snapshot.

These states describe retained local data. A proof-present row does not establish unspentness, service eligibility, absence of an earlier submission attempt or permission to submit. A signature-unavailable diagnostic checks the applicable binding but cannot claim the later signing-digest check. Corruption, mismatched binding, stale ownership or unexpected errors refuse the whole page. Genuine recovery receipts stay internal and expire before the page is returned.

Opening history uses existing registered stores, but it is not a passive read: authenticated opening can refresh leases and floor records, including establishing a missing floor within an existing manifest. It does not create or adopt unknown recovery files, promise unchanged opening bytes, or roll back partial opening effects transactionally.

The companion binds genuine owners, destination, reviewers, artifacts and fee limits. Its methods share a per-instance admission lock and preserve each admitted controller's original Promise and settlement. Closing aborts the companion lifetime, refuses further admission and waits for original work to settle. Genuine account phases and controller guards continue to exclude competing instances. The wrapper borrows owners; a cancelled controller can still close its own stores, which must then be authentically reopened.

Proof recovery reuses the original durable signature and fills its empty proof slot only after fresh verification and exact state comparison. A separate submission call reacquires the existing submission authorities and retains prior-attempt protections. Neither history nor a successful recovery automatically submits, retries uncertainty, releases a hold or grants disclosure permission.

## Checks and controlled native composition

Two separate root runs passed with natural exits: 506 core tests in ten suites (177.974 seconds) and 113 fixture tests in six suites (0.723 seconds). The total is 619 tests across sixteen disjoint suites, not one full-repository regression. Both strict lint checks passed; explicit formatting covered four core and eleven fixture files. Six core mutation controls, four fixture mutation controls and four default-path AST controls distinguish the intended guards. History tests use real encrypted stores with mocked owner issuers; companion tests use controlled delegates. The native composition below provides the separate genuine-owner/controller evidence.

One fresh disposable Shield chain passed on its first attempt without source or expected-report changes. All four original processes exited 0: setup, signature stop, recovery stop and recovered submission. The original driver also exited naturally with code 0, observed by the parent. No failed native campaign is being relabelled as successful. Independent engineering review subsequently revalidated the archived stages and a negative control that flips a companion flag; this is bounded implementation/evidence review, not an external security audit.

| Process                                                    | Utility processes | Workers | Broker key loans |
| ---------------------------------------------------------- | ----------------: | ------: | ---------------: |
| Setup                                                      |               296 |      28 |               18 |
| Signature stop                                             |                16 |       6 |                6 |
| Recovery stop, including cancellation and healthy recovery |                12 |       4 |                6 |
| Recovered submission                                       |                23 |       7 |                5 |

Recovery discovered the original selector through authenticated history and held exactly one delivery of a real verifier result after that verifier had exited. Closing the companion revoked its lifetime while the original recovery Promise and closure barrier remained pending. Competing history encountered the genuine recovery phase, and competing proof recovery encountered the controller guard; these refusals preserved the held stores. Release preserved the original cancellation outcome and Promise/result identity.

The cancellation cause is a source-derived inference supported by measured bounds and independent scope observations, not a phase-signal interception. The reservation scope remained live after companion abort, the verifier's composite signal was aborted, and the immediately checked admission-to-release and hold intervals stayed below 120 seconds and five seconds respectively. The held callback had not reached its finalizer, and the pinned phase timeout could not have elapsed within that bound. The report expressly records no direct phase-signal observation and no live-child cancellation qualification.

Cancellation preserved the original signature and empty proof slot. Authentic reopening reused borrowed owners and retained the original records before explicit healthy recovery filled the proof slot. The entire recovery process used twelve utility processes, four workers and six broker loans: bootstrap plus cancelled and successful recovery attempts. Bootstrap includes spending-public derivation; no new spending signature, EOA signing or send occurred in this process. The successful retry reused the source client's cached chain check. Across the two attempts the protocol-RPC counts were one chain-ID check, 68 header reads and four log reads, matching the predeclared source derivation.

The new physical policy check is specifically the signature-stop→recovery-stop (P1→P2) comparison: seventeen total tracked files, exactly seven changed account files, none added or removed. This is the whole recovery-process union, including bootstrap lease/floor refreshes and healthy proof storage. Cancellation itself permitted no writes. Reopening made four record updates across three existing files; subsequent proof compare-and-set and floor writes overlap that set. These counts must not be added as if they described disjoint files. The other boundaries recorded ten changed files at P0→P1 and fourteen at P2→P3; those are hash-only observations, not new semantic storage-policy qualifications. The original retained signature and first operation were conserved; unchanged signature does not imply all encrypted storage bytes stayed unchanged.

The final fresh process discovered proof-present history, submitted through the genuine cold controller, preserved its original acknowledgement, and refused two explicit repeat attempts as prior attempts. It recorded one EOA signature, one send and the journal-before-send observation. Recovery did not automatically invoke submission or retry an uncertain result.

The stage claims use the current report’s top-level qualification flags together with `connected.recoveryCompanion`. P2 records `secondRecoveryStopQualified`; P3 records `secondColdSubmitQualified`, `secondSignedUnfinishedRecoveryQualified` and `newProcessRestartQualified`. Companion fields record the cancellation, reopen and original-settlement checks. Inherited nested component flags with similar names do not independently describe the outer process or override these stage-specific claims.

The reports qualify genuine local controller, verifier, encrypted-store and callback/phase composition against synthetic external chain and service inputs. They do not qualify live POI acceptance, funded activity, real Tor/OS egress, physical process drainage, power-loss recovery or arbitrary input creators and response modes. Natural observed command exits and logical closure assertions retain their stated scope.

This remains a fixed Freedom recovery companion. Portable recovery, a generic Kohaku Host, a recovery UI and retry policy are separate work. The funded owned-note lookup and other live disclosures retain their explicit permission gates; this controlled campaign grants none of them.

## Audit evidence

The [publication index](qualification/railgun-recovery-companion-2026-10-06/INDEX.json) hashes the other ten files in the eleven-file archive, including four byte-exact stage reports. [Provenance](qualification/railgun-recovery-companion-2026-10-06/PROVENANCE.json) distinguishes copied reports from derived, path-normalized summaries. [Audit scope](qualification/railgun-recovery-companion-2026-10-06/AUDIT.md) records the limits and omitted local inputs; this archive is not a standalone replay package. The root exporter reverified the frozen source/runtime inputs before publication without reading a profile or rerunning native work.

See the [parity plan](railgun-parity-plan-2026-10-04.md) for remaining integration work and live permission gates.
