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

Native and packaged acceptance on the final adoption commit remains pending.
The stopped live recovery campaign is unchanged and no new live success is claimed.
