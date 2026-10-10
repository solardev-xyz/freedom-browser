# Controlled Kohaku PPv2 session

Date: 2026-09-26. Continues [adapter and process qualification](ppv2-adapter-process-2026-09-26.md). Main was fetched and remains `2983dc62`, already merged; no new dependency/node refresh was necessary. No application dependency, UI, renderer channel or production activation was added.

September 27 continuation: [native deposit proving and preparation](ppv2-controlled-deposit-2026-09-27.md) now passes through this session in source and packaged Electron. The read-only/proving-disabled description below records this earlier checkpoint; an explicit main-owned proving configuration now enables only the bounded native-deposit preparation method.

## Implemented boundary

`wallet/ppv2-session.js` assembles the real Kohaku candidate through main-owned capabilities. It accepts a reviewed local candidate factory, explicit Sepolia deployment and contract grants, pinned ASP key/artifact manifest, and separate endpoint grants. This is a main-only engineering entry point, not dynamic plugin installation or an IPC API. Candidate labels are compatibility checks, not a sandbox or cryptographic authentication of an arbitrary JavaScript function; the qualification script verifies the source/build inputs separately.

- The dedicated keystore permits only `m/28784'/2'/<accountIndex>'` for that account, active profile and vault lifetime. Public-wallet, Ant, PPv1 and other account paths are refused. The plugin receives that derivation key as required by Kohaku's host interface; it never receives the mnemonic. Temporary seed buffers are cleared. JavaScript private-key strings and SDK objects cannot be guaranteed to be erased from memory.
- A separate encrypted store uses a vault-derived, domain-separated key and binds profile/account/chain/deployment context. A protected compatibility record binds the provisional identity, SDK/adapter version, public owner, contract addresses, deployment block, ASP and artifacts. These bindings are checked inside the existing namespace: an incompatible change refuses to open instead of appearing to be a new empty wallet. The plugin can access only its own `ppv2:controlled:` namespace.
- RPC, ASP and relayer requests have distinct lifetime-bound contexts and isolation tokens. A single Kohaku HTTP interface dispatches to exactly one reviewed role capability. Overlapping routes, mixed accounts/lifetimes and unknown requests fail before dispatch; failures do not try another role. TLS/SOCKS tests cover distinct ASP/relayer tokens on the same origin and refusal of an ungranted submission route. Endpoint operators can still correlate application identifiers/timing; role separation does not establish query-content privacy.
- Each account has one active session; SDK operations are serialized. Close, vault lock, profile replacement or construction failure revokes its capabilities. Late results and writes are refused, and an account can reopen after unlock. Session close does not close another account's session.
- Exposed operations are instance identity, registration status, balance/notes reads and **preparation** of registration calldata. No signing, broadcaster, account import/export, phantom-note purge, shield, transfer or withdrawal API is exposed. Proving is explicitly refused in this session. Reads remain unverified, including their SDK-derived note status and spendability.

## Runtime incompatibilities fixed

The [scratch compatibility patch](../scripts/fixtures/kohaku-ppv2-compat.patch) still targets Kohaku PR #258 at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`, against the unchanged private SDK source at `fe0244e3f14110efd83db02c60c96517dea9cd5a`. Neither upstream checkout was edited or published.

1. **Log failures recursively retried.** The candidate bisected every failed log window, including a permission/lifetime/transport failure. Fixed 5,000-block windows now stop on the first error. There is no implicit rate-limit or oversized-response retry. A main-reviewed deployment block reaches the SDK builder and owner-recovery interactor. Warm-up/history scans use it; the SDK's note discovery retains its own persisted cursor and can start at genesis on a fresh account. No recent-head shortcut is introduced.
2. **Owner and derivation signer differ.** The SDK's rotation-discovery helper queries auth-policy events under `deriveConfig.signerAddress`, while Kohaku registers `params.ownerAddress`. The adapter now uses the SDK's public `KeystoreInteractor` to read full owner auth history and its cryptographic services to match candidate revocable keys, preserving the original signer in the KDF. This fixes the integration without changing the SDK or substituting the public wallet's signing key.
3. **Cached rotation indices became stale.** Owner recovery runs on every open, checking the persisted candidate plus indices 0–19. A rotation on another device can replace the cached index. An unknown index, absent owner auth history, or disappearance of a previously persisted registration refuses to open. Version and canonical u64 shape of the rotation record are validated. This is a bounded recovery range, not arbitrary-history key discovery; increasing it or resuming from explicit recovery metadata needs a reviewed policy. RPC auth history remains unverified, and reorg handling is still a release gate.
4. **Default manifest failed builder validation.** The SDK's exported manifest has unprefixed SHA-256 values, while its builder schema requires `0x`. The host adds the prefix only to exact 64-hex digests. Its artifact verifier explicitly strips the prefix before comparison, so the pinned bytes are unchanged. This was reproduced by constructing the real session, not just typechecking it.

## Evidence

`scripts/spike-ppv2-session.js` bundles and executes the real patched Kohaku factory against the pinned SDK. Only the public test mnemonic, synthetic contract responses and temporary encrypted state are used. The transport and vault are controlled substitutes in this Node probe; this does not establish live Sepolia or Electron session integration. Ambient Node network tripwires record zero attempts, but are diagnostic guards rather than an OS sandbox.

The probe verifies independent viem/scure BIP32 agreement with Freedom's signer, two prepared registration calls, empty-note synchronization, encrypted cursor restoration, distinct RPC/ASP/relayer contexts, bounded log windows without failure retry, rejection of a late read after vault lock, and reopening after unlock. It recovers owner rotation 7 on a fresh registration record, then rotation 8 with a stale cached index. It rejects an unknown rotation, malformed rotation metadata, and a disappeared registration. The owner deliberately differs from the derivation signer. The relayer dispatch is a separate capability probe; no SDK relayer operation was prepared or submitted.

Validation:

- Full application regression: **5,574 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork integration case). Optional scratch-fixture tests account for differences from earlier run counts.
- Final focused host/provider/storage/lifetime tests: **38 passed, 2 skipped**. Current SDK RPC/status fixtures were enabled; two unrelated optional upstream HTTP-client fixtures were absent.
- Whole patched adapter strict typecheck passes. The qualification script also reran four independent derivation cases and the real separate-process synthetic deposit proof successfully.
- Real factory/session probe passes, including the recovery cases above. Lint and whitespace checks pass.

Machine-readable evidence: [qualification report](qualification/ppv2-controlled-session-2026-09-26.json). Logs: `/private/tmp/freedom-ppv2-session-{sdk,focused,regression,lint}-sep26.log` and `/private/tmp/freedom-ppv2-controlled-sep26.log`. This slice does not repeat the earlier packaged prover tests; the new session itself has not yet been qualified in packaged Electron.

Reproduce with the earlier pinned checkouts and installed isolated SDK dependencies:

```sh
node scripts/spike-kohaku-ppv2-sdk.js /absolute/kohaku /absolute/ppv2 --compat
node scripts/spike-ppv2-session.js /absolute/generated-compat-directory /absolute/ppv2
```

## Next implementation slice

Connect the previously qualified utility-process prover to this session's SDK proof-service interface, starting with deposit and verified local artifacts. Validate prepared registration/deposit transactions against the wallet's reviewed sender/chain/target/intent boundary. Exercise that assembled path in Electron before a live Sepolia registration/shield attempt.

Then add a durable **relayer operation** journal before submission: operation identity, uncertain handoff, restart observation and explicit reconciliation. The existing public signed-transaction journal does not cover private relayer requests. Transfer/unshield circuits, authenticated deployment/ASP/artifact matching, real notes and reorg/restore recovery must pass before exposing these methods.

Upstream's provisional `APP_IDENTIFIER`, final security-audit/deployment matching, transitive distribution terms and the unverified-state policy remain production gates. No live endpoint, funded account or transaction was used here. UI/UX decisions can still wait.
