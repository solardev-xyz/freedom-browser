# Existing-only encrypted journal reader — October 5, 2026

Recovery diagnostics can now read an existing registered EOA submission journal
without constructing a writer, creating storage, registering files or adopting
state. The new internal `readExistingPrivateSubmissionSnapshot(handle)` returns
a detached, deeply frozen snapshot through the ordinary canonical decoder. No
host, controller, IPC or user-facing operation consumes it in this checkpoint.

The reader requires a genuine current public-address transaction context on
Sepolia, a matching active profile and an unlocked vault session. It rechecks
these before returning. Every component from the trusted profile root downward
must be a real directory or file; bounded descriptor reads check file identity,
size and timestamps before and after reading. Missing or malformed state refuses
without repair. Trusted ancestors, hostile concurrent filesystem writers and
rollback protection are outside this guarantee; filesystem access times can change.

Shared AES-GCM decoding now wipes the update, final and combined plaintext
buffers on success and failure. This also fixes the prior ordinary-reader case
where authentication failed after update had returned temporary plaintext.
Native crypto tests inspect those actual buffers. Immutable strings and private
OpenSSL allocations are outside the wiping claim.

The encrypted format, AAD, inventory and canonical journal schema are unchanged.
This shared infrastructure serves PPv2 and Railgun. The wallet/public/TXID source
policies exclude these infrastructure modules, so this change does not rotate
those policies. Earlier native reports that include changed files retain their
historical source scope; no preserved PPv2 or funded Railgun profile was opened.

## Validation and limits

The exact six-file candidate was tested against the merged main dependencies,
then imported after verifying its complete frozen package and current base bytes.
[The evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-existing-journal-reader-2026-10-05.json)
records source and result hashes.

- Broad regression: **16,899 passed, 33 skipped**, 571 passing and five skipped
  suites; 678.228 seconds, natural exit. OpenLV ran separately: six passed.
- Native binary availability changed during that scratch full run. A subsequent
  fixed-runtime Ant/Radicle supplement passed all seven tests. It is repeated
  coverage, not seven additional unique tests. The broad suite includes public
  Safe RPC/local-Anvil and real Ant disposable-identity integration.
- Six detached mutations fail at their intended assertions: unwanted creation,
  registration, weakened canonical decoding, omitted key wiping, followed
  metadata and retained bad-tag plaintext. Their baseline passes 25 tests.
- After exact import, all **198 reader/storage/journal tests** pass on the branch
  with natural exit (7.173 seconds), and full lint passes.

Claude and Codex reviewed source and final evidence. This is engineering review, not an
external security audit. Interrupted pre-refresh tests remain excluded diagnostics.
The successful regression does not establish dedicated Electron/native reader
qualification, live-service eligibility or recovery of a funded profile.

The snapshot authenticates registered local ciphertext and schema, not chain
finality, note ownership, current eligibility or spending permission. Next is a
restricted diagnostic joining this snapshot to an already-open genuine account,
followed by fresh disposable-profile qualification on Electron 44.5.1. Portable
Kohaku Host compatibility, live private operations, product design and release
qualification remain separate work.
