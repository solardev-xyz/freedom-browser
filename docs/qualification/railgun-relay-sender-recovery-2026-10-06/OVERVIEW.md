# Sender-only recovery of retained fee and self outputs

At source commit `e5b4b1f95f1f802878a38c5c308152374fc46c4b`, the actual pinned engine recovered both outputs of the existing public fixture using the sender viewing key alone: fee first 100 and self second 900 WETH base units. The job did not use the fee recipient private key. This establishes the public-fixture recovery prerequisite for a future two-output capsule; it does not implement or qualify a persistent capsule or genuine enrolled-account recovery.

[report.json](report.json) is the exact 73,419-byte original report, SHA256 `32ddec45418ba2a1c034db8a9cbe8ecd7d44603816efa330512174eccb53756f`. [provenance.json](provenance.json) is a derived record with original hashes, explicit path normalization and process/check attribution; [INDEX.json](INDEX.json) identifies exact versus derived bytes. The existing [retained public-case](../railgun-relay-proof-wire-2026-10-06/public-case.json), SHA256 `3b415653aa2a797af98c41f7f56bb60b3dd877cca6bd0f47904633876aad3b38`, is referenced rather than copied again.

## What ran

The [fixed public job](../../../scripts/fixtures/railgun-relay-sender-recovery-job.js) used the published sender fixture viewing key 08 with actual engine `getSharedSymmetricKey(senderKey, blindedReceiverViewingKey)` and sent-note decryption. It checked expected receiver master/viewing identity, amounts, WETH token identity, original note/sender randomness, output type, wallet source, absent memo, recomputed note commitment and both blinded keys. Original ciphertext and full transaction calldata remained unchanged. Sender public-key derivation was compared between actual engine and Node implementations. No spending key or fee recipient private key was used.

All six rows ran inside one guarded utility job:

- Fee and self sender recovery accepted.
- Ciphertext mutation refused at the pinned AES decrypt wrapper, with the original decrypt-stage error observed.
- Sender-random annotation mutation and expected-recipient substitution decrypted the original GCM payload, then failed the exact receiver-viewing-key equality assertion. Annotation itself is not independently authenticated.
- The actual empty-unblind fallback failed the strict identity guard; this is a separate guard control, not a corrupted-ciphertext recovery claim.

The r2 refusal envelope excludes unrelated startup, pre-decrypt and post-decrypt errors; its source-only mock controls remain separate from this native result. The report does not independently attribute an exact cryptographic backend failure cause.

Root observed original preparation 8247 exit 0 and launcher 85991 exit 0. The original Electron PID 97498 exited naturally with code 0 without timeout, interruption, termination or kill. The utility reported its original logical closure 15 without escalation/disconnection, with 91 guard hooks/canaries and 0 attempted forbidden operations. These logical guards do not establish an OS egress sandbox or physical drainage of unrelated processes. The original child log was empty, and its hash is retained. Report presence alone was not accepted as process success.

The launcher checked unchanged inputs before and after: 11,629 repository source entries, 15 source links and 3 runtime files (engine ASAR, Electron executable and Electron Framework). The report contains 562 selected source hashes. Inventory is not execution coverage. No SQLite account-storage input, existing profile, prover or proof artifact was required.

## Validation and limits

Root completed 58 tests across 2 suites in 0.254 seconds, strict lint and five-file formatting. An earlier command referenced nonexistent `public-data.test.js` and failed; that log is retained separately and is not counted as the corrected final test success. The source and launcher received independent review; actual outcome review attribution is recorded in provenance. Reviewers checked source/metadata/hash joins, while root alone observed the original processes. Publication performs metadata checks only and reruns no cryptography.

This run produced or reverified no proof and contacted no RPC, relay or broadcaster. It grants no signing, spending or disclosure authority, and proves no broadcaster acceptance or fee-recipient decryptability. The next implementation step is unsigned, unpersisted preparation for a genuine account, followed by independent reconstruction from the serialized preparation data. Durable capsule storage and route/reservation joins come later.

## Repeating the narrow check

Use the exact committed [entry](../../../scripts/qualify-railgun-relay-sender-recovery.js), its pinned engine 9.6.0 archive and compatible installed Electron 44.5.1. The archive hash is `019f10880abf1c448aee02ec77c5c2d68c3561c7b4eef02095d66bb5fecd6a7a`; complete runtime/version hashes are in provenance/report. The config file itself must have a canonical absolute filename. Its JSON has exactly `archive` and `publicCase`, both canonical absolute file paths. Point `publicCase` at the existing artifact above. The output path must be absolute, fresh and absent, outside the checkout and disjoint from every input; it must not be an ancestor of an input. Replace these absolute placeholders with the intended locations:

```
node_modules/.bin/electron scripts/qualify-railgun-relay-sender-recovery.js /absolute/path/config.json /absolute/fresh-output
```

A qualifying replay also needs the reviewed external original-process ownership, source/runtime freeze and before/after checks; the command alone does not recreate that evidence. The local launcher package and full inventory remain retained by the author but are omitted from this compact archive. This is inspectable evidence with a committed entry, not a standalone runnable dependency bundle. No recipient key or profile is needed; do not substitute a funded account.
