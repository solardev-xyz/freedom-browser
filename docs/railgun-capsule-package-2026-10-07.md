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

Native utility-process acceptance and packaged-app loading are pending on the
final adoption baseline. The live recovery campaign remains consumed and stopped;
this package work does not claim a successful private transfer or unshield.

## Remaining extraction

This is the first data slice of E2a: historical capsules, their structural offer
and intent rules, and exact digest compatibility. Authenticated recovery/POI data
and their compatibility contracts remain in Freedom. E2b still requires an
independent execution host covering process lifetime, keys, durable stores,
transport and recovery. The standalone package is not yet a self-contained wallet
SDK, and UI/UX remains separate.
