Publication note: this preserves the independent audit below. Its named scratch
files are consolidated into the adjacent published
[qualification index](railgun-combined-second-spend-integration-2026-10-05.json);
the four raw reports are published at the destinations recorded there.

# Independent second-spend native evidence audit — 2026-10-05

Status: all four reports independently audited. Root confirmed all four top-level
Electron processes drained with exit 0; no cases remain pending.
No root files edited and no native processes launched by this audit.

## Reports and copy plan

`COPY-PLAN.json` lists exactly four proposed byte-exact raw report copies. All
four are ready. `AUDIT.json` records independently checked metrics and
`SOURCE-HASHES.json` contains the common exact 860-file source inventory. Every
listed hash matched the current repository during this audit.

| Case | Elapsed | Raw report SHA-256 | Process |
|---|---:|---|---|
| Shield-first second spend, native-shield-oct5-c | 99,991 ms | 3fb13ad7d19f71f0a165cfb9c82dc2a746231f4c8132a76829d940a6c0873b88 | Root confirmed drained exit 0 |
| Transact-first second spend, native-transact-oct5-a | 109,477 ms | 54fd4dcbe9291ef6a7094cecc4ea1264adcbb7ba136f000bb5e0fbcf6bc9f4fa | Root confirmed drained exit 0 |
| Shield change-only compatibility, compat-shield-oct5-a | 91,666 ms | 32d1fd6db46b1ed85d100c5e375f58ffd4bc056731b8035b2e5376db353685f4 | Root confirmed drained exit 0 |
| Shield default-mode compatibility, default-shield-oct5-a | 85,359 ms | 25d70b414ef68a6da47f78eb135544c0397279dbc3abff07a99d6489b5ec52fc | Root confirmed drained exit 0 |

All source-vector SHA fields equal the public test-vector hash
`bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41`.
This is distinct from each report's 860-entry source-code inventory.

## Audited connected evidence

Both second-spend reports include 20 retained/change connected run records and a
separate real second full-unshield section; this is not 21 connected run records. Genuine normal change scan adds exactly one wallet
utility, one viewing loan, one wallet storage worker, eight protocol block reads.
Only wallet/coverage SQLite and wallet journal change; protected stores stay byte
identical. The recorded change matches the actual first partial commitment and V-U.

Disposable list acceptance records one POST, one independent payload-verifier exit,
one keyless binding exit and one signed event. The list is Missing before and Valid
after that simulated acceptance; no actual live service acceptance is claimed.

Each second operation adds exactly eleven jobs: wallet 2, TXID 3, note-provenance 1,
POI membership 1, private-operate 1, spending-sign 1, independent private verifier 2.
The first partial creator's final unshield preimage is verified. The second circuit
is 01x01 with a v1 full-unshield capsule; fresh window POI/root/preflight remain real.
It adds one real EOA signature, one durable attempted-before-send check, one simulated
raw send and one transaction review. Both runs total two EOA signatures/sends.

Second-route attempted and validated RPC maps are exactly equal. Two full preflights
query rootHistory/unshieldFee/getVerificationKey/nullifiers twice each. Four first
canonical-header refreshes are observed; the first attempt's identity/resolution are
preserved while its legitimate observation revision/depth/time refreshes are checked.
The old entire-first-record byte-invariance claim is not repeated.

The first v3 POI entry and encrypted POI bytes remain unchanged through the second
spend. Two reserved transitions remain. Its one-use attempted state is not retried
or promoted to accepted by the sender's response. Synthetic second receipt resolution
and genuine own-operation capture complete; no raw capture is included in the report.

Change-only compatibility retains 20 connected records, genuine scan and disposable
list acceptance, but no second spend. Default mode retains 17 first-stage records,
with no change scan, list acceptance or second spend. Both compatibility reports have
one EOA signature/send and one attempted-before-send check; both retain two reserved
transitions and no post-response promotion to accepted. All four source maps are equal.

## Drainage, credentials and limits

Shield: 306 utility exits and 31 storage-worker exits. Transact: 349 utility exits and
34 storage-worker exits. Change-only: 295 utility exits and 28 storage-worker exits.
Default: 289 utility exits and 25 storage-worker exits. Per-job starts, exits and total
jobs reconcile exactly in all four reports. All
storage workers exit 0. All utility exits are observed code 15 after supervisor close,
without escalation/peer disconnect: two intentionally refused output jobs are labeled
RAILGUN_SESSION_REVOKED; the rest are RAILGUN_PROCESS_CLOSED. Do not describe those
utility exits as OS exit 0. Root separately confirmed each top-level Electron exit 0.

Credential request/reply inventories match. Shield wallet viewing 6, Transact 7;
both have private-operate 2, spending-sign 2, private-receive 1, POI-prove 1 and output
recovery viewing 8. Transact additionally has one Transact-selector viewing loan.
Identity bootstrap spending-public/viewing-identity each occurs once. Storage-key
copies observed: 3, unwiped: 0. Full inventories are retained in raw reports/AUDIT.json.
Wrapper transports close 52/52 and 58/58 for the second-spend pair, 48/48 for change-only
and 46/46 for default, all with zero pending requests. Underlying service pending and
unexpected-failure counters are zero. Sticky fixture assertions are empty in all four.
Compatibility wallet-viewing loans are four (change-only) and one (default); both have
one private-operate, one spending-sign, one private-receive, one POI-prove and eight
output-recovery viewing loans. All four observe three storage-key copies, zero unwiped.

This qualifies offline same-process genuine controller/signing/journal/proof/membership
composition over synthetic transport, pinned bytecode and public test vectors. It does
not qualify live chain/service/Tor trust, host OS egress tracing, facade/UI access,
second cold submission, new-process restart, or ingestion/rescan of the second spend.
The two deliberate output-refusal cases are successful negative controls, distinct
from historical failed top-level diagnostic runs below.

## Historical diagnostics — not successful qualification

- `/private/tmp/railgun-combined-second-spend-native-shield-oct5-a/diagnostic.json`
  SHA `1f115a3b22f5bb06c3be2fe6cc5bcbfdbb868e57d268f126fd8e6f8ed2283485`.
  Root confirmed failed/drained. Phase second-prove, only the first EOA send/signature.
  Fixture omitted first canonical-header routing and incorrectly required whole first
  record equality despite production reconciliation updates. Fixed in later fixture.
- `/private/tmp/railgun-combined-second-spend-native-shield-oct5-b/diagnostic.json`
  SHA `ad1ec1516f5ca481518a48276edf68ad1989d37f7900cb09c072cff74d9a6840`.
  Root confirmed failed/drained. Phase second-submit, genuine second sign/send already
  occurred; fixture incorrectly asserted a private submissionState field. Later fixed.

Retain these diagnostics locally with their original profiles/logs. Do not copy profile
contents, vault metadata, raw capsule/signature/proof/history or private second capture.
The successful raw reports were recursively checked for those structured secret/data
fields; none were present. Counters, booleans and hashes are the publication boundary.

## Test/lint scope

- `/private/tmp/railgun-combined-second-spend-root-oct5-tests-c.log`: 132 tests/7 suites,
  8.043s, pass.
- `/private/tmp/railgun-combined-second-spend-root-oct5-tests-d.log`: overlapping final
  46 tests/2 suites, 1.44s, pass. Do not sum these into 178 distinct tests.
- `/private/tmp/railgun-combined-second-spend-root-oct5-lint-d.log`: final root lint pass.

The previous full regression of 15,731 tests remains c5-only historical evidence;
there is no refreshed full-regression claim for this fixture milestone. Production
sources remain unchanged from c6, per root scope; the native inventory is the exact
source manifest above, not a substitute claim that the full regression reran.
