# PPv2 live verifier compatibility — October 2

The accepted `eacc32476b2fc3be0344e1c9b341a9964e405f59703604385b29307350bcca7a` runtime generated genuine synthetic proofs for deposit, ragequit and transact_1x1. The pinned Sepolia verifiers accepted each valid proof and rejected both an altered public signal and cross-circuit proof points: **9/9 checks through Sentio and 9/9 through PublicNode**, both over dedicated bundled Arti transport. This establishes functional compatibility for these cases, not verification-key source identity or an audit.

The harness first authenticates the local runtime and proves locally. The deployment preflight must report `observationsConsistent: true`, including the reviewed contract/proxy and verifier address/code pins, before any verifier calls. Exit-purpose preflight omits ASP eligibility and relayer quotes, which these pure verifier calls do not require. No owner wallet, vault, spending key or funded profile is opened; no transaction is signed or submitted.

Each run re-reads the three verifier bytecodes and checks their pinned hashes at an EIP-1898 `{ blockHash, requireCanonical: true }` reference. All nine `eth_call` checks use that same reference with no fallback. Each result must be the canonical ABI encoding of the expected Boolean; errors, reverts, timeouts and malformed results cannot count as rejected-proof passes. The wider deployment preflight uses block numbers with a final canonical-hash recheck; only the subsequent verifier code and calls are explicitly bound by block hash.

| RPC source | Finalized anchor                                                                  | Result                                                          |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Sentio     | `0xb47011` / `0x4f11f90837ca0731f415875900c8fee1b4c5612ab48de7045962e2c936e0ec38` | 9/9 passed                                                      |
| Tenderly   | No anchor obtained                                                                | Initial chain/finalized-anchor read failed; zero verifier calls |
| PublicNode | `0xb47031` / `0x39d9aedb28ffeb8f0cc04129acaff052b9835901700ec4d4da5b799adf5b796d` | 9/9 passed                                                      |

These were three separately selected invocations, not automatic provider fallback. The two successful sources agreed on verifier addresses and bytecode hashes at different finalized anchors; this is not a same-block comparison. Tenderly's precise transport/provider failure was not established. Its failure remains in the evidence rather than being counted as a negative proof control.

All remote observations remain **unverified RPC data**. Provider agreement does not prove chain correctness. Arti binary identity and transport setup are recorded, but circuit isolation was not independently measured by these runs. No ASP/relayer availability, historic-log completeness, transaction unlinkability or spending readiness is established. A static comparison of the pinned verification-key constants with deployed bytecode remains open, as do final upstream audit/deployment, distribution and platform gates.

Reproduce with an authenticated current archive and a fresh absolute output directory:

```sh
./node_modules/.bin/electron scripts/qualify-ppv2-circuits.js \
  /absolute/path/to/ppv2.asar /absolute/path/to/fresh-output sentio
```

The optional RPC argument is restricted to the live harness's fixed allowlist; use a separate output directory for another source. [Machine-readable evidence](qualification/ppv2-live-verifiers-2026-10-02.json) includes exact source hashes, deployment checks, sanitized request metadata, proof-job measurements and the unsuccessful attempt. It contains no proof witnesses or wallet secrets. Claude reviewed the harness before execution; this is engineering review, not external security approval.
