# ASAR checkpoint-worker check

On 2026-09-14, the actual production verifier/worker and installed Colibri 2.0.6 package were copied into a temporary ASAR archive using the installed @electron/asar tool. Electron 44.3.0 loaded the parent module from the archive, started its real worker from the archive, loaded the WASM runtime, and acquired live verified checkpoints for Ethereum and Gnosis. Both succeeded and Electron exited 0. The public checkpoint records are in result.jsonl; source-hashes.json identifies the checked verifier files.

To reproduce, run `node prepare.js /absolute/path/to/checkout`; it prints a fresh temporary directory. Launch that directory's `main.cjs` with the checkout's Electron binary with ELECTRON_RUN_AS_NODE unset. The script keeps the archive, profile and source staging directory for inspection. It installs nothing and does not load an existing profile.

This is targeted ASAR/worker/WASM loading evidence. It is not a full packaged-app, signing, notarization, fuse, Windows or Linux qualification.
