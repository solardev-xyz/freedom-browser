# Documentation

Freedom's README is the short project overview. Use these guides for detailed setup, behavior, and maintenance information.

## For users and site authors

- [Features](features.md) — browser capabilities, protocols, settings, and built-in pages.
- [Configuration](configuration.md) — managed nodes, external endpoints, profiles, and Ethereum RPC configuration.
- [Troubleshooting](troubleshooting.md) — common node, naming, and content-loading problems.
- [Swarm content retrieval](protocols/swarm.md) — `bzz://` behavior and site migration guidance.
- [IPFS and IPNS content retrieval](protocols/ipfs.md) — native schemes, canonicalization, gateways, and site migration guidance.
- [Contract-hosted applications](protocols/onchain-apps.md) — `web3://` ERC-8244 apps, their chain-scoped origins, and the sandbox they run in.
- [Radicle provider API](radicle-provider-api.md) — the `window.radicle` API exposed to decentralized applications.

## For contributors and maintainers

- [Contributing](../CONTRIBUTING.md) — contribution policy and pull request workflow.
- [Development](development.md) — local setup, scripts, tests, debugging, and builds.
- [Wallet privacy recovery and SDK follow-up](privacy-engineering-followup-2026-09-25.md) — current main/node synchronization, durable submission tracking and current Kohaku host transport.
- [Wallet privacy engineering status](privacy-engineering-status.md) — tested behavior, qualification evidence, remaining technical work and product boundaries.
- [Wallet privacy implementation plan](wallet-privacy-implementation-plan.md) — staged wallet transport, Kohaku, and PPv2 work with acceptance criteria.
- [Native IPFS desktop integration](freedom-ipfs-native-desktop.md) — native addon architecture and packaging.
- [Electron security audit](security-audit-electron.md) — threat model, the IPC sender policy and other hardening, and open security items.
- [Agent playbooks](agent-playbooks/README.md) — detailed maintenance and release procedures.
