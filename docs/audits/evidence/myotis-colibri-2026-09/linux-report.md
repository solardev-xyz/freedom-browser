# Linux Colibri 2.0.6 interoperability result

Completed 2026-09-14 18:21–18:23 UTC. **10 verified returns; 2 finalized-tag failures.** Both chains, both requested latest methods, and both ZK settings worked in the exact package's WASM runtime. No native load, unverified RPC fallback, ZK-to-non-ZK fallback, timeout or process intervention occurred. All 12 process exits were 0 and stderr empty; the script deliberately records caught RPC failures in result.json, so process 0 does NOT turn the two failures into passes.

| Chain    | Method / tag                         | ZK true           | ZK false          |
| -------- | ------------------------------------ | ----------------- | ----------------- |
| Ethereum | eth_getBlockByNumber latest,false    | VERIFIED, 1172 ms | VERIFIED, 710 ms  |
| Ethereum | eth_getBlockHeader latest            | VERIFIED, 876 ms  | VERIFIED, 534 ms  |
| Gnosis   | eth_getBlockByNumber latest,false    | VERIFIED, 1009 ms | VERIFIED, 632 ms  |
| Gnosis   | eth_getBlockHeader latest            | VERIFIED, 888 ms  | VERIFIED, 1281 ms |
| Ethereum | eth_getBlockByNumber 0x18c626f,false | VERIFIED, 1073 ms | NOT RUN           |
| Gnosis   | eth_getBlockByNumber 0x2e03eb7,false | VERIFIED, 1065 ms | NOT RUN           |
| Ethereum | eth_getBlockByNumber finalized,false | FAIL, HTTP 502    | NOT RUN           |
| Gnosis   | eth_getBlockByNumber finalized,false | FAIL, HTTP 502    | NOT RUN           |

Times above are request-script elapsed; maximum complete process elapsed was 1.347 s. No broader matrix was run.

Verified block values agreed between block/header, ZK true/false and subsequent explicit-height probes:

```json
{"chainId":1,"height":25977455,"number":"0x18c626f","hash":"0xab006243c43b5f60e85d6c73931b58d428a25a6589c3425fc8aeb3934ae606d6","timestamp":"0x6aa83b2f","timeUTC":"2026-09-14T18:21:35.000Z"}
{"chainId":100,"height":48250551,"number":"0x2e03eb7","hash":"0x25c76c0dc4281c6111668cfdc3a327f686406803191a532fd1bd1dc1ac1082c0","timestamp":"0x6aa83b3e","timeUTC":"2026-09-14T18:21:50.000Z"}
```

Header response fields are `blockNumber`/`blockHash`, versus block response `number`/`hash`. The original script's compact `block` field omitted header hash/height; original full `value` is retained, and summary.json derives them correctly without altering original evidence.

## Failure classification

Ethereum finalized response: HTTP 502, application/json, 43 bytes, body `{"error":"legacy prover forwarding failed"}`. Gnosis finalized response: HTTP 502, Cloudflare HTML Bad gateway, 6473 bytes. Both subsequently produced WASM state error `Invalid block: "finalized"` and client error `Error in rpc call eth_getBlockByNumber["finalized",false] : Invalid block: "finalized"`.

Thus there is an observed HTTP/server failure AND a client/core invalid-tag error, not a clean successful HTTP proof rejected cryptographically. These observations reproduce the reported macOS symptom and do not support a Linux-specific WASM failure. Latest methods were classified PROOFABLE (1) and actually returned through VerifiedOnly; no unsupported-method result occurred. The precise server-side origin of finalized rejection was not independently diagnosed.

## Important checkpoint dependency

Cold empty storage **does request checkpoint services even with ZK enabled**. There were two HTTP requests per successful ZK=true case, three per ZK=false case, all HTTP 200. Initial proof POST used only the configured chain endpoint:

- Ethereum: https://mainnet1.colibri-proof.tech/
- Gnosis: https://gnosis.colibri-proof.tech/

With ZK=true, additional GETs were:

- `https://sync-mainnet.beaconcha.in/eth/v1/beacon/blocks/15215424/root`
- `https://checkpoint.gnosischain.com/eth/v1/beacon/blocks/30083312/root`

With ZK=false, each chain requested its same checkpoint host's `/eth/v1/beacon/states/head/finality_checkpoints`, then:

- `https://mainnet.colibri-proof.tech/consensus/eth/v1/beacon/light_client/bootstrap/0xa496cc3f06aff062c86b573d398fe0a4ad8ede53817f1a73028eae3a2ff3eef4`
- `https://gnosis.colibri-proof.tech/consensus/eth/v1/beacon/light_client/bootstrap/0x5aa0ae32dae4c64703e86f11fda21f7ef52110a02d8d67c086b9b806a95b3008`

No execution-RPC fallback was observed. The package contains an automatic retry on a `zk sync proof` error that changes zk_proof to false; initial/final settings and HTTP payloads were recorded and show this did not occur. Explicit false cases are separate requests, not retries. Default checkpoint/beacon lists were retained; this was not restricted to the proof host alone. Do not equate VerifiedOnly success with checkpoint-service independence or an audited trust model.

## Exact execution and provenance

Everything is retained remotely under `/tmp/colibri-linux-1754c71e.nlwTxr` (these paths are on Linux, not directly accessible from the primary Mac). Acquisition only: `npm pack @corpus-core/colibri-stateless@2.0.6 --ignore-scripts --json`, npm 11.12.1, clean environment, fresh task HOME/cache, separate empty/nonexistent user/global config paths; tar extracted locally. No project install or upgrades. Package declares no runtime dependencies. Pack's SHA1 and SHA512 integrity were verified in addition to SHA256.

Each case used a separate process via:

```text
/usr/sbin/runuser -u freedomqual -- env -i PATH=/usr/bin:/bin HOME=CASE_DIR C4_DISABLE_NATIVE=1 /usr/bin/timeout --kill-after=2 90 /opt/freedom-qualification-node-v24.15.0/bin/node /tmp/colibri-linux-1754c71e.nlwTxr/probe.mjs CHAIN METHOD ZK TAG CASE_DIR
```

Installed Node 24.15.0 Linux x64; runtime.kind asserted `wasm`. C4_DISABLE_NATIVE was present before package import. A Map-backed localStorage was installed before import to avoid filesystem storage initialization, then explicit Colibri.register_storage used a fresh Map before any client/request. Every case recorded initialStorageEntries=0; no persistent checkpoint files or preexisting profile were used. Config: Strategy.VerifiedOnly, rpcs=[], max_latest_age_seconds=60, privacy_mode=basic, explicit zk_proof. No trusted checkpoint override or weak-subjectivity bypass. Public HTTPS only, no redirects, method allowlist, 12-second fetch/body timeout, 8 MiB response cap, 30-request cap, 88-second internal budget, outer 90-second timeout. No existing checkout/profile touched; no keys or transactions.

SHA256 identities:

- npm tar, 3,851,479 bytes: `8d29c2f62dda91e626107a6c7db56550a533bd2f2b92f76114bec6bb00d2eca7`
- package/c4w.wasm, 1,130,756 bytes: `7bd999c2183d9863c0b791e3cdefd8f5b2bc7e095760a30436660d58c1f6ea3f`
- Node executable: `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`
- probe.mjs, 4450 bytes: `71b2753700ac3a01d5f10357736f0a0bda9ed6dc6883d364edbccacaf0be3a87`

## Retained artifacts

- `probe.mjs`: exact probe; `run.py` / `run_tags.py`: exact sequential runners.
- `commands.json` / `tag-commands.json`: every actual argv, exit and process elapsed time.
- Each `CHAIN-METHOD-ZK-TAG/`: original events.jsonl, result.json and response-N.bin. `response-1.bin` is the returned proof for successful cases; later responses are checkpoint/bootstrap bytes. All bytes preserved, including failures. Root-level matching .stdout/.stderr retained.
- `summary.json`: 21,707 bytes, SHA256 `88cdbb6cdc51458b18a4acaf8c16525a1938000ad16ad5bf34d496af79fe0ea8`; compact results, URLs/methods/statuses and proof paths/hashes.
- `provenance.json`: 13,740 bytes, SHA256 `f9717ff3ca7ad5d9904c9c0e975d4992d1b631042c3605a8f6eb4c8e9d4b08a2`; runtime/package identities plus all package-member hashes.
- `ARTIFACTS.json`: 15,297 bytes, SHA256 `d269db5ab045fdccb39025e3e96917ab238e172a0345bfeabd013f7d7c36cc7e`; exact raw evidence member paths/sizes/hashes.

Example successful proof: `1-eth_getBlockByNumber-true-latest/response-1.bin`, 204,873 bytes, SHA256 `2c567608af8f08e0ad7b3eae57ba78157b05a5902e3c379e1756687060fef209`; Gnosis equivalent 43,437 bytes, SHA256 `83da5bca4598f1fbca91c7169fb83f501dce05c1262c0afa972abf4c05600f8c`.

This establishes these public endpoint/package/WASM combinations at the recorded times, not Freedom integration, Myotis stale-anchor recovery, independent consensus corroboration, future availability or a security audit. Official source consulted: https://github.com/corpus-core/colibri-stateless; exact shipped package source and bytes are retained above. No GitHub posting.
