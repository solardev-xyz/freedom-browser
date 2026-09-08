// Single entry point for the Colibri package, so the runtime choice below is
// made exactly once and cannot be bypassed by a second `require` site.
//
// Colibri 2.0.5 added a native N-API addon (`prebuilds/<platform>-<arch>/
// colibri_native.node`) and a `node` conditional export that prefers it over
// the WASM build 2.0.4 shipped exclusively. Electron's main process matches
// that `node` condition, so the in-range 2.0.4 -> 2.0.6 bump silently swapped
// our verifier implementation for the addon — and the addon segfaults the
// process while verifying an `eth_call` proof (observed 2026-09-08 with
// 2.0.5/2.0.6 on Electron 43.0.0 and 43.6.0; upstream corpus-core/c4). The
// user-visible symptom is that typing an `.eth` name closes the browser.
//
// The crash is inside the addon's EVM execution during proof verification
// (`execute_rpc_ctx` -> `c4_verify` -> `verify_call_proof` -> `run_evm_call` ->
// `eth_run_call_evmone_with_events`), which hands an invalid pointer to the
// host allocator; the identical JS is clean on stock Node, so it is specific
// to the Electron binary rather than to our usage. `C4_DISABLE_NATIVE` is
// upstream's own opt-out: it makes `runtime_node.js` skip `dlopen` entirely
// and return the same WASM runtime 2.0.4 used, so the verifier we ship is
// unchanged from the last known-good version.
//
// Set unconditionally (an inherited `C4_DISABLE_NATIVE=0` must not re-arm the
// crash) and before the package is required, because upstream reads it when
// the runtime is first initialized. To re-test the addon after an upstream
// fix, drop this line rather than setting the variable from the environment.
process.env.C4_DISABLE_NATIVE = '1';

const Colibri = require('@corpus-core/colibri-stateless').default;
const { Strategy } = require('@corpus-core/colibri-stateless');

module.exports = { Colibri, Strategy };
