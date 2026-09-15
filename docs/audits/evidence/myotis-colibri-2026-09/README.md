# Myotis / Colibri research evidence

These are research probes for the exact `@corpus-core/colibri-stateless@2.0.6` already pinned by Freedom. They do not change application behavior or start Myotis. Use Node 24 with Freedom's existing dependencies installed. Native Colibri is disabled; probes use its shipped WASM.

The captures contain public block proofs, public checkpoint responses, and request/result logs from 2026-09-14. No wallet, user profile, private keys, or transaction submissions are involved. Raw proof SHA-256 values are in each `result.json`. The initial `replay-*.json` files were recorded at the real wall clock after capture, so their otherwise-correct proof was already older than the 60-second limit. The `replay-clock-*.json` and `semantics-*.json` files use the stated simulated capture-time clock to isolate the tested property. The evidence is an operational snapshot, not a guarantee of current endpoint availability or a complete security audit.

## Offline checks

These use committed public proof bytes and synthetic checkpoint responses. They perform no network requests. The clock is set to the capture time for the successful baseline, then advanced 28 days for the stale-latest replay. This does not change the system clock. Each invocation uses fresh in-memory verifier storage; the `correct` scenario deliberately retains it for the warm replay.

Run from the repository root:

```sh
node docs/audits/evidence/myotis-colibri-2026-09/fallback-probe.cjs
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 beacon-root
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 beacon-root
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 correct
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 correct
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 wrong-root
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 wrong-root
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 unavailable
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 unavailable
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 missing-witness
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 missing-witness
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 1 finalized-tag
node docs/audits/evidence/myotis-colibri-2026-09/replay-probe.cjs 100 finalized-tag
```

The `beacon-root` scenarios verify the exact captured bytes, decode those same bytes, compute the SSZ beacon-header root and assert the roots reported in the research. They are not live Myotis comparisons. The scripts assert the observed outcomes, including acceptance of the unchanged latest proof when only the requested tag is changed to `finalized`. That test shows this block-proof API is not a standalone finality certificate. The missing-witness test tests an absent configured signer, not a live witness service or signing-key compromise. The fallback test checks shipped JS routing only, not whether a forged root passes the full verifier.

Replay JSON output goes to the system temporary directory. Committed captures are not modified.

## Live read-only probes

These contact public block-proof/checkpoint endpoints and save public responses to a temporary directory (`COLIBRI_EVIDENCE_DIR` overrides the output directory). They use fresh in-memory verifier state, 12-second fetch timeouts, and a 90-second process watchdog. Do not point the output directory at committed captures.

```sh
node docs/audits/evidence/myotis-colibri-2026-09/live-probe.cjs 1 true latest
node docs/audits/evidence/myotis-colibri-2026-09/live-probe.cjs 100 true latest
node docs/audits/evidence/myotis-colibri-2026-09/live-probe.cjs 1 false latest
node docs/audits/evidence/myotis-colibri-2026-09/live-probe.cjs 100 false latest
node docs/audits/evidence/myotis-colibri-2026-09/live-probe.cjs 1 true finalized
```

Arguments are chain ID, ZK setting and block tag/height. Each run asks for a full block then compact block header; the second request deliberately reuses the first request's verified committee cache. Errors are recorded in JSON and do not necessarily set a failing exit code: this is an observation harness, not the application test suite. The scripts do not automatically accept stale Myotis anchors or enable application recovery.
