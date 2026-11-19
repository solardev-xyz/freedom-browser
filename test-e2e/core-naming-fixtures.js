// The network behind the identity core's naming, for specs whose page is a
// DNS name over IPNS (freedom-core design 0012, APR-5f). The core checks
// such a page's name itself: its naming sends `shell.rpc` reads to main,
// and main's naming shell hands each one to the hop installed here instead
// of the network (naming-shell.js's E2E hook). The hop answers naming's
// anchor reads as naming's recorded replay has them (freedom-core
// vectors/naming-replay.json, `quorum-agree`), and each `resolve` call with
// the contenthash of the IPNS key `globalThis.__names` maps the name to.
// That is the same mutable map a spec's stand-in for main's own resolution
// reads, so moving a name moves it for both. Each name the hop resolves is
// recorded in `globalThis.__coreResolved`.

// The anchor reads (freedom-core's naming replay, `quorum-agree`).
const RECORDED = {
  eth_blockNumber: '0x1312d00',
  eth_getBlockByNumber: {
    number: '0x1312cf8',
    hash: '0x4be63f085f8ba370ebbda152ea166c706c7456e0a760e43dd99fa20a90bbb878',
    parentHash: '0x8e2113c39b77e776d49c4bec6c88d9e7a7ae874f1ef9ba7126759e97182ad8ed',
    timestamp: '0x1',
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: '0x1',
    gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    baseFeePerGas: '0x1',
    transactions: [],
  },
};

/** An `ipns://` key (`k…`, base36 CIDv1) as ENS stores it: `ipns-ns`, then
 * the CID's bytes, in hex. */
function ipnsContenthash(key) {
  if (!/^k[0-9a-z]+$/.test(key)) throw new Error(`not a base36 IPNS key: ${key}`);
  let n = 0n;
  for (const c of key.slice(1)) n = n * 36n + BigInt(parseInt(c, 36));
  const hex = n.toString(16);
  return `e501${hex.length % 2 ? '0' : ''}${hex}`;
}

/**
 * Answers the core's naming reads from `globalThis.__names` (name → IPNS
 * key), which the spec owns, until the app closes. `keys` lists every IPNS
 * key the map may hold.
 */
async function serveCoreNaming(electronApp, keys) {
  const contenthashes = Object.fromEntries(keys.map((key) => [key, ipnsContenthash(key)]));
  await electronApp.evaluate(
    (_electron, args) => {
      globalThis.__coreResolved = [];
      const word = (n) => n.toString(16).padStart(64, '0');
      // A name as the `resolve` call's calldata carries it: DNS-encoded.
      const encoded = (name) =>
        `${name
          .split('.')
          .map((label) => {
            const bytes = Buffer.from(label, 'utf8');
            return `${bytes.length.toString(16).padStart(2, '0')}${bytes.toString('hex')}`;
          })
          .join('')}00`;
      // `resolve`'s answer, ABI-encoded `(bytes, address)`, for a contenthash.
      const resolved = (contenthash) => {
        const bytes = contenthash.length / 2;
        const padded = Math.ceil(bytes / 32) * 32;
        const inner = `${word(32)}${word(bytes)}${contenthash}${'00'.repeat(padded - bytes)}`;
        return `0x${word(0x40)}${'2'.repeat(40).padStart(64, '0')}${word(inner.length / 2)}${inner}`;
      };
      const reply = (request) => {
        if (request.method === 'eth_call') {
          const data = String(request.params?.[0]?.data || '').toLowerCase();
          const name = Object.keys(globalThis.__names || {}).find((n) => data.includes(encoded(n)));
          const contenthash = name && args.contenthashes[globalThis.__names[name]];
          if (name) globalThis.__coreResolved.push(name);
          return contenthash
            ? { result: resolved(contenthash) }
            : { error: { code: 3, message: 'execution reverted' } };
        }
        if (args.recorded[request.method] !== undefined)
          return { result: args.recorded[request.method] };
        return { error: { code: -32601, message: 'the method does not exist' } };
      };
      globalThis.__FREEDOM_TEST_NAMING__.setHop(async (_url, init) => {
        let body;
        try {
          const request = JSON.parse(String(init?.body));
          const one = (r) => ({ jsonrpc: '2.0', id: r.id, ...reply(r) });
          body = JSON.stringify(Array.isArray(request) ? request.map(one) : one(request));
        } catch {
          return { status: 400, headers: {}, body: Buffer.alloc(0) };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(body),
        };
      });
    },
    { contenthashes, recorded: RECORDED }
  );
}

/** The names the core's naming has resolved through the hop so far, each
 * once in the order first seen: one lookup reads every endpoint its quorum
 * asks, so how many reads a name gets is naming's affair. */
const coreResolved = (electronApp) =>
  electronApp.evaluate(() => [...new Set(globalThis.__coreResolved)]);

/** How many reads the core's naming has made through the hop so far: a
 * lookup repeated for a name already seen shows here, not in `coreResolved`. */
const coreReads = (electronApp) => electronApp.evaluate(() => globalThis.__coreResolved.length);

/** Naming's caches dropped, so the core's next check of a name resolves it
 * through the hop again (as it would once the cached answer expired). */
const clearCoreNamingCaches = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_NAMING__.cachesCleared());

module.exports = { serveCoreNaming, coreResolved, coreReads, clearCoreNamingCaches, ipnsContenthash };
