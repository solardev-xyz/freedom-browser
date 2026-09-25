# Colibri 3 recovery qualification — 18 September 2026

Freedom pins `@corpus-core/colibri-stateless` 3.0.0. This release changes the
proof wire format and ZK guest; a v3 verifier cannot consume the v2 proofs
previously requested by the recovery worker. Manual requests now advertise the
installed verifier's encoded client version through the existing WASM runtime
wrapper. The required quorum, proof verification, freshness, checkpoint binding,
and Myotis ABI 26 import policy are unchanged. Native Colibri remains disabled.

## Offline fixtures

`captures/mainnet` and `captures/gnosis` contain public SSZ proofs, each
authority's actual HTTP response body/status, and the resulting authenticated
checkpoint. The manifest records Colibri's version, the outgoing proof request,
capture time and proof SHA256. No user profile, credential, wallet or private
address is involved. The original v2 captures remain historical evidence and
are also used as rejection controls.

`checkpoint-verifier-worker.test.js` restores the capture clock and runs the
real pinned WASM in a fresh process. It verifies both fixtures and rejects
corrupted proofs, wrong-network evidence, stale proofs, legacy v2 proofs and
malformed responses. Separate policy tests retain quorum disagreement,
unavailability, finality, request-boundary, cancellation and retry coverage.
Replay makes no network requests. Wrong-chain controls deliberately replay the
same wrong-network metadata at the other chain's endpoints, so a missing
fixture cannot be mistaken for a successful chain-binding check.

To capture new evidence, run from the repository root with a new output path:

```sh
node docs/audits/evidence/colibri-v3-2026-09/capture.cjs 1 /private/tmp/new-mainnet-capture
node docs/audits/evidence/colibri-v3-2026-09/capture.cjs 100 /private/tmp/new-gnosis-capture
```

The capture script calls the production worker without replacing its runtime
or changing its request. Keep successful fixtures only after reviewing their
proof hash, version and actual quorum provenance.

## Live and application checks

- Both strict native recovery campaigns passed with official Myotis 0.1.10 /
  ABI 26, Colibri 3.0.0, Electron 44.4.1 and Node 24.21.0 on macOS arm64.
  Ethereum completed in 84.9 seconds and Gnosis in 21.8 seconds. Both observed
  native `STALE_ANCHOR`, obtained a quorum-verified replacement, served verified
  account reads, stopped, restarted the same authenticated generation, served
  another verified read, and confirmed final stops. All four reads had valid
  peer, BLS and beacon-chain proof flags. Ethereum had two bounded caller
  timeouts before its successful reads; Gnosis had none. No snapshots
  were produced: these runs qualify checkpoint rebootstrap, not snapshot restore.
  All four active/unknown ownership rejection controls passed.
  [The summary](live-summary.json) records source/artifact hashes and outcomes.
  Those `sourceSha256` digests record the tree the campaign ran on, PR #386 at
  `9deb49d8` (2026-09-19), and are not rewritten afterwards. The review fix
  `6a257d69` later changed two of the attested files without re-running the
  campaign: `src/main/ens/colibri-runtime.js` (stricter client-version parse;
  same encoded value 196608 for the pinned 3.0.0, re-derived from the WASM's
  `_c4w_get_current_version_number()`) and this directory's `electron-main.cjs`
  (the harness now reports failed runs on any host). Check the digests against
  `9deb49d8`, not against `main`.
- All 297 focused Myotis and Colibri runtime tests passed across eight suites.
- Both production checkpoint workers verified live Ethereum and Gnosis proofs
  from an ASAR archive under Electron 44.4.1 on macOS arm64.
- The real ENS suite passed all six scenarios: contenthash, address, reverse
  lookup, verified missing-name revert, CCIP-Read and repeated cached lookups.
  Run with `NODE_OPTIONS=--experimental-vm-modules ENS_COLIBRI_E2E=1 npm test -- -- --runInBand src/main/__tests__/integration/colibri-e2e.test.js`.
  The VM-module flag is required; without it the normal fallback can return
  RPC-quorum results, which correctly fail the suite's Colibri-specific assertions.
- Electron UI harness: 11 ENS/settings tests passed; two optional live ENSv2
  content checks were skipped. This is separate from cryptographic verification.
- Full unit run: 242 suites passed, five skipped, two failed; 5,102 tests passed,
  28 skipped, three failed. The failures reproduce on unchanged main with the
  same test environment: two platform-dependent shortcut assertions in
  `settings-store.test.js`, and the local-Anvil Safe orchestration test that
  omits the now-required chain ID. These do not load the Colibri verifier.
- Lint passes. Existing formatting warnings in package.json and three touched
  test/worker files also reproduce on main; unrelated formatting is retained.

The `electron-main.cjs` harness uses the real manager, official Myotis 0.1.10
addon and supervisor, and fresh isolated directories. It seeds authentic
historical root/slot values with **synthetic persisted verification metadata**
solely to exercise staleness. The seeded native API marker is ABI 26; otherwise
the product correctly migrates the older ABI 25 record to a bundled generation
and the run does not exercise Colibri recovery. Success requires an observed
stale-anchor event, a schema-v2 quorum-verified replacement, verified account
reads before and after restarting the same generation, and confirmed stops.
Active and unknown ownership records must also block startup.

After `MYOTIS_DOWNLOAD_TARGET=darwin-arm64 npm run myotis:download` and
`npm run myotis:build-supervisor`, run with this checkout's Electron executable:

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  docs/audits/evidence/colibri-v3-2026-09/electron-main.cjs \
  "$PWD" /private/tmp/new-recovery-run 100 300
```

Use an existing empty run directory and chain ID 1 or 100. No personal profile
is opened and no transaction is sent; all node state and results stay in that
directory. The historical review-fixed harness alone is insufficient because
it did not require a verified replacement checkpoint in its success condition.

These checks do not qualify signed installers, other operating systems, native
Colibri, or long-duration network availability.
