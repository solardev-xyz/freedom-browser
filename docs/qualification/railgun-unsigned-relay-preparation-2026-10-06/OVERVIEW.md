# Genuine account unsigned relay preparation — native evidence

At source commit `67612a750cfd7b9ab85e0eaf85cb2e475f48a4db`, a disposable enrolled account selected a note containing 700 synthetic WETH base units, verified a fresh signed public-test quote, and constructed unsigned outputs containing a 100-unit broadcaster fee and 600 units returned to itself. A second fresh viewing-only utility reconstructed both outputs from the serialized draft. The original quote, construction and reconstruction utilities each returned one accepted result and closed with exit code 15, without escalation or disconnect. The outer Electron process and root-observed launcher both exited with code 0; source, runtime and SQLite postchecks were unchanged.

The preparation probe observed 1, 50 and 33 broker messages across those three jobs, two viewing-key transfers, two read-only restores and ten mock canonical-header requests. It checked three pre-admission refusals, three competing admissions, the exact serialized draft handoff, invalidation of the old view, immediate handoff reuse, unchanged owned-note data and generations, and specified protected encrypted files. Each utility reported the exact 91 guard hooks and canaries with zero attempts. These observations do not establish an OS sandbox or account for all process and filesystem activity.

The draft remains unsigned and unpersisted. There is no spend-signing, proving, POI-disclosure, relay-sending, funded-wallet, live-service, gas-estimate or operator-trust qualification. Synthetic quote signing and address construction occurred in fixture main, outside the guarded jobs. Protected-file comparison covers named encrypted areas, not the whole browser profile. This run did not qualify live-child cancellation. The surrounding enrolled qualifier also performs historical synthetic checks; the new report section's deltas describe only this preparation probe.

Attempt A remains a separate failure: its original Electron process and launcher exited with code 1 naturally, and postchecks were unchanged. Its original metadata and terminal log excerpt retain the diagnosis available at that time. A later reviewed fix maps each job's local storage IDs into the shared snapshot's increasing sequence and translates replies back. Attempt B passed with unchanged report expectations.

`report.json` and `failed-attempt-a.json` preserve exact original bytes. `provenance.json` maps original hashes to normalized metadata and the log excerpt. `source-hashes.json` publishes 164 reviewed path hashes, including the 160 selected in the report. The complete inventory of 11,646 source files and 15 symlinks is pinned but omitted; an inventory is not execution coverage. The root freeze records the engine archive, Electron executable and framework, public synthetic input and 17 SQLite files. This exporter verified the public input but did not reopen the engine, Electron or SQLite payloads or any profile tree.

`public-source.json` is the exact 8,466-byte public synthetic input used by both attempts, SHA256 `bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41`. It contains synthetic events, ciphertexts and public identifiers, without wallet keys or a mnemonic. The checked-in `scripts/fixtures/railgun-wallet-source.js` generator's `vault-weth-vector` case supplies its public test-vector basis.

A diagnostic rerun of the checked-in fixture can use this input. Check out the source commit above, install its pinned dependencies, and supply matching engine, Electron and SQLite inputs from the provenance record. With other `FREEDOM_RAILGUN_*` flags and Node/Electron injection overrides unset, invoke:

```sh
FREEDOM_RAILGUN_UNSIGNED_RELAY_PREPARATION=1 \
  /absolute/path/to/Electron \
  /absolute/checkout/scripts/qualify-railgun-wallet-journal.js \
  /absolute/path/to/public-source.json \
  /absolute/path/to/fresh-output \
  /absolute/path/to/railgun-engine.asar enrolled
```

Every argument path is absolute. The output directory must not exist and should be outside the checkout and separate from all input paths. The fixture creates a disposable profile there; use the synthetic input supplied here. A direct invocation does **not** automatically reproduce the archived launcher's source/runtime/SQLite checks or original-process evidence. Matching those requires the separately reviewed external launcher, which is not included as an executable payload.

The runtime and dependency payloads remain absent. The report also omits the plaintext quote and encrypted unsigned draft, so its digests cannot independently replay the original reconstruction. A diagnostic rerun generates a fresh quote and draft. Root observed the original executions; review and publication inspect evidence without rerunning cryptography.
