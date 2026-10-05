# Terminal second-spend ingestion evidence — 2026-10-05

Status: all five reports independently audited. Root confirmed all five original
top-level Electron handles drained with exit 0. No cases remain pending. No root
files were edited or native processes launched by this audit.

`AUDIT.json` records verified report metrics, `COPY-PLAN.json` proposes five
byte-exact copies, and `SOURCE-HASHES.json` contains the shared 868-file inventory.
All audited reports contain exactly that inventory; all hashes match the current
repository. All five rows are ready for byte-exact publication.

| Case | Elapsed | Raw SHA-256 | Status |
|---|---:|---|---|
| Shield terminal, native-shield-oct5-b | 99,085 ms | 06e36e4b897e866dd1749ffcdc1fa676643fe24a3648be46862df801a8035213 | Root confirmed drained exit 0; audited |
| Transact terminal, native-transact-oct5-a | 105,041 ms | f0a085ab77bb27b98665612491ef0a4fedcd6264b9ca937d544c38d968acca58 | Root confirmed drained exit 0; audited |
| Shield second-spend compatibility | 97,197 ms | 519af74a69b6723b70c9743ea3222eb99d8a76e2e8f13d6328ab1711c051588c | Root confirmed drained exit 0; audited |
| Shield change-only compatibility | 89,402 ms | dd7ac7af7e25dcd28d0d0616e5f785f7f9c3d65e6bc4573d2609d1126e945f69 | Root confirmed drained exit 0; audited |
| Shield default compatibility | 84,531 ms | af40b3e4195c99bd1f68a8dfae6a00004da9bd7e13f3b50bdf2c201c13f1b169 | Root confirmed drained exit 0; audited |

## Terminal evidence

Each terminal report includes 20 retained/change connected groups, a separate
second-spend section, then terminal ingestion. The terminal delta is ten genuine
utility jobs: one fixture row projector, two public plan/apply jobs, six TXID jobs
(two inspect/project/apply each), and one ordinary wallet scan/viewing loan. Two
new storage workers close. Recorded calls are exactly 25 protocol headers, one
logs request, four public TXID latest calls, three root validations, one indexer
page. No new signing, private operation, POI proof, EOA send or acceptance POST
occurs in the terminal phase.

The new row comes from actual proved full-unshield calldata/capture. Pinned engine
crypto checks the final unshield commitment, actual normalization and projection
preserve every earlier canonical row/checkpoint/transcript, and the real own-TXID
matcher succeeds before public/TXID advance. Two new proxy source events represent
Nullified and Unshield; no new UTXO commitment is inserted.

An ordinary production wallet scan marks the actual selected change spent by the
second transaction, preserves the original input's first-transaction spender, and
preserves all other notes, roots and lengths. The selected change's remaining
unspent amount is zero. **This does not mean the whole wallet balance is zero.**
The pinned source retains unrelated WETH: 700 for Shield-first and 2,000 for
Transact-first. The fixture asserts exact note preservation and that total unspent
WETH decreases by precisely C; reports expose booleans rather than private notes.

Both signed private records, both resolved EOA records, the first attempted POI
entry/inspect/reserves/ciphertext and disposable acceptance state stay unchanged
across terminal work. Public/TXID maintenance may update its own storage metadata.
Only the separately measured wallet phase asserts exact unchanged filenames and
walletAndCoverage plus walletJournal as the two changed classes. This is not a
whole-profile or EOA-file byte-invariance claim.

Compatibility modes preserve their prior scope: second-spend has 20 groups plus
its second-spend section, change-only has 20 groups without second spend, and
default has 17 first-stage groups. None has a terminal section or claims terminal
ingestion. Their observed utility/worker counts are 306/31, 295/28 and 289/25;
all share the exact same 868-source inventory as the terminal pair.

## Drainage and publication boundaries

Terminal Shield has 316 observed utility exits and 33 storage-worker exits;
Transact has 359 and 36. Every per-job start/exit/result inventory reconciles. Attempted results equal job
starts; admitted results exclude exactly the two intentional output refusals. Guard
reports cover every non-identity-bootstrap job; identity bootstrap is separate.
Utility exits are code 15 after supervisor closure, without escalation or peer
disconnect. Two intentional output-refusal jobs report SESSION_REVOKED; every other
utility reports PROCESS_CLOSED. Storage workers exit 0. Root separately confirmed
the top-level Electron processes drained with exit 0.

All five request/reply key inventories match; three storage-key copies per run are observed and
zero remain unwiped. Sticky fixture assertions, pending transports and unexpected
transport failures are zero. Every runtime guard reports zero attempts. Each
terminal case has two EOA signatures, two sends and two journal-before-send checks,
all from the preceding operations. Terminal work adds one viewing loan only.

Raw reports contain counters, booleans, hashes and public-vector provenance. A
recursive check found no structured raw capsule/signature/proof/ciphertext/private
key/viewing key/second-capture fields. Copy only the listed raw reports; never copy
profiles, saved keys, durable private continuation/capture or capsule records.

This is same-process offline composition over simulated chain, receipts, finality,
service responses and disposable list trust. It does not qualify live service
acceptance, live RPC/Tor, host OS egress tracing, second cold submission, fresh-process
restart, facade or UI. No current full-regression rerun is claimed.

## Diagnostics and test evidence

- Failed Shield-a diagnostic:
  `/private/tmp/railgun-terminal-ingest-native-shield-oct5-a/diagnostic.json`, SHA
  `647c88f568f7dc44dfb30ab44403e2458c76f5dade9a5c88dafd5fe5577d0f1b`.
  Root confirmed drained exit 1. Failure at second-open-wallet preceded any second
  signature/send: the fixture incorrectly assumed one global unspent WETH note.
  The fix preserves unrelated notes and checks selected-change/total-delta semantics;
  it does not alter production scanning or spending behavior.
- `/private/tmp/railgun-terminal-ingest-root-oct5-tests-a.log` is a failed command
  because a requested test filename did not exist; do not report it as a passing
  suite despite the other tests passing.
- Final `/private/tmp/railgun-terminal-ingest-root-oct5-tests-c.log`: 158 tests,
  10 suites, 8.218 seconds, pass. Final lint:
  `/private/tmp/railgun-terminal-ingest-root-oct5-lint-b.log`, pass.
- The overlapping owned data suite has 29 passing tests in
  `/private/tmp/railgun-terminal-ingest-multinote-data-oct5-test-b.log`.
  Detached control `/private/tmp/railgun-terminal-ingest-multinote-control-oct5.log`
  verifies that removing only the final second-capsule nullifier join accepts the
  mismatch that real code refuses. Do not add overlapping test counts.
- Root repair provenance: `/private/tmp/railgun-terminal-ingest-root-repair-oct5.json`.
  Independent reviewer transcript excerpt (plain text despite the filename suffix): `/private/tmp/claude-terminal-ingest-review-oct5.json`.

Historical profiles and failed reports remain local diagnostics, not successful
qualification. No new native execution or storage mutation occurred during this audit.

Publication note: the adjacent integration index embeds the audit, copy plan and source inventory named above. Local paths describe provenance; they are not standalone download links.
