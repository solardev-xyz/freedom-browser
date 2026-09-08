# Freedom Browser

[![CI](https://github.com/solardev-xyz/freedom-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/solardev-xyz/freedom-browser/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20|%20Linux%20|%20Windows-lightgrey)](https://freedom.baby)

Freedom is a browser for the decentralized web, with Swarm, IPFS, onchain applications, Radicle, ENS, and Tezos Domains as first-class protocols. Integrated Ant, freedom-ipfs, Radicle, experimental Myotis, and Tor components provide direct access to decentralized and onion networks without relying on centralized HTTP gateways.

## Download

Download the latest build for macOS, Linux, or Windows from the official download page at [freedom.baby](https://freedom.baby).

Radicle is available on macOS, Linux, and Windows (x64 and ARM64). Tor is available on macOS and Linux only: the Windows build ships without the bundled Tor (Arti) client, so `.onion` access is unavailable there.

## What Freedom supports

- Native `bzz://`, `ipfs://`, `ipns://`, `web3://`, and `rad://` navigation, plus optional `.onion` routing through Tor.
- Contract-hosted applications (draft ERC-8244) loaded straight from an Ethereum-compatible chain, with no HTTP gateway.
- Integrated Ant (Swarm), freedom-ipfs, Radicle, experimental Myotis, and Tor components with per-profile configuration.
- ENS, WNS, GNS, and Tezos Domains resolution, including `.eth`, `.box`, `.wei`, `.gwei`, and `.tez` names.
- Tabs, sidebar, bookmarks, history, downloads, find-in-page, shortcuts, themes, permissions, and automatic updates.
- Ad blocking with signed list updates and per-site allowlisting.
- Wallet and dApp flows, x402 payments, hardware-wallet support, and Swarm/Radicle provider APIs.
- Custom protocol origins so decentralized applications can use relative assets, storage, service workers, and range requests naturally.

See the [feature guide](docs/features.md) for the detailed capability list.

## Run from source

Development uses Node.js 24 LTS. The exact repository version is pinned in [`.nvmrc`](.nvmrc).

```bash
nvm install
nvm use
npm ci
npm run ant:download
npm run ipfs:download
npm run myotis:download
npm start
```

Swarm and IPFS start automatically. Radicle and Myotis are opt-in under **Settings → Automatic Startup**. Run `npm run radicle:download` before enabling Radicle under **Settings → Nodes**; on macOS and Linux, run `npm run tor:download` before enabling Tor under **Settings → Experimental**. For prerequisites, platform notes, tests, debugging, and local builds, read the [development guide](docs/development.md).

## Architecture

Freedom is an Electron application. Protocol, node-lifecycle, permission, wallet, download, and persistence logic lives in the main process. The renderer is a modular UI layer that communicates with the main process through the allowlisted channels in `src/shared/ipc-channels.js`.

The main process handles `bzz:`, `ipfs:`, `ipns:`, `web3:`, `rad:`, and `.onion` navigation, manages per-profile nodes and storage, and resolves supported decentralized names. `web3:` needs no node or gateway: the handler reads the contract's ERC-8244 `html()` document through the same chain-data router the wallet uses. Security-sensitive capabilities stay out of page and renderer contexts unless exposed through a narrow preload or IPC API.

| Directory       | Responsibility                                                                         |
| --------------- | -------------------------------------------------------------------------------------- |
| `src/main/`     | Electron main process, services, native nodes, protocol handlers, IPC, and persistence |
| `src/renderer/` | Browser UI, internal pages, navigation, settings, and dApp integration                 |
| `src/shared/`   | Constants and utilities shared across processes                                        |
| `test-e2e/`     | Playwright harness and live Electron tests                                             |
| `config/`       | Runtime templates, default data, and platform entitlements                             |
| `scripts/`      | Build, download, smoke-test, and maintenance tooling                                   |
| `docs/`         | User, protocol, contributor, and maintainer documentation                              |

Contributors changing process responsibilities or adding IPC channels must follow the [architecture boundaries](docs/agent-playbooks/architecture-boundaries.md).

## Security model

- Electron runs with context isolation enabled and Node integration disabled in web content.
- Privileged internal APIs are restricted to trusted `freedom://` pages or narrow provider surfaces.
- Web permissions are denied by default and granted through per-site prompts.
- Nodes run locally by default; external endpoints are explicit per-profile settings.
- ENS resolution uses public RPC fallbacks unless a custom or locally verified endpoint is configured.

Do not post credentials, seed phrases, private keys, or sensitive logs in public issues. See [CONTRIBUTING.md](CONTRIBUTING.md) for disclosure guidance.

## Documentation

- [Documentation index](docs/README.md)
- [Development](docs/development.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Swarm content retrieval and migration](docs/protocols/swarm.md)
- [IPFS/IPNS content retrieval and migration](docs/protocols/ipfs.md)
- [Contract-hosted applications (ERC-8244)](docs/protocols/onchain-apps.md)
- [Radicle provider API](docs/radicle-provider-api.md)
- [Native IPFS desktop integration](docs/freedom-ipfs-native-desktop.md)
- [Changelog](CHANGELOG.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. It explains issue scope, local verification, commit conventions, licensing, and the policy for AI-assisted contributions.

Freedom Browser is available under the [Mozilla Public License 2.0](LICENSE). Third-party notices are recorded in [NOTICES](NOTICES).
