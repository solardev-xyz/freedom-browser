# PPv2 larger-circuit resource probe

The pinned SDK can prove a synthetic **one-input/two-output private transfer** and a **two-input/one-output withdrawal** within the existing process budget on this 14-core darwin-arm64 machine. This is an offline circuit probe, not an enabled wallet operation or a complete private-payment integration.

The first witness splits 10,000 units into 4,000 units of change and 6,000 for a different synthetic recipient, with zero public withdrawal. The second combines two 5,000-unit inputs into a 6,000-unit public withdrawal and 4,000 units of change. Both use the same asset and label. Every public signal is compared with the expected nullifiers, output commitments, state/keystore/ASP roots, amount, asset and context. Both proofs verify, and changing the public amount makes verification return false.

The job authenticates the accepted `a7327fce…` runtime before loading code. Its external WASM, proving-key and verification-key bytes must match the circuit manifest embedded in that authenticated SDK. The runner checks the source checkout revision against the runtime candidate and records both script hashes and all six artifact hashes/sizes. These additional artifacts are not in the accepted application archive; no loader, production operation policy or runtime pin changed.

| Circuit        | Proving time | Sampled working-set peak |
| -------------- | ------------ | ------------------------ |
| `transact_1x2` | 4.459 s      | 587.6 MiB                |
| `transact_2x1` | 5.709 s      | 620.8 MiB                |

The reported peak uses the existing process host's 100 ms samples plus the result-time sample. It includes in-process cryptographic verification, whose implementation can create workers. The caps remain 256 MiB V8 heap, 768 MiB RSS and 120 seconds. These are soft sampled memory limits, and the result does not establish the same resource bound on other hardware/core counts. Electron 44.4.5 embeds Node 24.21.0 here. The source fixture runs in the existing managed utility process; this does not qualify packaged execution of these new circuit artifacts.

Reproduce with the pinned SDK checkout and its Git LFS files hydrated:

```sh
./node_modules/.bin/electron scripts/qualify-ppv2-multi-circuits.js \
  /absolute/path/to/accepted/ppv2.asar \
  /absolute/path/to/pinned/ppv2-checkout \
  /absolute/path/to/new-output-directory
```

The output directory must not already exist. Only public synthetic witnesses are used; the script creates isolated Electron data and performs no chain reads, signing or broadcast. The existing process host installs network-denial hooks, but this probe does not measure all possible egress and is not an OS sandbox.

[Machine-readable evidence](qualification/ppv2-multi-circuit-probe-2026-10-02.json) records the final provenance-bearing run. An earlier run without those provenance fields also passed. Claude reviewed the witness construction, signal ordering, artifact checks and resource interpretation; its provenance and wording corrections are incorporated.

Before wallet integration: include the additional artifacts in a reproducible authenticated runtime, extend exact selected-input/output and recipient binding, reserve every input durably, qualify quote/fee behavior, preserve all uncertainty and restart semantics, and test recipient discovery/recovery. Private payment and note-combination exposure must also be described in the eventual operation review. No public API advertises these operations yet.
