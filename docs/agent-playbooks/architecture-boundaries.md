# Architecture Boundaries Playbook

Use this playbook when a task can affect module ownership, service boundaries, or top-level package layout.

## Required Checks

1. Read the architecture sections in `README.md` before editing.
2. Confirm the task can be completed without changing top-level boundaries.
3. If boundary changes seem necessary, stop and ask for explicit approval.

## Safe Change Pattern

- Prefer extending existing modules over moving responsibilities between packages.
- Keep renderer and main-process responsibilities separated as currently defined.
- Avoid introducing new cross-layer dependencies unless approved.

## PR/Commit Notes

When architecture-adjacent changes are made, include:

- Why the chosen location fits current responsibilities.
- Why alternatives were not used (one short sentence is enough).

## Swarm node (Ant) compatibility contract — DO NOT rename

The bundled Swarm node is `antd` (**Ant**), a drop-in that speaks the **Bee HTTP
API**. The UI, tooling, manager (`src/main/ant-manager.js`), binary dir
(`ant-bin/antd`), data dir (`ant-data`), and config file (`config/ant.yaml`) all
use the **Ant** name. But a load-bearing core stays **bee**-shaped because it is
the wire/identity contract that `@ethersphere/bee-js` and the node depend on.
Renaming anything below breaks protocol or identity compatibility — leave it.

**Ring 0 — protocol/wire contract (never rename):**

- HTTP endpoints and request/response shapes: `/bzz`, `/stamps`, `/status`,
  `/chainstate`, `/wallet`, `/chequebook/*`, `/health`. Default API port `1633`;
  `GET /health` must return `200` + JSON. If a node already answers `/health` on
  `1633`, Freedom reuses it instead of spawning its own.
- The `@ethersphere/bee-js@^13` dependency (the client library Ant answers).
  Internal wrappers (e.g. `fetchAntJson`) are renamed; the package is not. The
  major shown here tracks `package.json` (guarded by
  `architecture-boundaries.test.js`) — it records which client major currently
  speaks the contract, not a pin: bumping bee-js is allowed, swapping the
  package out is not.
- Bee **YAML config keys**: `api-addr`, `cors-allowed-origins`,
  `blockchain-rpc-endpoint`, `swap-enable`, `mainnet`, `full-node`, `data-dir`,
  `password`, … Ant's parser expects these. The config *file name* changed
  (`config/ant.yaml`); the *keys* cannot.
- On-disk identity contract: `keys/swarm.key` (Web3 v3 keystore), the Swarm
  data-dir layout Ant reads, and the BIP-44 derivation `BEE_WALLET` at
  `m/44'/60'/0'/0/1` (`src/main/identity/derivation.js`). The node identity is
  derived from the vault mnemonic and re-injected as `keys/swarm.key` on every
  start, so the data dir holds only disposable cache.
- The word "Swarm" where it names the **network/protocol** (accurate regardless
  of which node implementation runs).

**Kept `bee`-named identifiers (deny-list):** these wrap the Ring 0 identity
contract above; renaming them risks breaking key injection / node startup, so
they intentionally stay `bee`-named. Mostly in `src/main/identity/*` and
`src/main/identity-manager.js`:

- `injectBeeKey`, `injectBeeIdentity`, `createBeeConfig`, `getBeeAddress`
- `BEE_WALLET` (derivation path label)
- `removeStaleBeeDirs`, `wipeStaleBeeState`, `setBeeLifecycle`,
  `isBeeIdentityInjected`, `setUseInjectedIdentity`

Rule of thumb: if a symbol/string names *the node software or its UI*, it's
**Ant**; if it names *the Swarm network* or *the bee wire/identity contract*, it
stays as-is.
