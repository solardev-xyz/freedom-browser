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
// and return the WASM runtime — the same *implementation* 2.0.4 shipped
// exclusively, but not the same *build*: `c4w.wasm` changed across the bump
// (2.0.4 sha256 `32eb265c…`, 1118419 bytes; 2.0.6 `7bd999c2…`, 1130756 bytes;
// `strings` shows consensus types such as `GloasLightClientUpdate` only in the
// 2.0.6 build, so upstream code changed in there). So this restores the
// pre-2.0.5 runtime *choice*, not the last known-good verifier bytes — a
// verification discrepancy after a bump still has to be re-validated against
// the WASM path (`ENS_COLIBRI_E2E=1 npx jest
// src/main/__tests__/integration/colibri-e2e.test.js`) rather than assumed
// unchanged.
//
// Set unconditionally (an inherited `C4_DISABLE_NATIVE=0` must not re-arm the
// crash) and before the package is required, because upstream reads it when
// the runtime is first initialized. The recovering runtime provider installed
// further down builds the WASM runtime directly and so never consults this
// variable; it stays as the opt-out for any path that still reaches upstream's
// own `runtime_node.js` selection. Re-testing the addon after an upstream fix
// therefore means replacing that provider too, not just dropping this line.
process.env.C4_DISABLE_NATIVE = '1';

// A WASM trap must stay a catchable `WebAssembly.RuntimeError` (#453).
//
// V8 normally catches out-of-bounds WASM memory accesses with guard pages and a
// SIGSEGV handler (the "trap handler") instead of compiling explicit bounds
// checks. In Electron's full main process that SIGSEGV is never turned back
// into a trap, so an out-of-bounds access in any WASM module kills the whole
// browser. The same access is a plain `RuntimeError` under stock Node and
// under `ELECTRON_RUN_AS_NODE=1`, which is why probes outside the app never
// saw the crash. (Observed 2026-09-30 on Electron 44.4.5, linux-x64: a
// minimal module whose one function does an out-of-bounds `i32.load`
// segfaults the main process, and throws a catchable `RuntimeError` once this
// flag is set. gdb put the fault on a store inside JIT-compiled code.)
//
// Colibri's WASM verifier does hit that trap on real inputs: as of 3.0.0,
// `eth_getTransactionReceipt` / `eth_getTransactionByHash` for a hash the
// prover's chain has not seen (a just-broadcast transaction, or anything on a
// local fork) ends in "memory access out of bounds". In the app that was a
// main-process SIGSEGV on the first receipt poll after a send. (Still so in
// 3.0.2, re-checked 2026-10-19 against the mainnet prover, after 4-10 s of
// verifier CPU; since #750 the chain-data router asks Colibri only about
// transactions an RPC already reports as mined.)
//
// `--wasm-enforce-bounds-checks` makes V8 compile explicit checks even though a
// trap handler is available, so the trap is thrown as a `RuntimeError` and the
// chain-data router falls through to the next source. It is read when a module
// is compiled, and `c4w.wasm` is compiled lazily on the first Colibri call, so
// setting it here (before the package is even required) covers every Colibri
// instance in this process. Since #495 that process-side code runs in worker
// threads — the chain-data/ENS worker (`colibri-worker.js`) and the
// checkpoint-verifier worker — and V8 flags are process-wide, so whichever
// worker loads this first sets it for both. (Re-checked 2026-10-04 on Electron
// 44: an unknown-hash receipt through the Colibri worker throws the catchable
// "memory access out of bounds" error and the app keeps running.)
require('node:v8').setFlagsFromString('--wasm-enforce-bounds-checks');

const path = require('node:path');
const Colibri = require('@corpus-core/colibri-stateless').default;
const { Strategy, decode_proof } = require('@corpus-core/colibri-stateless');

// A trap leaves the Emscripten instance unusable: its C stack pointer, heap and
// in-flight contexts are wherever the trap interrupted them, and in practice
// every later call on it traps too — even `eth_blockNumber` (reproduced with
// 3.0.0 against the Gnosis prover). The package keeps one module-level WASM
// instance per process, so without intervention one unknown receipt would
// silently disable Colibri until restart.
//
// The package only exports `getRuntime()`, not the provider hook behind it, so
// reach `runtime.js` and `runtime_wasm.js` by file path next to the resolved
// entry point (`package.json#exports` gates bare subpath specifiers, not
// absolute paths). `runtime.js` is the same module instance the package itself
// uses; `setRuntimeProvider()` drops its cached runtime, so the next
// `getRuntime()` builds a fresh one from the provider below. Requests already
// running keep the runtime object they captured, so their context handles are
// never replayed against the new instance. That retired object refuses every
// further call (see `guardRuntime`), so those requests fail and fall through
// rather than finishing verification on an instance known to have trapped.
// `colibri-runtime.test.js` pins all of these internals against the installed
// package, so a bump that moves them fails CI instead of losing recovery.
const PACKAGE_CJS_DIR = path.dirname(require.resolve('@corpus-core/colibri-stateless'));
const upstreamRuntime = require(path.join(PACKAGE_CJS_DIR, 'runtime.js'));
// Both hold module-level caches (the runtime object and the Emscripten
// instance); evaluating them again yields a fresh, unpoisoned instance.
const FRESH_WASM_MODULES = ['runtime_wasm.js', 'wasm.js'].map((file) =>
  path.join(PACKAGE_CJS_DIR, file)
);

let registeredStorage = null;
let runtimeResets = 0;
let onRuntimeReset = null;
// guarded runtime -> marks it retired. Weak, so a dropped instance is not kept.
const retiredRuntimes = new WeakMap();

function loadFreshWasmRuntime() {
  for (const file of FRESH_WASM_MODULES) delete require.cache[file];
  // Dropping the cache entries is not enough to let a retired instance go:
  // Node also appends every module this file requires to `module.children`,
  // and that list is never pruned. Each retired `runtime_wasm.js` (and, via its
  // own children, `wasm.js` with the Emscripten instance, its
  // `WebAssembly.Memory` and the 1.3 MB `c4w.wasm` buffer) would stay reachable
  // forever — ~1.7 MB per reset, and a page can trigger resets at will through
  // read-only `eth_getTransactionReceipt` calls for unknown hashes. Only the
  // copy about to be replaced is in the list at this point; the live runtime
  // is held by upstream's cache, not by this list.
  module.children = module.children.filter((child) => !FRESH_WASM_MODULES.includes(child.id));
  return require(FRESH_WASM_MODULES[0]).getWasmRuntime();
}

function resetPoisonedRuntime(runtime, err) {
  // Runs only for the first trap on an instance: retiring it here makes every
  // later call on it (a request still draining there) refuse before it can
  // trap again, so a stale instance can never swap out its replacement. The
  // trapping instance is therefore always the live one: the only call made on
  // a fresh instance before `provideRuntime` hands it out is `registerStorage`,
  // a plain JS assignment that cannot trap.
  retiredRuntimes.get(runtime)?.();
  runtimeResets += 1;
  upstreamRuntime.setRuntimeProvider(provideRuntime);
  try {
    onRuntimeReset?.(err);
  } catch {
    // Logging must never mask the trap being rethrown to the caller.
  }
}

// A failed remote proof is a failure, never a local proof (#1059; F-9 of
// freedom-core's design 0014). Freedom runs Colibri in remote-prover mode: the
// configured prover builds each proof and this process only verifies it. But
// when that first prover request fails (an HTTP error, every prover down),
// 3.0.3's RPC context proves the read itself instead
// (`rpc_handle_remote_proof`, `src/api/colibri_common.c:504-511`; `c4w.wasm`
// links the prover). Its prover asks the package's built-in public beacon API
// and RPC hosts, which the user never configured, for the read's account and
// block data, and the proving runs in Colibri's worker. The answer is still
// verified; what changes is who learns what the user reads, and where the work
// runs.
//
// The package has no setting for this: both prover modes that ask a remote
// prover (`remote`, `proxy`) fall back, and the other modes prove locally from
// the start. Refusing whole server types on the fetch side would break honest
// reads: the verifier's own requests use the same types (the light-client sync
// on `beacon_api`, a contract call's code and storage reads on `eth_rpc`), and
// a local prover's request can look like one of those.
//
// So the stop sits on the one transition into the fallback. A context that
// starts with a remote proof (a proofable method in a remote mode, as the C
// core decides with the same `getMethodType`) returns exactly that prover
// request from its first execute. Once the host sets an error on it, the next
// execute is where the C core would create the local prover; instead the
// context ends with the remote error, and no prover is ever created. Every
// other request passes through untouched, including the prover requests the
// verifier makes itself (a contract call's proof, a transaction lookup's
// cache), whose failures the verifier handles on its own.
const PROVER_MODE_REMOTE = 1; // C4_PROVER_MODE_REMOTE (colibri_common.h)
const PROVER_MODE_PROXY = 3; // C4_PROVER_MODE_PROXY
const METHOD_PROOFABLE = 1; // MethodType.PROOFABLE (types.js)
const NO_LOCAL_PROVING_ERROR = 'remote proof failed (no local proving)';

function refuseLocalProving(runtime) {
  // context -> its remote proof: the request's pointer once the first execute
  // has returned it, and whether the host answered it or failed it.
  const remoteProofs = new Map();
  // request pointer -> the same record, for the host's set calls.
  const byRequest = new Map();
  const forget = (ctx) => {
    const proof = remoteProofs.get(ctx);
    if (!proof) return;
    remoteProofs.delete(ctx);
    if (proof.reqPtr !== undefined) byRequest.delete(proof.reqPtr);
  };
  return {
    ...runtime,
    createRpcCtx(method, paramsJson, chainId, proverFlags, verifyFlags, proverMode) {
      const ctx = runtime.createRpcCtx(method, paramsJson, chainId, proverFlags, verifyFlags, proverMode);
      if (
        ctx &&
        (proverMode === PROVER_MODE_REMOTE || proverMode === PROVER_MODE_PROXY) &&
        runtime.getMethodType(chainId, method, paramsJson, verifyFlags) === METHOD_PROOFABLE
      ) {
        forget(ctx);
        remoteProofs.set(ctx, { reqPtr: undefined, answered: false, error: undefined });
      }
      return ctx;
    },
    executeRpcCtx(ctx) {
      const proof = remoteProofs.get(ctx);
      if (proof?.error !== undefined) {
        return { status: 'error', error: `${NO_LOCAL_PROVING_ERROR}: ${proof.error}` };
      }
      // Answered: the proof is the verifier's from here on.
      if (proof?.answered) forget(ctx);
      const state = runtime.executeRpcCtx(ctx);
      if (proof && proof.reqPtr === undefined) {
        const requests = state?.status === 'pending' && Array.isArray(state.requests) ? state.requests : [];
        if (requests.length === 1 && requests[0]?.type === 'prover') {
          proof.reqPtr = requests[0].req_ptr;
          byRequest.set(proof.reqPtr, proof);
        } else {
          forget(ctx);
        }
      }
      return state;
    },
    reqSetResponse(req, data, nodeIndex) {
      const proof = byRequest.get(req?.req_ptr);
      if (proof) proof.answered = true;
      return runtime.reqSetResponse(req, data, nodeIndex);
    },
    reqSetError(req, error, nodeIndex) {
      const proof = byRequest.get(req?.req_ptr);
      if (proof) proof.error = String(error);
      return runtime.reqSetError(req, error, nodeIndex);
    },
    freeRpcCtx(ctx) {
      forget(ctx);
      return runtime.freeRpcCtx(ctx);
    },
  };
}

// Route every call into the WASM instance through one place so a trap from any
// of them (execute, free, create, decode...) retires the instance, and so a
// retired instance can refuse work. A trap can leave the heap, the C stack
// pointer and other contexts' state half-written, so nothing may keep running
// on it — not even a request that captured it before the trap and would
// otherwise carry on creating and executing contexts there. Its `free*` calls
// become no-ops instead of errors: they run from upstream's `finally` blocks,
// where throwing would replace the request's real error, and the whole
// instance is about to be dropped anyway.
function guardRuntime(runtime) {
  const guarded = {};
  let retired = false;
  retiredRuntimes.set(guarded, () => {
    retired = true;
  });
  for (const [name, value] of Object.entries(runtime)) {
    if (typeof value !== 'function') {
      guarded[name] = value;
      continue;
    }
    guarded[name] = (...args) => {
      if (retired) {
        if (name.startsWith('free')) return undefined;
        throw new Error(`Colibri WASM runtime was retired after a trap; refusing ${name}()`);
      }
      if (name === 'registerStorage') registeredStorage = args[0];
      try {
        return value.apply(runtime, args);
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) resetPoisonedRuntime(guarded, err);
        throw err;
      }
    };
  }
  return guarded;
}

async function provideRuntime() {
  const runtime = guardRuntime(refuseLocalProving(await loadFreshWasmRuntime()));
  // Storage lives on the Emscripten instance, so a replacement starts on the
  // package's default (cwd-backed) adapter. Re-attach whatever the host
  // registered last — Colibri's disk store in the chain-data/ENS worker, the
  // in-memory map in the checkpoint worker — before anyone can use the new
  // instance. (The chain-data host retires a worker after its first trap
  // anyway; this keeps requests still draining there on real storage.)
  if (registeredStorage) runtime.registerStorage(registeredStorage);
  return runtime;
}

upstreamRuntime.setRuntimeProvider(provideRuntime);
// Provers route legacy and v3 proof formats using the encoded client version.
// Manual proof requests must advertise the installed verifier's version, too.
// Upstream packs that number as three single-byte fields
// (major << 16 | minor << 8 | patch): the installed build's own
// `_c4w_get_current_version_number()` returns 196611 for 3.0.3 (verified
// 2026-10-30 by calling that export on the shipped `c4w.wasm`; 3.0.2 gave
// 196610), which is what the encoding below produces. A version outside that shape — a pre-release
// tag, a part >= 256, a 2- or 4-part version — has no representation here, and
// guessing one would hand the prover a wrong but plausible integer that passes
// the worker's `Number.isSafeInteger` guard. Refuse instead: `null` fails that
// guard closed (`CHECKPOINT_INCOMPATIBLE`), so such a bump has to re-derive the
// encoding from the WASM export above rather than silently misroute proofs.
const versionParts = /^(\d+)\.(\d+)\.(\d+)$/
  .exec(require('@corpus-core/colibri-stateless/package.json').version)
  ?.slice(1)
  .map(Number);
const clientVersion =
  versionParts && versionParts.every((part) => part <= 255)
    ? versionParts.reduce((version, part) => version * 256 + part, 0)
    : null;

module.exports = {
  Colibri,
  Strategy,
  decode_proof,
  clientVersion,
  // Called with the RuntimeError whenever a trap retires the WASM instance.
  setRuntimeResetListener(listener) {
    onRuntimeReset = listener;
  },
  runtimeResetCount: () => runtimeResets,
  // Exported for its tests; every runtime this module provides already has it.
  refuseLocalProving,
  NO_LOCAL_PROVING_ERROR,
};
