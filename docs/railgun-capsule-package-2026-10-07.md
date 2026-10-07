# Portable historical Railgun capsule data

Package `@freedom/railgun-kohaku-adapter` 0.2.0 adds an independent historical
capsule reader to the existing adapter facade. Its public source is commit
`22d9265e8d7acf6b9234eb544c6df341b6501fc9` in
[railgun-kohaku-adapter](https://github.com/solardev-xyz/railgun-kohaku-adapter).
It is not published to npm. The committed tarball and lock integrity are recorded
in [the vendor manifest](../vendor/railgun-kohaku-adapter/README.md).

## Boundary

`/data` exposes bounded plain-data normalization, the original domain-separated
digest, and a frozen compatibility descriptor. It refuses hostile object behavior
without executing getters or proxy traps, and returns fixed errors without raw
account-linked data. Static public-dummy vectors preserve the exact original
canonical bytes and digests for self transfer, foreign transfer, full unshield and
partial unshield. Engine identity is recorded provenance, not execution authority.
The reader retains the narrow Sepolia deployment and 0.01 ETH qualification cap;
it is not a general Railgun parser or protocol-wide amount limit.

`/host/data` shares the same extracted structural implementation with Freedom's
internal callers. It preserves their raw assertion contracts and expects trusted
host inputs; it must not expose those exceptions to users or reports. Freedom's
policy and intent modules re-export it. Capsule creation retains current engine
binding in Freedom, and preparation retains owned-note and recipient checks.
No signature, proof, key release, storage, RPC, POI or network authority moves into
the package. No renderer or IPC responsibility changes.

The package source comes from committed Freedom `c208245f`; only import paths and
the separation of historical data checks from new-operation/ownership checks
change the extracted core. The root five adapter factories and four `/read`
helpers are unchanged. All old capsule digest domains and field interpretation
remain intact. A new wallet-policy generation is required because the source
closure now includes the installed package files. This is not a storage migration
or permission to reinterpret an existing reservation or recovery record.

## Checks

The package passes 353 tests in ten suites, including all four golden records,
maximum ABI sizes, hostile input and fixed-error cases, shared implementation
identity, and provenance hashes. TypeScript 5.9.3 passes eight positive consumers,
eleven negative programs and the separately labeled existing Kohaku bridge.
CJS/ESM declaration parity is root 32, read 9, data 9 and host/data 10 names.

An independent Node consumer installed the packed package with only its ethers
peer and reproduced all four golden digests through CJS and ESM, without importing
Freedom. ethers 6.17.0 is both the peer minimum and Freedom's installed version;
no broader peer-version matrix is claimed. A clean committed-source pack is
byte-identical. The publication audit found no private paths, profile data or
credentials. Claude's independent read-only review reproduced all package tests,
type checks and source/golden equivalence; this is engineering review, not an
external security audit.

Freedom pins the installed host entry, four moved core modules, package exports
and deployment pins in its wallet policy and qualification inventories. The tests
walk parent-relative imports, check one physical copy in Node's cache and match
the vendored tarball against the installed bytes. Historical evidence files retain
their original source scope; future cooperative qualification configs must include
the installed package closure.

Native acceptance ran on clean adoption commit `668e97ed` with the pinned Electron,
engine, prover and artifacts. Transfer/full-unshield and partial-unshield cases
both exited naturally with code 0. Real SDK signing, proving, independent checking
and cold reconstruction reused the original signatures through the installed
package. Both reports pinned all five newly installed host/core files; protected
inputs were unchanged afterwards. These were synthetic cases with zero account,
network, POI or submission calls.

An unsigned macOS arm64 directory build completed with Freedom's actual after-pack
hook and prebuilt dependencies (`npmRebuild=false`). All package runtime files were
present exactly once and byte-identical inside `app.asar`. Electron-builder shipped
26 of the 35 npm files, omitting the README and eight `.d.ts` files; it removed only
the `scripts` field from package metadata. The actual packaged Electron executable
loaded the adapters, confirmed five shared function identities and reproduced all
four golden vectors without opening a wallet or making a network request. This
qualifies packaged loading, not signing, notarization or a release.

Freedom validation records remain separate: an initial constrained run had missing
fixture/loopback failures; after installing the pinned fixture, the broad run passed
417 suites (15,251 tests), with one package-byte assertion failing on stale local
README/declaration files. Their bytes were restored from an independently installed
final tarball, then all 12 package/inventory tests passed. The runtime bytes had
already matched. Claude independently passed 671 tests across ten affected suites;
lint and binary checks passed. The failed broad runs are not described as one green
run.

The live recovery campaign remains consumed and stopped. This package work does
not claim a successful live private transfer or unshield.

## Remaining extraction

This is the first data slice of E2a: historical capsules, their structural offer
and intent rules, and exact digest compatibility. Authenticated recovery/POI data
and their compatibility contracts remain in Freedom. E2b still requires an
independent execution host covering process lifetime, keys, durable stores,
transport and recovery. The standalone package is not yet a self-contained wallet
SDK, and UI/UX remains separate.
