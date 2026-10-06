# Local relay interruption, recovery and Transact-input matrix

Six Electron mains ran at source `e5ab48c4` from one isolated copy and one frozen pre-run identity. The copy's only production delta is the explicit public test-list literal used in the [local completion campaign](../railgun-relay-local-completion-2026-10-06/README.md).

Each case gets a fresh disposable account from the public fixture mnemonic. Each cold case reopens only the account its own first main created, after that main and its driver have exited naturally with zero.

The six reports are byte-exact fixture outputs. `provenance.json` is derived and path-free.

## Signed stop, then original-signature resume

**First main (Shield input, 2,000 synthetic WETH units; fee 100, self 1,900).** The genuine controller signs, verifies the signature independently, produces both proofs and runs the independent dual verifier. After production observes the verifier's exit, the fixture holds that result and aborts its own request signal before the proof is persisted. The outcome:

- `recovery-required`, with the signature saved;
- a signed record and its signing-local ledger entry, recovery sequence +3, no proof.

Two probes check that the input stays owned:

- **While the result is held:** a second admission with the same option shape is refused before any owned-note read, utility start or key loan.
- **After the stop:** a private reservation of the same input is refused with `RAILGUN_PRIVATE_INPUT_RESERVED`, with no store change.

**Second main.** It resumes the record through the completed-account route: proof A in the completed snapshot, then the independent verifier. No signer, quote or POI work runs.

- Only the state and the proof slot change. The signature and every immutable field are unchanged, and the ledger entry is byte-identical.
- The recovery sequence moves 3 to 4.

## Transact input and its ready-record cold verify

**First main.** It selects a 700-unit Transact output (fee 100, self 600). That output comes from the published public source with one unrelated `Nullified` log inserted before the block-30 `Transact` in the same transaction. Logs keep their original transaction and log indexes.

Setup and staging:

- A keyless row utility builds the public TXID row.
- The genuine TXID owner creates and advances its checkpoint through the genuine public-service module over the synthetic transport.
- Staging runs with its own disclosure consent and authenticates the creator source and note witness. The operation then requires a separate exact-root consent.

Ordering checks:

- Staging service queries occur only after staging consent.
- Root queries occur only after root consent and after the membership POI queries.

The operation reaches ready-local custody (recovery +4). Four audit utilities accept the unmodified record and reject the signature, transaction-proof and pre-transaction-POI mutations through actual primitive failures.

**Second main.** It verifies the unchanged ready Transact record with the independent verifier only. The authenticated pair is unchanged; the recovery sequence is 4 to 4.

## Signing-reply cancellation, then discard

**First main.** When the relay-sign key reply is observed, the fixture aborts its own request signal before any signature exists.

- Only that signer closes through cancellation: cause `PRIVACY_CONTEXT_REVOKED`, exit 15, no escalation, disconnection or result. Every other utility keeps the exact closure contract.
- The outcome is `recovery-required` with no signature saved. The held and signing-local custody remains, and the same input stays unavailable.

**Second main.**

- Resume is refused before any utility or signer starts.
- Discard writes the discarded-signed tombstone before the ledger release, as observed through the custody matcher.
- The input becomes available only afterwards.

## Provenance and limits

The compact runner:

- owns each Electron main and records its exit; a separate outer process records the driver's natural exit;
- freezes, before any run, the whole-copy inventory with directories and links, the mount identity, runtime binaries/archives and exact artifact membership;
- freezes the installed lockfile identity and the dependency resolution;
- uses r5's resolvers verbatim over statically derived import edges, inventories resolved packages together with r5's declared package roots, and keeps r5's required absences, coverage and SQLite checks;
- requires the pre-run identity to equal the frozen one, and the post-run identity to equal it again;
- passes every report through r5's `cache_inventory`, so each main-cache module equals a pinned copy or package file;
- passes every report through a scenario validator, guarded by 53 refusal controls, that binds each cold report to its first run's report, RESULT and driver observation.

Main-cache rows observe CommonJS modules at publication only; utility imports are not covered.

The evidence comes from earlier runs:

- Development runs and the published [signed-stop pair b](../railgun-relay-signed-recovery-2026-10-06/README.md) used a weaker runner.
- Three Transact discovery attempts exposed fixture expectations, not production defects; they are preserved locally.
- An earlier final campaign (final-a) qualified five cases. Its sixth, the signing discard, was refused only by a stale validator key expectation, which was then corrected.

All of this happens in a synthetic trust domain:

- a public test list, synthetic RPC/POI/TXID services and a simulated chain;
- no live service, relay transport, send or OS network confinement;
- lease and floor writes are permitted;
- abrupt crash and native unknown exit remain unqualified.

The two stops are controlled request aborts. No profile, key, witness, signature or proof payload is exported.
