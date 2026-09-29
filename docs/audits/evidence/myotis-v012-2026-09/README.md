# Myotis v0.1.12 desktop qualification — 2026-09-24

The host upgrade and peer-cache inheritance pass their regression tests.
**Live serving latency is not qualified:** the official ABI 32 addon still
intermittently counts a peer as serving immediately before that peer returns
zero headers for a read. Keep the PR draft pending review of these results.

## Environment and isolation

macOS arm64, Node 24.18.1, Electron 44.4.5; official Myotis v0.1.12, ABI 32,
with the release manifest and all five addon digests pinned. The native macOS
constructor/ABI checks passed. Other platforms were downloaded and hash-checked,
not executed here; their load checks belong to CI.

Every run used a freshly created OS temporary profile. No existing user profile
was opened or changed. The production manager, supervisor, ENS resolver,
checkpoint quorum and Colibri verifier ran without module replacements.
ENS policy was restricted to `myotis` so a Colibri or RPC fallback could not
be mistaken for a successful Myotis read. These checks exercised the main-process
trust result (`level: verified`, `method: myotis`); no renderer screenshot was
captured. Independent profiles overlapped during part of the campaign, so this
is an observation of real peer behavior, not an isolated latency benchmark.

## Observations

Times below are local elapsed times, not network-wide guarantees.
[observations.json](observations.json) retains sanitized event excerpts,
including failures and source-log hashes.

| Case                        | Result                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entirely fresh cold install | `SYNCED` at 3.47 s, with 1 snap peer and 0 serving; first ready at 11.51 s. Several reads failed before `vitalik.eth` resolved through Myotis at 166.51 s. Successful read took 6.85 s. Verified stop saved 1 `snapok`, 0 `snapbad`                                                                 |
| Cold EL restart             | After verified stop, moved the current generation's `peers.cache` to `peers.cache.saved`, retaining CL/native state. No successful ENS read in 480 s despite intermittent positive serving counts. Clean verified stop; new cache contained 0 `snapok`, 0 `snapbad`; saved original remained intact |
| Warm stale recovery A       | Real `STALE_ANCHOR`; quorum and Colibri completed and published a new generation at 3.03 s. Both peer-cache files matched their input SHA-256 at pointer publication. ENS succeeded 45.85 s after publication; the successful read took 4.58 s. One preceding read failed                           |
| Warm stale recovery B       | Same cache inheritance proof, with publication at 3.24 s. ENS eventually succeeded 184.08 s after publication; successful read took 7.61 s. This repeat missed the one-minute target                                                                                                                |

Both warm runs used the same real cache, containing one `snapok` and no
`snapbad`, obtained from a stopped official-addon diagnostic node that had
successfully executed the Universal Resolver call. To trigger actual native
staleness, the disposable fixture used the authentic v0.1.7 root/slot from the
existing recovery evidence plus **synthetic historical host verification
metadata**. No old native snapshot was adopted. The production recovery flow
acquired a fresh schema-v2 checkpoint with Sigma Prime, EthStaker and ChainSafe
as its three participants, verified it through Colibri, retired the old native
child and imported the replacement. Cache inheritance was observed at the
pointer swap, before startup could rewrite the copied files.

All runs ended with verified child/supervisor retirement. The cold campaign
exited with failure as intended; the warm campaigns completed functional
recovery, but only A met the one-minute serving target.

An independent direct call to the unmodified official addon reproduced:

```text
el dial: peer announces a head far behind the anchored one — not pooling
all 2 snap peer(s) failed to serve a verifiable block: 2x peer returned 0 headers, expected 1
```

The same probe later returned `status: ok`, `blockNumber: 26049114`,
`verified: false` for the Universal Resolver call at `latest`. Here `verified`
is the finality flag; the optimistic execution root is still authenticated.
Its final cache contained one `snapok` and zero `snapbad`. The failed cold
restart likewise left zero `snapbad`; no cache poisoning was observed.

A positive `snapServingPeers` count is based on announced/proven head coverage
and whether a peer is read-benched. It is not a completed read probe. The
remaining zero-header failures occur in the upstream addon independently of
Freedom's ENS adapter. These runs do **not** substantiate a blanket claim that
v0.1.12 resolves cold serving or always serves warm recovery within one minute.

## Automated validation

Final standard `npm test` command exited 0:

```text
Test Suites: 4 skipped, 255 passed, 255 of 259 total
Tests:       25 skipped, 5471 passed, 5496 total
Snapshots:   0 total
```

`npm run lint` and `git diff --check` passed. The checkpoint-store suite has
85 passing tests. Three pre-existing fixture failures were corrected in a
separate commit: two macOS shortcut expectations and a missing chain ID in the
Safe fork test. An intermediate parallel run hit a Jest worker SIGSEGV, and a
serial run reported late OpenLV WebSocket logs despite all suites passing;
the final standard full run passed with exit 0.

Prettier was checked on changed files. Nineteen existing files already fail
its check on the base commit; no broad formatting rewrite was made. New
qualification artifacts pass Prettier.

`npm run myotis:download` downloaded/hash-checked every target and printed:

```text
Official Myotis ABI 32 checkpoint import constructor checks passed (no networking)
Installed official Myotis v0.1.12 (darwin-arm64)
Installed official Myotis v0.1.12 (darwin-x64)
Installed official Myotis v0.1.12 (linux-x64)
Installed official Myotis v0.1.12 (linux-arm64)
Installed official Myotis v0.1.12 (win32-x64)
```

## Reproduction

After installing the lockfile dependencies and running `npm run myotis:download`
and `npm run myotis:build-supervisor`, run with the locked Electron executable:

```sh
node_modules/.bin/electron docs/audits/evidence/myotis-v012-2026-09/qualification.cjs "$PWD"
```

The harness creates its own temporary profile, attempts cold install, cold EL
restart, then warm stale recovery, stopping on failure. To independently test
recovery using peer hints from a **stopped test node**, supply its data directory
as a third argument. That directory is only read; the recovery profile is new:

```sh
node_modules/.bin/electron docs/audits/evidence/myotis-v012-2026-09/qualification.cjs "$PWD" /absolute/path/to/stopped-test-generation
```

Warm A used an equivalent temporary recovery-only variant while the cold
campaign was still running; warm B executed the committed optional-directory
mode. Every run emits status/read outcomes and writes `qualification.json`
inside its new profile. The harness's functional success does not assert a
one-minute latency budget; inspect `recovery-complete.sinceImportMs` separately.
