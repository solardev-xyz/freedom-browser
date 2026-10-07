# Spending recovered Railgun change — October 5, 2026

The connected public-vector qualifier now spends the actual change from a first
partial withdrawal. Both Shield-first and received-Transact-first histories pass.
This continues the [normal change scan checkpoint](railgun-combined-change-integration-2026-10-05.md)
at `c6a1336e0933d92d2bef4dce5eb68bcf237efae3`. Services, chain observations,
receipts, finality, review callbacks and list trust remain synthetic; this is not a funded private
withdrawal or live service acceptance.

The optional `second-spend` mode runs the entire existing change lifecycle,
then reads the unique real change through the production account registry. It
stages that Transact input against the full existing TXID history, verifies its
partial creator including the final unshield commitment, and issues a new
full-withdrawal operation. The production controller acquires fresh operation-bound
membership, roots and preflight checks before a new reservation, spending
signature, 01x01 proof and independent verification. Actual one-use completion
and vault signing lead to a second durable attempted-before-send journal entry.
Reusing the consumed completion refuses without further transport activity.

The second operation is a version-1 full withdrawal; it retains the existing
full-withdrawal receipt rules, not the partial transaction's stricter five-log rule.
The second receipt is resolved through production recovery with explicitly
unverified RPC trust, then captured through the genuine own-operation reader.
The second transaction/capture is kept in private fixture continuation data;
reports publish only aggregate checks. The original signed capsule, signature,
proof and hold remain identical. The first retained-POI attempted entry,
inspection (including its two remaining reserves) and encrypted bytes remain
unchanged. The first Ethereum transaction's identity, nonce, intent and resolution
are preserved. Its observation timestamp, confirmations and revision legitimately
refresh four times through ordinary `assertCanSubmit` reconciliation; the fixture
checks those precise changes and the original canonical anchor.

| Case | Time | Utility children | Storage workers |
| --- | ---: | ---: | ---: |
| Shield-first second spend | 99,991 ms | 306 | 31 |
| Transact-first second spend | 109,477 ms | 349 | 34 |
| Shield change-only compatibility | 91,666 ms | 295 | 28 |
| Shield default compatibility | 85,359 ms | 289 | 25 |

Both runs share 860 current source hashes. Each adds eleven second-phase
utilities: two wallet, three TXID, one creator-provenance, one POI, one signing,
one operating/proving and two verification jobs. It adds three storage workers,
one fresh signed membership acquisition and three latest/validate TXID root
pairs, without another POI POST or TXID page append. Both full preflights use
the new root/nullifier and pinned 01x01 verifier. Each complete run signs and
sends two Ethereum transactions, journals each before send, and has two review
callbacks. All utility and storage exits are accounted for; the only deliberate
revocations remain the two earlier wrong-output cases. No fixture violations
remain and all three observed storage-key copies are wiped.

Change-only compatibility passes its original twenty stages in 91,666 ms
against the same 860 source hashes, with 295 utility children and 28 storage
workers. The default case passes its original seventeen stages in 85,359 ms,
with 289 utilities and 25 storage workers. Second spending stays disabled in
both compatibility cases; the default case also omits the change scan. The
[evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-combined-second-spend-integration-2026-10-05.json)
records the final reports, source inventories, commands and diagnostic hashes.
The seven focused suites pass 132 tests in 8.043 seconds; the subsequent overlapping
two-suite check passes 46 tests in 1.44 seconds after the last result-shape fix.
These counts are not added together. Full lint is clean. Unit scope covers the
selector, chain responses and earlier helpers, including a real production
reconciler exercise; the complete second-spend orchestrator was first exercised
by the native runs.

Pre-native review corrected an acknowledged-status result assumption, a normal
utility-exit-code assumption, and missing exact journal nonce binding. Native
Shield-a's second proving refused after one unexpected transaction-route failure;
root and B traced it to the omitted first-transaction refresh route, and review
of that path found that whole-record equality would also reject the legitimate
refresh. Native Shield-b reached second
signing/proving/submission but refused on the reviewer's suggested
`submissionState` check: that field belongs to ordinary enrolled leases, while
the private path records its submitted state through its own authenticated
journal. The final fixture checks the private result's exact signed hash and the
actual journal's state. Both failures are retained as diagnostics, not successful
qualification. No production guard was relaxed.

Only fixtures and documentation change. Production, package, dependency and
policy bytes are unchanged from the preceding checkpoint; the 15,731-test
regression remains evidence for its original `c5d75f05` snapshot, with the
recorded skips, OpenLV exclusion and forced-exit limitation. It was not repeated
or relabeled here. No funded profile or live endpoint was accessed. Claude and
independent Codex agents review the implementation and evidence; this is
engineering review, not an external security audit.

All second-spend work is in the same process, with prior enrollment reopening.
No Tor routing or operating-system egress tracing is qualified by these runs.
The wallet has not yet ingested the second receipt to mark the change spent.
That terminal scan, genuine process restart before the second operation,
recovery/submission of the second operation across a restart, partial Kohaku
facade integration and live qualification remain open. The test-service
membership result grants no production service authority. Private broadcasting,
portable adapter extraction and user-facing activation remain separate work.
