# Public quote-job native qualification — 6 October 2026

At [source commit 44035f1a](https://github.com/solardev-xyz/freedom-browser/tree/44035f1ae6a6aafdd00ee23d7505c1c6e5d11b1c), one public fixture quote passed the production quote-job body and four deliberately altered inputs were refused: changed signed message, wrong chain, identity public key and identity signature R. The [original report](report.json) and [public vectors](vectors.json) retain their exact bytes and original timestamps.

The five original utility closures reported exit 15 without escalation or peer disconnect. Each result records the exact 91-hook capability guard catalog, 91 canaries and zero attempts. Root observed the external launcher and original Electron process exit naturally with code 0. These are process and capability-guard observations, not an OS egress sandbox or physical-drain guarantee. The four refusal envelopes identify the production assertion path; they do not independently isolate each mathematical predicate.

Fixture construction used a public test seed, Node built-in signing and the pure address codec outside the guarded jobs. The runtime was Electron 44.5.1 / Node 24.21.0, with the pinned engine ASAR. No prover, proof artifacts, wire/gas builds, existing privacy profile, credentials or service access were used. The run did not exercise account enrollment, the production quote owner, its expiry admission, the account controller, operator trust, spending or disclosure. It adds job-body evidence, not live relay parity.

[Provenance](PROVENANCE.json) binds the reviewed launcher package, native source freeze, root checks, original process observations and record hashes. The selected report map contains 556 source files; the outer freeze covered 11,622 source files, 15 symlinks and three runtime inputs. These are inventories, not execution coverage. Root's focused checks passed 89 tests in four suites, strict lint with zero warnings, and six-file formatting. Independent Codex outcome/provenance review cleared the records without rerunning cryptography or rehashing runtime payloads; original process observations remain attributed to root.

## Reproduction boundary

Use the committed entry point with the existing pinned engine artifact and Electron runtime. Use an absolute config path, for example `/ABSOLUTE/CONFIG/quote-config.json`, containing exactly `{"archive":"/ABSOLUTE/ARTIFACTS/railgun-engine.asar"}`. The archive path must identify the pinned engine artifact. Choose a fresh, nonexistent absolute output directory outside the checkout and all input locations. From the checked-out source commit:

```sh
node_modules/.bin/electron scripts/qualify-railgun-relay-quote-job.js /ABSOLUTE/CONFIG/quote-config.json /ABSOLUTE/OUTPUTS/fresh-public-quote-run
```

This creates `electron/`, `report.json` and `vectors.json`. It constructs fresh public vectors, so timestamps and signatures can differ; the archived quote expiry remains historical and is not renewed. The command alone does not reproduce the external provenance: an independently reviewed launcher must bind source/runtime inventories before and after, enforce limits, retain original child observations, validate exact results and outputs, and observe its own original exit. The launcher source is identified by hash in this archive rather than shipped as a self-contained reproduction package. Do not infer completion from an output file alone.

[INDEX.json](INDEX.json) lists the public archive hashes. Absolute local paths are omitted from derived metadata; the public report and vectors are unchanged. No Chromium profile contents or runtime payloads are included.
