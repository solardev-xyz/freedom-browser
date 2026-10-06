# Retained public proof and quote replay — 6 October 2026

A fresh verifier at commit `71e7c27f758f0d9665cedc6f34a3a3f29b8dd3ce` cryptographically rechecked the previously retained public transaction/pre-POI proofs and the original signed broadcaster quote. It used the public files already preserved in the [composition archive](../railgun-relay-proof-wire-2026-10-06/OVERVIEW.md), without invoking the producer, deriving a private key, contacting a service or loading a wallet profile.

The [exact report](report.json) records both proofs accepted, 13 changed public-signal cases refused, the original quote signature verified with Noble and Node, and the fixed public recipient/fee commitment joined to calldata. The synthetic fee calculation remains estimate 84 → buffered gas 100, price 1, token rate 10¹⁸ → fee 100. Both utility jobs recorded 91 guard canaries and zero guarded attempts, then closed with code 15 without escalation. The original Electron parent exited naturally with code 0; the external preparation and launch processes also returned 0. Root alone observed those original processes. The [derived provenance](provenance.json) records source/runtime immutability and distinguishes observation from independent metadata review. An external Codex reviewer checked the report, recorded digests, 542 selected source hashes and process/metadata joins, without rerunning cryptography or rehashing native runtime payloads. The 542-entry source inventory is not execution coverage.

Historical evaluation is explicitly `feeExpiration − 240000`; it proves neither the original wall clock nor present quote eligibility. This replay establishes no encrypted-transcript replay, broadcaster ability to decrypt fee ciphertext, unique quote-to-calldata commitment, actual service acceptance, operator trust, network broadcast, finality or production authority. Synthetic input/list history and public test keys remain explicit. Guard observations do not establish an OS egress sandbox or physical draining of unrelated work.

Before the actual replay, review found a variable-shadowing defect in the external runner's input validation. The original frozen draft was preserved; a three-line correction kept file pins separate from the expectations object. A full-path synthetic positive, digest/expiry refusals and an exact old-source failure control distinguish the fix. That source-only control mocked external digest identities and subprocess output; it did not count as this cryptographic replay. The first draft of that control also failed on a test assertion serializing sets, then passed after using sorted lists. Root focused validation of the committed verifier passed 51 tests in two suites, strict lint and formatting; no fresh full regression is claimed.

## Rechecking the retained files

Use the committed [Electron entry](../../../scripts/qualify-railgun-relay-retained.js), [fixed public basis](../../../scripts/fixtures/railgun-relay-retained-basis.json) and [input pins](../../../scripts/fixtures/railgun-relay-retained-inputs.json). Start from the source commit above and existing matching dependencies, engine/prover archives and circuit artifacts. This is an offline qualification recipe, not a self-contained dependency installer. It installs/downloads nothing. The wire build must match manifest `2bf6fa947e89bcaeef4ff94ffdc22cac8acbc3ed66a8055cf464f02d60ee8d97`; the extracted gas bundle must match `ef5341080f287067f4c3e1ef76e0ba1a3a257a4c7a650e720f16104c1feac74f`. The [wire recipe](../railgun-relay-wire-recipe-2026-10-06/OVERVIEW.md) and [composition provenance](../railgun-relay-proof-wire-2026-10-06/PROVENANCE.json) describe their source basis. These exact local artifacts are prerequisites; this archive does not supply the gas build or full external launcher.

Write a locations-only JSON file with these seven absolute paths, substituting existing matching local files. The last two point to the already published public inputs; their hashes must remain `3b415653aa2a797af98c41f7f56bb60b3dd877cca6bd0f47904633876aad3b38` and `48293cc1fa869217dc9138417ca116e9351386d6c03c5c0ab3bb6dfca9412a85` respectively.

```json
{
  "archive": "/absolute/artifacts/railgun-engine.asar",
  "proverArchive": "/absolute/artifacts/railgun-prover.asar",
  "artifactDirectory": "/absolute/artifacts/circuits",
  "wireBuild": "/absolute/artifacts/reviewed-wire-build",
  "gasBundle": "/absolute/artifacts/selected-gas.cjs",
  "publicCase": "/absolute/checkout/docs/qualification/railgun-relay-proof-wire-2026-10-06/public-case.json",
  "signedQuote": "/absolute/checkout/docs/qualification/railgun-relay-proof-wire-2026-10-06/signed-quote.json"
}
```

Run the installed, matching Electron executable in browser mode, with `ELECTRON_RUN_AS_NODE` unset and inherited Node injection options removed. Use a fresh output directory outside the checkout and artifact/input locations:

```sh
node_modules/.bin/electron scripts/qualify-railgun-relay-retained.js /absolute/locations.json /absolute/fresh-replay-output
```

For equivalent process provenance, independently freeze and recheck source/runtime/build/artifact inputs, retain the original parent exit and both job closure records, and validate the complete report. The retained external launcher did this for this run; merely seeing an output JSON file is insufficient. A new run's times, RSS and report digest may differ. Preserve failed output and stderr rather than interpreting absent evidence as success.

The next planned boundary is review of account-bound operation handling. This public-only qualification does not authorize a funded run or confer retry, release or submission authority.
