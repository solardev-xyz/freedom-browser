# Disposable relay refusal qualification

Two native cases passed at source commit `7564aaa90de2e5da61981c4123d1599172c25442`. Both used a fresh disposable cooperative account and the published synthetic Shield fixture. Preparation and independent reconstruction were genuine; RPC and POI responses came from explicit in-process fixture services. Production trust pins were unchanged.

| Case | Observed refusal | Local POI requests | Original Electron | Recorded child window |
| --- | --- | --- | --- | --- |
| Declined disclosure | Disclosure | 0 | PID 9198, natural exit 0 | 17.733 s |
| Unrelated history | Membership proof normalization | 2 | PID 9807, natural exit 0 | 18.308 s |

The selected still-unspent Shield input was 2000 synthetic WETH base units, with fee/self amounts of 100/1900. Each case observed 68 original utilities, six key request/reply pairs, one result per utility, the exact 91-hook guard vector with zero attempts, and intentional utility closure code 15 without escalation or peer disconnect. These are utility closures; the original Electron mains and Python launchers exited naturally with 0. Each operation observed exactly 15 canonical header requests.

The unrelated-history case accepted the fixture disclosure prompt, then rejected a captured proof for a different note during normalization. It stopped before the membership verifier. It did not authenticate a selected-note service signature. Neither case created a durable relay row, launched a relay signer, issued a signing loan, produced a proof or permitted a send. Before/after custody logical inspections matched; this is not a byte-invariance claim for the entire profile.

## Retained evidence

The two `*-report.json` files are byte-exact originals. `source-inputs.json` retains the common 11723-source inventory, 15 symlink records, 637 selected source pins, four runtime/input hashes (engine, Electron executable, Electron framework and public input), and 17 SQLite file pins once. These inventories are not execution coverage or a complete OS/dependency closure.

`provenance.json` preserves every original report, source freeze, request, RESULT, POST-CHECK, original process record and empty child log identity by byte size and SHA-256. Repeated source-freeze fields are deduplicated into the common file. Absolute repository and scratch prefixes are replaced with `$REPOSITORY` and `$SCRATCH` in metadata, including object keys. Derived projections use sorted-key compact UTF-8 JSON digests; they are not the original metadata bytes. The original prefixes are intentionally omitted, so this public package alone cannot reconstruct exact original metadata bytes. Report bytes are unchanged.

The root observed original prepare handles 31753/7392 and launcher handles 87499/47474 through natural exit 0. The derivative observation explicitly attributes those facts to root messages. The scoped independent outcome review checked reports, requests, freeze/inventory metadata, results and original Electron process records; it did not rerun native/crypto, rehash runtime payloads or inspect profiles. Publication packaging is separately reviewable. This is not an external security audit.

Source readiness used the historical 124-test/two-suite fixture success on unchanged bytes plus original lint/format evidence. The subsequent broad run had 11917 passes and nine loopback-sandbox failures; only the unchanged affected network suite was replayed, passing nine tests. Combined evidence records 11926 distinct passes and eight skipped tests across 288 passing suites and one skipped suite. It is not one all-green broad run. The launcher FREEZE referenced by the native source freezes binds that separate root-check evidence.

## Metadata verification and reproduction

From this archive directory, run ordinary Python:

```
python3 verify_archive.py
```

This verifies the index, exact report hashes, strict report contract, shared source joins, normalized freeze reconstruction and original process/result links. It does not verify native cryptography, rehash runtime inputs or read any profile. A changed report plus a rewritten index is not independent provenance; compare the package's reviewed publication pin as well.

The public input is reused from [the unsigned preparation archive](../railgun-unsigned-relay-preparation-2026-10-06/public-source.json), SHA-256 `bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41` (8466 bytes). No profile, key file or database is included here. The fixture uses deliberately public test-wallet material.

A diagnostic rerun requires the pinned source commit, installed macOS arm64 Electron/SQLite inputs and pinned engine archive. Supply a canonical absolute public-input path, a fresh absolute output outside the checkout and all inputs, engine archive, `enrolled`, prover archive location and artifact directory location to `scripts/qualify-railgun-wallet-journal.js`. Set exactly `FREEDOM_RAILGUN_RELAY_REFUSAL=declined-disclosure` or `unrelated-history`; remove other inherited FREEDOM and runtime injection flags. The prover/artifact locations are required CLI arguments but their payloads are unused and unqualified in these refusal branches.

Example argv, with each placeholder replaced by its own canonical absolute path:

```
FREEDOM_RAILGUN_RELAY_REFUSAL=declined-disclosure \
  /absolute/checkout/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  /absolute/checkout/scripts/qualify-railgun-wallet-journal.js \
  /absolute/checkout/docs/qualification/railgun-unsigned-relay-preparation-2026-10-06/public-source.json \
  /absolute/fresh-disposable-output \
  /absolute/railgun-engine.asar enrolled \
  /absolute/railgun-prover.asar /absolute/artifact-directory
```

Use a separate fresh output for the second case. This direct invocation does not automatically reproduce the archived external launcher checks or original-handle evidence. The reviewed launcher used a 1050-second original child wait plus bounded cleanup; parent pre/post hashing and validation are outside that wait bound. Fixture setup/cleanup retained its 900-second bound and the controller its original 180-second bound.

These runs do not qualify funded accounts, live RPC/POI services, real service authority, signing/proving/submission, live-child cancellation or OS-level network confinement. Quote fixture construction occurs outside guarded utilities. Runtime/source postchecks and explicit service seams constrain this campaign; they do not establish general production readiness.
