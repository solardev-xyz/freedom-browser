# Myotis host seed pins

Cold discovery can populate the execution pool with peers that cannot serve the
beacon-anchored head. Myotis v0.1.12 / ABI 32 accepts host-supplied enodes through
`setBootEnodes(handle, jsonArray)` to help find serving peers sooner. These are
discovery hints, **not checkpoint authorities**: signature, beacon and execution
proof verification, the checkpoint quorum and Colibri checks remain required.

## What ships and how it starts

`src/main/myotis/seeds/mainnet.json` contains the five supplied mainnet addresses;
`gnosis.json` contains the eighteen supplied Gnosis addresses. They are copied
from [freedom-browser-ios a247d32](https://github.com/solardev-xyz/freedom-browser-ios/commit/a247d32),
dated 2026-09-24, and ship inside the existing `src/**/*` app resource boundary.
The mainnet candidates were individually engine-probed by the mobile team.
Gnosis candidates came from serving (`snapok`) peer caches plus TCP checks;
they were not individually engine-probed. Desktop live results and limitations
are in [the seed-pin audit](audits/evidence/myotis-seed-pins-2026-09/README.md).

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
Resolver `eth_call` / `vitalik.eth`; a Myotis account read can qualify Gnosis.
Count only successful verified reads, never a fallback or an open TCP port.
Then replace the matching JSON list and rerun the parser, launch/recovery and
live checks. The audit contains a repeatable desktop cold/recovery driver.

## Trade-off

Bundling addresses directs fresh installs toward the same endpoints. Operators
see those connections, endpoints can become unavailable, and several addresses
may belong to the same operator (two mainnet addresses even share a key).
These lists establish no operator quorum or anonymity property. Shuffling
spreads first-dial preference; with the current 5/18 entries the subset includes
the whole list. Once there are more than 20 candidates it also varies membership.
Ordinary discovery continues, and dead pins remain subject to engine backoff.
Refresh lists based on measured service, without treating them as trusted chain
data sources or promising a fixed startup time.
