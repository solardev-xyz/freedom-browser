# zSwap read-source lab

This opt-in live lab captures the safe JSON-RPC reads produced by a real zSwap
quote and replays them against Freedom's Ethereum read sources in isolation.
It is intended for investigation and capacity planning, not as a CI gate.

Run it with:

```sh
npm run test:lab:zswap-reads
```

The lab loads zSwap through Direct RPC so document retrieval does not bias the
source comparison. It then records the dapp's provider calls, filters the trace
through Freedom's read-method allowlist, and caps the corpus at 40 calls by
default. Wallet methods and transaction broadcasts are never replayed.

The matrix includes Freedom's production Direct fallback, each of the three
RPC endpoints participating in quorum, RPC quorum itself, Colibri, and Myotis.
A warm Colibri pass runs only when the cold pass finishes cleanly; a timed-out
request cannot currently be cancelled and would contaminate a second pass.
Exact zSwap calls are pinned to the block selected by the dapp. Because Myotis
currently serves head state rather than arbitrary historical blocks, the
report separates exact pinned compatibility from an optional `latest-adapted`
capacity run. The latter is not result-equivalent to the original quote.

Reports are written as JSON and Markdown to the operating system's temporary
directory. Set `ZSWAP_LAB_OUTPUT` to choose the JSON destination. Other tuning
variables are documented at the top of the live spec.

Live timings depend on the public endpoints, prover state, light-client sync,
and current chain conditions. The test therefore asserts only that a genuine
zSwap read corpus was captured; performance and source failures are report
data rather than brittle pass/fail assertions.
