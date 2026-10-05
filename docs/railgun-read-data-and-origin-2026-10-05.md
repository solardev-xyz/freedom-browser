# Railgun read-data extraction and origin diagnostics - October 5, 2026

This change separates Kohaku balance/note projection from Freedom's authenticated
wallet runner and adds a dormant matcher for supplied deposit-origin data. Both
remain in the main-process wallet boundary. It creates no renderer API, generic
Kohaku Host implementation, standalone package or new spending permission.

## Read-data extraction

`railgun-kohaku-read-data.js` normalizes asset filters and projects balances and
notes. `railgun-kohaku-read.js` retains genuine runner admission, currentness,
journal and receipt identity. Successful reads still consult current evidence;
the helper alone cannot authenticate ownership or make a balance spendable.
Results retain their unverified tags, frozen containers, original asset/note
references, spent filtering, deterministic ordering and ERC1155 refusal rules.

The reviewed compatibility corpus compares 384 baseline/candidate cases,
including getter/iterator ordering and exact caller-error propagation. There is
one intentional malformed-input tightening: a custom `assets.map` returning a
non-string key now refuses before a currentness read. Previously it could produce
an empty selection after one read. Valid custom string-producing maps retain
their previous behavior. These are internal JavaScript APIs, not hostile-data
deserialization boundaries.

The helper is included in the source-derived wallet policy and all twelve
qualifiers with explicit selected-source lists. The cold-credit qualifier uses a
recursive source inventory. **The changed source policy requires a newly qualified
wallet generation.** Old generations are not silently adopted or rewritten.
Earlier native reports retain their original source and policy scope; they do
not establish that an old generation can reopen under this policy. No existing
funded profile is opened, migrated or rebuilt by this change.

## Dormant origin matcher

`matchRailgunShieldOrigin` compares supplied transaction, receipt, active journal
record, owned-note data, checkpoint and expected funding address. It reuses the
existing receipt, resolution and checkpoint validators. The restricted match
requires one original native-to-WETH Shield, the full selected unspent net note,
matching funding sender and the existing qualification amount cap. Third-party
funding, changed transaction/position/amount, unresolved records and the distinct
archive record shape refuse.

Input is copied as bounded plain data without invoking supplied getters or
iterators. The output is a frozen `matched` or `refused` diagnostic with
`trust: 'supplied-data'`. Ownership authentication, canonicality verification,
spending and POI bypass flags are always false. Consistently fabricated input can
match; a regression explicitly demonstrates this limitation. The matcher does
not recompute the note commitment, derive note ownership, validate chain ancestry
or acquire genuine handles. Matching supplied hashes does not cryptographically
bind the owned note to the Shield event.
It has no production consumer and does not issue a recipient or signing permit.

A future main-process host must acquire and reattest genuine enrolled-account,
journal, coordinator and account evidence before using this relation. Binding
that host into production also requires source-policy coverage and fresh native
qualification. Any return-to-origin operation must preserve the ordinary POI,
review, reservation, proof and submission gates. POI-ineligible recovery remains
a separate policy decision.

## Integration and verification scope

The twenty imported files match the two reviewed candidates exactly. All sixteen
existing bases were unchanged at `b058e2fc`; the fourteen differences in the
older broad source snapshot are the separately reviewed main b0fa12ac merge.
All origin-matcher dependency pins match. No dependencies were installed or
upgraded for these changes.
The feature remains disabled and these are internal changes, so no user-facing
changelog fragment is added under the repository's internal-work exclusion.

Root lint and formatting pass. The explicit 260-file wallet/fixture regression
passes 9,741 tests across 259 suites in 590.569 seconds. Its one skipped suite
contains four upstream PPv2 storage-adapter checks, gated by the absent
`FREEDOM_PP_V2_STORAGE_FIXTURE` input. Fresh native contract/cold-credit campaigns
are planned, with no new native result claimed
yet. The initial test invocation accidentally treated folder arguments as Jest
exclusions and started unrelated integration suites inside the sandbox. It was
stopped and retained as excluded diagnostic output. The corrected run uses an
explicit test-file list. Native campaigns use fresh disposable generations and
synthetic public-vector chain and POI services only; no live POI query, live
service or live funds are involved.

The 260-file wallet/fixture command uses `--forceExit`; its command exit alone
cannot establish natural closure of test resources. The separately configured
OpenLV integration suite passes six tests in 0.429 seconds and exits naturally.
The broad repository regression passes 16,826 tests across 571 suites in 659.536
seconds, with 33 tests and five suites skipped. It excludes OpenLV explicitly
and exits naturally with code zero without `--forceExit`. Skipped checks are
the optional IPFS gateway/native, Colibri and ENSv2 integrations and upstream
PPv2/Kohaku fixtures whose prerequisites are absent; they are not new skips.
The complete 11,522-file pre-run source/input inventory remains byte-identical
after the run. This broader all-file inventory differs from the historical
5,795-file JS/JSON-oriented inventory; neither is an execution coverage count.
