# Restricted Railgun Node prototype with public Shield — October 6, 2026

The standalone prototype now includes the public Shield adapter and submitter alongside the snapshot and private-operation adapters. It also includes the reviewed Promise-observation correction in both transaction adapters. An independent Node application can consume these five factories through its own trusted host. This remains an unpublished, restricted prototype; Freedom's fixed hosts and wallet authority are not bundled.

The implementation checkpoint is `deb3439481f9922f1bba44c164ac9467a4caac48`. The [audit archive](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-public-node-prototype-2026-10-06/README.md) represents all 29 final artifact files once, alongside build, runtime, compiler and final-package evidence. Runtime, wrappers, declarations, manifest and licenses are exact; five source/recipe derivatives have explicitly mapped path normalization. An exact runnable local copy is retained at `tmp/privacy-build/railgun-kohaku-node-public-prototype-oct6`. The [earlier three-factory prototype](railgun-kohaku-node-prototype-2026-10-06.md) is retained unchanged with its historical source scope.

## API and authority

The package exports:

- `createRailgunKohakuSnapshotPlugin`
- `createRailgunKohakuPrivateAdapter`
- `createRailgunKohakuPrivateAdapterBroadcaster`
- `createRailgunKohakuPublicAdapter`
- `createRailgunKohakuPublicAdapterSubmitter`

CommonJS and ESM entrypoints forward to one canonical runtime. Their factory identities and public/private operation registries are shared within that physical package. Different physical copies must use distinct hosts; tokens from another copy, copied objects, cross-kind tokens and replays are refused.

The [public adapter](railgun-kohaku-public-adapter-2026-10-06.md) retains the original acknowledged result or rejected submission error. It does not turn public failures into the private adapter's fulfilled uncertainty union. Its acknowledged value is bound to the admitted gross amount. Both transaction adapters consume one-use authority before delegation and retain observable admitted work through closure. An unobservable malformed Promise causes terminal closure failure, not a successful drainage claim.

The artifact contains no Freedom engine, prover, account owners, storage, RPC client or fixed host. An application's host remains responsible for ownership, keys, proofs, asset and selected-input policy, recipient authorization, disclosure review and durable spending/recovery state. The portable adapters validate data and lifecycle contracts; host-shaped objects and readable notes do not establish authority. Trusted callbacks are not sandboxed.

The contracts retain the restricted Sepolia chain and transaction-RPC result shape. Public preparation accepts native amounts up to 10^16 wei; Freedom's fixed host implements the native ETH-to-WETH, self-recipient lane. Private amounts retain the existing 10^16 base-unit ceiling. A foreign host must enforce its own asset and full selected-input restrictions. These are integration limits, not Railgun protocol limits. A `direct` broadcast-source field does not establish that transport bypassed Tor.

## Verification

| Layer                      | Completed evidence                                                                                              | Scope                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Runtime build              | Two identical builds; 21 artifact files, 63 parsed inputs, 21 emitted contributors and 82 recorded build inputs | Pinned Node 24.18.1 / Darwin arm64 / esbuild 0.28.2 toolchain                       |
| Runtime consumers          | CJS 45, ESM 45 and mixed 47 case executions; three deliberate forbidden-work controls fail                      | Exact emitted runtime, before the final typed manifest                              |
| Portable declarations      | Three positive and eleven negative NodeNext programs; four distinguishing controls                              | Actual bare-package CJS/ESM resolution and restricted consumer contracts            |
| Actual Kohaku source graph | One positive program using nine pinned upstream blobs                                                           | Three specialized PluginInstance targets and the private result-bearing Broadcaster |
| Final typed package        | Independent 29-file reconstruction; three fresh bare-package CJS/ESM/mixed smokes                               | Actual final manifest, declarations, runtime and entrypoints together               |

The runtime is 66,999 bytes, SHA-256 `364ab05b3344de30d3058804c9e71088d12f2a2ad4d7326e0f0a946e43f251fc`. Runtime tests cover amount/result binding, original public rejection identity, copied and cross-kind tokens, retained callbacks, malformed constructor/species boundaries, cleanup failure and mixed-entrypoint authority. Sticky instrumentation records selected network/process/native-addon/repository-import attempts, including attempts swallowed by application code. Its three negative controls fail as intended; healthy consumers record no forbidden entries. This is JavaScript instrumentation, not an OS sandbox.

Final smokes use the actual package manifest and all five exports. They cover snapshot reads, private transfer/full/partial flows with independent hosts, public reads/preparation/submission, token refusal and original public uncertainty. Mixed mode verifies canonical factory identity and both public/private cross-entrypoint operations. All three original commands naturally exit 0; all 29 files remain unchanged. The earlier 137 runtime executions and compiler checks are not relabeled as fresh final-package runs.

Strict TypeScript 6.0.3 uses noEmit and skipLibCheck false. These are declaration-consumer checks; checkJs is false. The actual-upstream check is separately pinned to Kohaku `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`, not an upstream lockfile build. Generic Host/factory compatibility is unsupported. Typed token spreads and arbitrarily widened upstream methods retain runtime restrictions. One deliberately misrouted ESM type entry still compiles; the explicit resolution-graph check detects it.

The independent final verifier reconstructs the canonical declarations and conditional manifest from their source contracts. It explicitly rejects optimized Python. The historical type-assembly recipe lacks that guard and was run with ordinary Python; reproduce it using ordinary Python without attributing the later guard to the earlier run. Runtime build reports describe the earlier runtime-only manifest; the final inventory records the typed manifest separately.

The archive includes the complete 82-input build report. The artifact itself contains selected source/provenance records and complete included license texts, rather than every compiler or build input. Freedom MPL-2.0 sources and declarations, emitted ethers/Noble MIT contributors, and retained parsed-only/build-tool notices are identified. Original bytes and path-normalized audit copies are explicitly distinguished.

## Remaining work

The reusable recovery companion is next. Broader chains/assets/recipients, independent host implementations, supported-platform and release packaging, generic upstream Host support, live private-service eligibility and live private spending remain separate gates. The controlled native wallet campaigns and standalone trusted-host tests have different scopes. Neither is an external security audit, a mainnet release, or a user-facing wallet experience; UI/product design remains a joint phase.
