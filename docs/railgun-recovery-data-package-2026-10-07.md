# Shared Railgun recovery and result checks

Freedom consumes `@freedom/railgun-kohaku-adapter` 0.3.0 from the
[reviewed source](https://github.com/solardev-xyz/railgun-kohaku-adapter/commit/cbc34b2c5d2d346e4fde722741c3638f4dcd312c).
Five modules now re-export the shared destination, signature, preparation, result
and recovery-input helpers. Their algorithms and historical formats are unchanged;
only imports move. The root Kohaku factories, `/read` and bounded `/data` API stay
unchanged. The raw `/host/data` entry expects trusted host inputs.

The helpers retain fixed engine/prover build identities and the engine's
`freedomfixture` wallet-source label. Recovery paths are absolute trusted-host
execution inputs; structural normalization does not authenticate files or grant
execution authority. Freedom still owns key access, genuine capabilities, stores,
controllers, utility jobs, transport and submission. No host callbacks or runtime
permissions are added.

The five implementation files and two manifest files enter the wallet policy and
all shared qualification inventories. Manifest-byte parity joins the runtime
Freedom authenticates to the build identities the package checks. Adoption needs
a new wallet generation, without changing existing hold/capsule/journal formats.

The standalone package passes 557 tests in 15 suites and strict CJS/ESM declaration
checks. Claude independently reproduced those checks and found no algorithm,
type or authority defect. The retained Freedom tests also exercise the package
through the compatibility modules; a matcher mock now targets the package's actual
implementation. These are engineering checks, not an external security audit.

On clean adoption commit `b5d94998`, two native signing/proving cases passed
(transfer/full unshield and partial unshield), including cold signature reuse. A
third genuine-account synthetic case passed Shield-input foreign-recipient recovery,
receiver scanning and independent recipient withdrawal preparation. It did not
sign, prove or submit B's withdrawal. All three parent processes exited naturally
with code 0, with source/runtime/package inputs unchanged before and after. The
launcher retained explicit post-run snapshots for this campaign. These are synthetic
services and notes, not live or Tor evidence.

An unsigned macOS arm64 directory build also passed. The packaged executable
reproduced four golden vectors, 21 shared export references and both manifest
parity checks. All 33 shipped package files matched the 42-file npm artifact,
except electron-builder's removal of the package scripts field; README and eight
`.d.ts` files were omitted. Native proving and packaged loading were separate
checks, not a packaged end-to-end proof run. One initial packaged-consumer command
stopped on a wrong fixture filename; correcting that input produced the passing
run without changing the artifact.

The retained Freedom module/inventory checks passed 347 tests, followed by 55
final identity/source tests after documentation and manifest-parity updates. Claude
independently passed 736 tests across eleven affected suites. Lint passed. A broad
run was interrupted after npm's nested script swallowed its worker-limit flag; it
is not passing evidence. Full combined regression is recorded on the integration
baseline separately.

The stopped live recovery campaign is unchanged and no new live success is claimed.
