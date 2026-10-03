# Isolated Railgun engine qualification fixture

The maintainer approved engine 9.6.0 and its locked dependency closure on October 2, 2026. This fixture is development tooling. It is outside the application's dependency graph and packaging inputs; it does not downgrade Freedom's ethers dependency or activate a Railgun wallet.

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/fixtures/railgun-engine
node scripts/qualify-railgun-engine.js /absolute/path/to/new-output-directory
```

Use the committed lockfile. Do not run lifecycle scripts: nine installed packages declare them. The published engine tarball was independently checked against its pinned SHA-512 integrity before installation. `runtime-integrity.json` authenticates the installed dependency files before each synthetic job imports the engine. A separate clean `npm ci --ignore-scripts` reproduced the same file inventory on this Mac. This is not cross-platform or production packaging qualification.

The inventory excludes npm's `.package-lock.json` bookkeeping and `.bin` executable links, which the job does not invoke. It includes packaged native binaries and WASM. Disabling lifecycle scripts does not mean native code cannot execute when imported. JavaScript egress tripwires are not an OS sandbox.

The dependency closure has unresolved registry advisories and mixed licenses, including GPL-3.0 and LGPL-3.0. See [the dependency inventory](../../../docs/qualification/railgun-engine-dependencies-2026-10-02.json) and [qualification report](../../../docs/railgun-engine-qualification-2026-10-02.md). An MIT engine license alone does not clear that closure for distribution. The fixture uses only public test keys, refuses artifacts/signing and uses synthetic host RPC responses.

For the host-owned storage/shared-session continuation, run `node scripts/qualify-railgun-session.js /absolute/path/to/another-new-output-directory`. It runs four actual-engine children, including lock and SQLite failure while RPC is pending, and requires observed forced exit before success. See [the session report](../../../docs/railgun-session-qualification-2026-10-02.md) for limits and pending review.
