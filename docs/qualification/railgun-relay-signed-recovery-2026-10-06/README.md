# Signed relay stop and original-signature cold resume

Two Electron mains ran at source `73d025d8`. Each ran from an isolated copy whose only production delta is the explicit public test-list literal used in the [local completion campaign](../railgun-relay-local-completion-2026-10-06/README.md). Both reports are byte-exact fixture outputs. `provenance.json` is derived and path-free.

## First main: signed stop

A fresh disposable cooperative account, created from the public fixture mnemonic, selects one synthetic 2,000-unit WETH Shield input: fee 100, self 1,900. The genuine controller:

- signs, then independently verifies the signature;
- produces both proofs (A);
- runs the independent dual verifier (C).

The fixture holds C's genuine result after production has observed C's exit. It then aborts its own request signal before the proof is persisted.

The controller returns `recovery-required` at stage `proof`, with the signature saved. Two probes check that the input stays owned:

- **While the result is held:** a second controller admission with the same option shape is refused before any owned-note read, utility start or key loan.
- **After the stop:** a private reservation of the same input is refused with `RAILGUN_PRIVATE_INPUT_RESERVED`, and neither store changes.

Durable custody is a signed record with its signing-local ledger entry. The recovery sequence advances by 3 and no proof is stored. The run used 75 utilities, nine key loans and 34 synthetic operation RPC requests.

This is a controlled request abort after independent verification. It is not a crash, network interruption or unknown exit.

## Second main: signed cold resume

The second main starts after the first main and its driver have exited naturally with zero. It reopens only that disposable account and resumes the signed record through the completed-account route:

- proof A runs inside the completed snapshot, then C;
- no relay signer or signature verifier runs, and no quote or POI query is made.

The original signature and every immutable record field are unchanged; only the state and the proof slot advance. The ledger entry is byte-identical, and the authenticated recovery sequence moves from 3 to 4. The run used seven utilities, four wiped key loans and 49 synthetic RPC requests, the same requests as the ready-record cold resume.

This is the first native evidence for the original-signature cold route corrected at `a7a5cff8`.

## Development runs and limits

Development pair a at `5fedcfce` also qualified. Pair b adds the ownership-reason probes and pins the counts that pair a observed.

All of this happens in a synthetic trust domain:

- a public test list, synthetic RPC/POI services and a simulated chain;
- no live service, transport, send or OS network confinement;
- lease and floor writes are permitted;
- abrupt-crash and unknown-exit recovery remain unqualified.

**Provenance.** A compact runner owns each Electron main and records its exit; a separate outer process records the driver's natural exit. The runner pins before and after:

- the isolated source inventory and case sources;
- runtime binaries, archives and artifacts;
- the installed-lockfile identity.

It does not reproduce the earlier launcher's dependency-resolution freeze or report validators. Main cache rows inside the reports observe CommonJS modules at publication only. No profile, key, witness, signature or proof payload is exported.
