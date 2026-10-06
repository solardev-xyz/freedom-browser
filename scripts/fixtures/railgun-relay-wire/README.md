# Offline relay-wire recipe

This repository recipe replays the reviewed 39-case public-vector experiment using existing local source checkouts and dependency trees. It does not install dependencies, contact services, open profiles, initialize a full wallet/server, or grant relay authority. Generated third-party source/bundles remain local outputs. Nothing in `src/main` imports this fixture.

Copy `roots.example.json` to a local configuration and replace every placeholder with an absolute path to existing matching inputs. The five source revisions and exact selected files are pinned in `inputs.json`; revision labels are provenance, while file hashes are enforced. `engineDependencies` and `buildTools` must be real `node_modules` directories retaining their existing Node resolution layout. Roots select locations only: hashes, policy, vectors, case definitions and tool versions cannot be overridden there. No ancestor/global fallback is supported. Only the reviewed darwin-arm64 builder bytes are admitted; another platform needs a reviewed pin update. Node 24 is required; the run records the actual version/executable hash and produces separate evidence on a different runtime.

From the repository root:

```sh
node scripts/qualify-railgun-relay-wire.js prepare --roots /absolute/local-roots.json --output /absolute/fresh-build
node scripts/qualify-railgun-relay-wire.js check --build /absolute/fresh-build --build-sha256 REVIEWED_MANIFEST_SHA256
node scripts/qualify-railgun-relay-wire.js run --build /absolute/fresh-build --build-sha256 REVIEWED_MANIFEST_SHA256 --output /absolute/fresh-run
```

`prepare` prints the new manifest SHA256 after verifying source, dependency and tool bytes, extracting exact declarations, checking free bindings/source-default configuration and building the selected bundle. It never imports that bundle. Review the preparation/source before authorizing `run`; `check` and `run` require the manifest digest obtained through that independent trusted step. A digest supplied alongside an untrusted rewritten manifest is not authority. CLI flags prevent accidental execution; they are not an OS sandbox or an approval system.

The input verifier pins the selected dependency graph and its package-resolution metadata, plus complete sorted file-tree digests for the 18 tool packages and the actual builder executable. Tool-tree digest encoding is compact JSON over lexicographically sorted `[relativePath,byteLength,sha256]` rows; paths are ASCII package entries in the current pins. Added tool files and altered package.json files refuse. Before any tool load, scoped/package paths must be canonical and ancestor node_modules shadow candidates (including @babel/node_modules) must be absent. Complete pinned package trees cover internal resolution directories. After awaited build completion, all source/tool/license inputs, resolved aliases and the pre-build recipe snapshot are checked again before build.json is written. A failed recheck may leave diagnostic output files, but never a completion manifest. Runtime graph membership describes exactly the selected build inputs, not every unused installed package file or execution coverage. An unexpected resolved graph entry or emitted network import refuses. The emitted graph still includes inactive original browser AES fallback helpers. Every resolved input is recorded using a named root plus relative path; physical local roots appear only in the local build manifest.

Both commands require fresh output directories and never overwrite or delete previous evidence. Failed preparations can leave partial output for diagnosis. Build output cannot overlap a configured input tree, and run output cannot overlap its build. The generated source and bundle are pinned by the reviewed build manifest; source/tool/input checks repeat before bundle import and after the campaign. Recipe files and the CLI are also bound to the manifest. This is a local reviewed-build contract, not cryptographic signing or remote artifact attestation.

The campaign body preserves the reviewed r3 cases and source-derived counters: 16 signature attempts, 13 semantic attempts, six encryptions, five emitted offline envelopes and two accepted response comparisons. Fresh ephemeral keys and IVs remain random, so report/ciphertext hashes change between executions. The CJS port explicitly retains strict mode, including frozen metadata mutation refusals. No actual crypto is performed merely by requiring these fixture modules.

Quote tickets trust only two independently Node-derived public test keys. Low-order raw-verifier outcomes are diagnostic; signatures alone do not qualify arbitrary peers. All-chains signatures do not bind external topics, and local operation IDs are not echoed peer authentication. Dummy calldata does not prove fee token/amount/master-key/quote commitments. GCM wrapper comparisons share Node AES; ECDH uses Noble on both sides. A decrypted hash does not establish broadcast or finality. No automatic retry, hold release, owned-note disclosure or production relay integration follows.

`licenses.json` records exact existing package declarations and original license-file hashes. No upstream implementation payload is committed here. Generated bundles should not be redistributed without including their applicable original license/notice material. No missing license text is invented.

Unit verification:

```sh
npm test -- -- --runInBand scripts/fixtures/railgun-relay-wire
npm run lint -- --max-warnings 0
```

Policy/envelope cases use fake structural values and no crypto. Marker tests exercise ordering separately from the real runtime: they label their mocked verification seam and never substitute marker success for actual crypto results. Repository recipe source and build-only validation are separate from the historical offline campaign; rerunning actual crypto requires its own recorded result.

The r2 guard controls use marker-only tool packages and the actual verifier source with small structural pins. Held-build controls evaluate the actual completion block after a synthetic awaited build; they do not claim an esbuild or crypto execution. Removing the ancestor-shadow guard permits a marker import, and removing completion rechecks permits a changed input to publish a manifest. Actual source builds and crypto qualification must be recorded separately for each reviewed recipe revision.
