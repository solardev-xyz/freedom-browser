# Myotis host seed pins

Cold discovery can populate the execution pool with peers that cannot serve the
beacon-anchored head. Myotis v0.1.12 / ABI 32 accepts host-supplied enodes through
`setBootEnodes(handle, jsonArray)` to help find serving peers sooner. These are
discovery hints, **not checkpoint authorities**: signature, beacon and execution
proof verification, the checkpoint quorum and Colibri checks remain required.

## What ships and how it starts

`src/main/myotis/seeds/mainnet.json` contains five mainnet addresses from
[freedom-browser-ios a247d32](https://github.com/solardev-xyz/freedom-browser-ios/commit/a247d32).
`gnosis.json` contains the four Gnosis addresses retained by the mobile team's
2026-09-25 pool-admission probe ([ca470e3](https://github.com/solardev-xyz/freedom-browser-ios/commit/ca470e3),
on `feat/gnosis-seed-probe`, not yet merged when adopted here). Both lists ship
inside the existing `src/**/*` app resource boundary.

The five mainnet candidates each served the Universal Resolver call alone on a
cold engine in the mobile team's probe. The original eighteen Gnosis candidates
came from `snapok` caches and TCP checks. With all eighteen pinned, four
connected and were admitted at the anchored head; the other fourteen failed at
transport or handshake. This does **not** individually qualify the four for
verified reads: built-in Gnosis bootnodes could answer during single-pin tests.
Two retained addresses, `141.94.97.22` and `141.94.97.74`, are those serving
bootnodes. The mobile team observed serving readiness within one second and
30–70 ms balance reads with or without pins; that is a platform/run observation,
not a desktop timing guarantee or evidence that the pins caused the improvement.
The two other retained addresses provide additional discovery candidates, not a
proven outage guarantee. Earlier desktop measurements used the original eighteen
pins and remain recorded as such in [the seed-pin audit](audits/evidence/myotis-seed-pins-2026-09/README.md).

The host accepts lowercase 128-hex-key enodes with numeric IPv4 addresses and
ports 1–65535. Malformed entries, DNS, IPv6, ambiguous IPv4 octets and query strings
are dropped. The engine accepts `?discport=`, but the desktop bundle/override
format deliberately uses plain enodes. Addresses are deduplicated after port
normalization; one key at two different addresses remains two entries. Parsing
caps at 64 valid entries; selection shuffles a copy and takes at most 20. A
missing, unreadable or malformed bundled resource yields an empty list.

The manager selects per-network pins for **every** native launch. The existing
private supervisor startup message carries them to the native child, which
revalidates and calls `setBootEnodes` immediately after `start()`. This covers
fresh installs, restarts, repair and both handles involved in stale-anchor
recovery. No addon handle enters main or the renderer, and no public IPC API
was added. The child reports only the count and applied/refused flag. Main logs
`seed pins (N) applied` or `refused`; an empty list makes no addon call. Refusal
or an unavailable pin API leaves ordinary discovery running.

The engine applies or refuses the whole list. It retains pins per handle,
replays them on start/resume, prioritizes their dials and retries them with its
backoff while no peer serves. Pins are not inserted into the peer cache merely
because the host supplied them; peers may earn cache entries through ordinary
successful network activity. A new handle needs a new push.

## Overrides

These optional main-process environment variables replace the corresponding
bundle, not append to it:

- `FREEDOM_MYOTIS_BOOT_ENODES_MAINNET`
- `FREEDOM_MYOTIS_BOOT_ENODES_GNOSIS`

Each value is a JSON array of plain enode strings. `[]` explicitly disables the
bundled list for that network. Invalid/empty overrides select nothing rather
than falling back silently. Restart the node to apply a change. The environment
itself is not forwarded to the native child; only validated selected pins cross
the existing startup channel.

## Refreshing the lists

Use warm, stopped **test-profile** `peers.cache` (mainnet) or
`peers-gnosis.cache` (Gnosis) files. Do not mix networks. The refresh tool keeps
`snapok`, rejects `snapbad`, deduplicates IPv4 addresses and TCP-probes each
candidate with a three-second timeout. It requires Python 3.9+ and no packages.
Write a separate candidate file for review:

```sh
python3 scripts/myotis-seeds.py --out /tmp/mainnet-candidates.json /path/to/peers.cache
python3 scripts/myotis-seeds.py --out /tmp/gnosis-candidates.json /path/to/peers-gnosis.cache
```

`--no-probe` only extracts candidates. The output is sorted and capped at 64.
TCP connectivity and a historical `snapok` label do not prove the peer can
serve today's anchored head. Before bundling, probe each candidate alone using
a one-entry per-network override on a fresh disposable profile: wait for
`snapServingPeers > 0`, make a real verified read, record elapsed time and
confirm the native process stopped. On mainnet use the generic Universal
Resolver `eth_call` / `vitalik.eth`; use a Myotis account read on Gnosis.
A one-entry override does not disable built-in bootnodes or ordinary discovery:
attribute the successful read to the candidate using engine logs before claiming
individual qualification. Otherwise report only pool admission and the aggregate
read result, as in the Gnosis probe above.
Count only successful verified reads, never a fallback or an open TCP port.
Then replace the matching JSON list and rerun the parser, launch/recovery and
live checks. The audit contains a repeatable desktop cold/recovery driver.

## Trade-off

Bundling addresses directs fresh installs toward the same endpoints. Operators
see those connections, endpoints can become unavailable, and several addresses
may belong to the same operator (two mainnet addresses even share a key).
These lists establish no operator quorum or anonymity property. Shuffling
spreads first-dial preference; with the current 5/4 entries the subset includes
the whole list. Once there are more than 20 candidates it also varies membership.
Ordinary discovery continues, and dead pins remain subject to engine backoff.
Refresh lists based on measured service, without treating them as trusted chain
data sources or promising a fixed startup time.
