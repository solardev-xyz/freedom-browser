# Myotis seed-pin qualification — 2026-09-24

Official Myotis v0.1.12 / ABI 32, Electron 44.4.5, macOS arm64. Production
manager, supervised addon child, ENS resolver, checkpoint quorum and Colibri
verification. All three runs were sequential, in newly created temporary
profiles. No default/existing user profile was opened or modified.

## Implementation and source

The five mainnet and eighteen Gnosis enodes are the user-authorized lists from
freedom-browser-ios commit a247d32, copied without changing entries. Both lists
pass host validation unchanged. They are untrusted discovery hints; neither
checkpoint authority nor proof-verification policy changes.

Each native launch gets a newly shuffled selection through the existing private
startup message. The child validates and applies it immediately after native
`start`, then acknowledges only count/applied. Initial start, cold restart,
stale-generation start and recovered-generation start all use that path.

## Live results

Mainnet timings start after the manager's `startMyotis` returns. Import timing
starts at the generation pointer swap. Gnosis timing includes temporary-profile
and Electron initialization. These are local observations, not uptime or latency
guarantees. No mainnet resolution cache hit or fallback counted as a read:
the driver clears ENS caches before each call and requires `trust.method=myotis`,
`trust.level=verified` and the expected `vitalik.eth` address.

| Case                                                                       |             Run A |             Run B |   Read time A / B |
| -------------------------------------------------------------------------- | ----------------: | ----------------: | ----------------: |
| Fresh cold mainnet: serving peers / first verified ENS                     | 11.10 s / 11.95 s | 11.11 s / 12.00 s | 0.850 s / 0.885 s |
| Restart with current generation's EL cache moved aside: first verified ENS |           1.975 s |           1.950 s | 0.973 s / 0.945 s |
| Stale recovery: first verified ENS from start                              |           6.090 s |          15.553 s | 1.070 s / 0.933 s |
| Stale recovery: first verified ENS after pointer swap                      |           2.259 s |          12.196 s |        same reads |

All six ENS reads succeeded on the first attempt after readiness. Cold restarts
retained native/CL state but renamed `peers.cache` to `peers.cache.saved` after
verified stop. The saved cache was not overwritten. Warm stale recovery used
the authentic old checkpoint fixture with synthetic historical host metadata
solely to trigger the native stale guard, then real quorum + Colibri acquisition.
Both warm caches matched at pointer publication; no old snapshot was adopted.

Gnosis cold start accepted all 18 pins, reached two serving peers at 12.224 s
and completed a Myotis account read at 12.252 s (28 ms call). The result reported
`peerProofValid`, `blsVerified` and `beaconChainVerified` all true. This tests the
list together, **not** each Gnosis candidate in isolation.

Every seed push was accepted: eight mainnet pushes of five pins across the two
runs, plus one Gnosis push of eighteen. No batch was refused. That confirms the
API accepted all entries, not that every address connected or served. All native
children/supervisors retired with verified receipts.

The earlier unseeded cold restart had no successful ENS result in eight minutes;
these seeded runs both completed in about two seconds. However, fresh startup
still took about twelve seconds here, so the mobile five-second expectation was
not reproduced. These measurements reduce the earlier cold-serving concern but
do not establish cross-platform or sustained-network performance.

## Evidence and reproduction

- [mainnet-a.json](mainnet-a.json), [mainnet-b.json](mainnet-b.json): sanitized
  phase/status/read events, cache hashes, import events and pin acknowledgements.
- [gnosis.json](gnosis.json): status, verified account result and pin acknowledgement.
- Each file records the SHA-256 of its original local log; profile paths are omitted.
- [qualification.cjs](qualification.cjs) reproduces mainnet fresh/cold/recovery
  on a new temporary profile; [gnosis.cjs](gnosis.cjs) does the Gnosis account check.

From the repository root on macOS arm64:

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  docs/audits/evidence/myotis-seed-pins-2026-09/qualification.cjs "$PWD"
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  docs/audits/evidence/myotis-seed-pins-2026-09/gnosis.cjs "$PWD"
```

These drivers expect the bundled lists, no seed overrides. The optional final
argument to `qualification.cjs` selects recovery-only using read-only warm cache
input from a stopped disposable node. Production refresh and override instructions
are in [myotis-seed-pins.md](../../../myotis-seed-pins.md).

## Automated validation

- `npm run lint`: clean.
- Final `npm test`: exit 0, 257 suites / 5,524 tests passed; 4 suites / 25 tests skipped.
- Parser: invalid types/JSON, IPv4/port boundaries, DNS/IPv6/query rejection,
  address deduplication, same key at different addresses, caps, unchanged bundles.
- Selection/loader: deterministic injected RNG, membership, no mutation, limits,
  missing resources and replacing/empty overrides.
- Child/process/manager: after-start application on both constructors, recovery
  relaunch, network-specific restart selection, empty-list skip, refusal/missing
  API/exception fallback and bounded diagnostic validation.
- Refresh tool: proven-peer filtering, IPv4-mapped normalization, bad entries and
  deduplication; no live network request in its test.

Only macOS arm64 was executed live. There is no new renderer surface or dependency,
and no signed-package or new Linux/Windows native execution claim.

## Four-peer Gnosis update — 2026-09-25

The current bundle retains four Gnosis addresses from the mobile team's pool
admission probe (iOS `ca470e3`); mainnet stays at five. The measurements above
remain historical evidence for the original eighteen-entry list.

A new disposable-profile desktop run accepted four pins, reached one serving
peer at **8.225 s**, and returned a verified account at **8.279 s** (**54 ms**
read). All three proof flags were true; the child and supervisor retired cleanly.
See [gnosis-four.json](gnosis-four.json). This verifies aggregate service, not
individual peer quality or a speed improvement caused by pinning. Built-in
Gnosis bootnodes remain enabled. The reproduction driver now reads the expected
count from the bundled JSON.
