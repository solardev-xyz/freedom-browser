/* global jest */

/**
 * A chain as the wallet's finality labels read it (intent-labels.js), for
 * tests: blocks with hashes linked by `parentHash`, a sender's
 * transactions in them, and the reads a label makes, each answered by one
 * *view* of the chain, wrapped as a verified quorum reply.
 *
 * A view is what one honest node sees: the canonical chain up to its head
 * and finalized block, or a fork of it above some height. A test names
 * which view answers each read, as the winning pair of a quorum would, and
 * may wrap or reshape any answer.
 *
 * Nodes serve state for a window of recent blocks only (geth: 128): with
 * `stateWindow`, a nonce read at a block more than that below the view's
 * head fails as a node's missing state does. `prove` answers as a prover
 * would, from the canonical chain at any depth (Colibri, design 0005
 * "State history").
 *
 *   const chain = fakeFinalityChain({ sender, startNonce: 7,
 *     txs: { 90: [{ hash, nonce: 7, status: 1 }] } });
 *   chain.request  // (chainId, method, params, options) => reply
 */

const hex = (n) => `0x${Number(n).toString(16)}`;
const pad = (n) => Number(n).toString(16).padStart(62, '0');

// Block hashes: canonical `0xc0…h`, a fork's `0xf<k>…h`.
const canonicalHash = (h) => `0xc0${pad(h)}`;
const forkHash = (h, k = 1) => `0xf${k}${pad(h)}`;

const quorum = (result, { m = 2, k = 3, achieved = true } = {}) => ({
  result,
  source: 'quorum',
  verified: true,
  trust: { level: 'verified', method: 'quorum', block: null, quorum: { k, m, achieved } },
});

/**
 * @param {object} options
 * @param {string} options.sender
 * @param {number} [options.startNonce] - the sender's nonce before block 1
 * @param {Record<number, object[]>} [options.txs] - canonical transactions
 *   by height: { hash, nonce, status, from? } (from defaults to sender)
 * @param {number} [options.head]
 * @param {number|null} [options.finalized]
 * @param {number} [options.stateWindow] - how far below its head a view
 *   answers nonce reads
 */
function fakeFinalityChain({
  sender,
  startNonce = 0,
  txs = {},
  head = 120,
  finalized = 100,
  stateWindow = Infinity,
} = {}) {
  const views = {};

  /**
   * A view: the canonical blocks up to `forkAt`, its own above (with
   * `forkTxs`), up to `head`, finalized at `finalized`.
   */
  function defineView(
    name,
    { forkAt = Infinity, forkTxs = {}, head: top = head, finalized: fin = finalized, fork = 1 } = {}
  ) {
    const hashOf = (h) => (h > forkAt ? forkHash(h, fork) : canonicalHash(h));
    const txsAt = (h) => (h > forkAt ? forkTxs[h] : txs[h]) ?? [];
    const blocks = new Map();
    let count = startNonce;
    const counts = new Map();
    const where = new Map();
    for (let h = 0; h <= top; h += 1) {
      const block = {
        number: hex(h),
        hash: hashOf(h),
        parentHash: h === 0 ? `0x${'00'.repeat(32)}` : hashOf(h - 1),
        transactions: txsAt(h).map((tx) => ({
          hash: tx.hash,
          from: tx.from ?? sender,
          nonce: hex(tx.nonce),
        })),
      };
      for (const tx of txsAt(h)) {
        if ((tx.from ?? sender).toLowerCase() === sender.toLowerCase()) count += 1;
        where.set(tx.hash.toLowerCase(), { tx, height: h });
      }
      counts.set(block.hash, count);
      blocks.set(block.hash, block);
    }
    const heights = new Map(
      [...blocks.values()].map((block) => [block.hash, Number(block.number)])
    );
    const byHeight = (h) => blocks.get(hashOf(h));
    views[name] = { blocks, counts, heights, where, byHeight, top, finalized: fin, hashOf };
    return views[name];
  }

  defineView('canonical');

  const headerOf = (block, full) =>
    block && {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      transactions: full ? block.transactions : block.transactions.map((tx) => tx.hash),
    };

  // A view's answer to a read: the result, or a thrown error. `window`: how
  // far below the view's head it serves state.
  function answer(view, method, params, window = stateWindow) {
    switch (method) {
      case 'eth_getBlockByNumber': {
        if (params[0] === 'finalized') {
          return view.finalized === null
            ? null
            : headerOf(view.byHeight(view.finalized), params[1]);
        }
        const h = Number(BigInt(params[0]));
        return h <= view.top ? headerOf(view.byHeight(h), params[1]) : null;
      }
      case 'eth_getBlockByHash':
        return headerOf(view.blocks.get(String(params[0]).toLowerCase()), params[1]) ?? null;
      case 'eth_getTransactionCount': {
        const at = params[1];
        // An honest node answers the tag too (the labels never ask by tag).
        if (at === 'finalized') {
          if (view.finalized === null) throw new Error('finalized block not found');
          return hex(view.counts.get(view.hashOf(view.finalized)));
        }
        if (typeof at?.blockHash !== 'string') {
          throw new Error(`unscripted block parameter ${JSON.stringify(at)}`);
        }
        const blockHash = at.blockHash.toLowerCase();
        if (!view.counts.has(blockHash)) throw new Error('header for hash not found');
        if (view.top - view.heights.get(blockHash) > window) {
          throw new Error(
            `missing trie node ${blockHash.slice(2, 18)} (path ) state is not available`
          );
        }
        return hex(view.counts.get(blockHash));
      }
      case 'eth_getTransactionReceipt': {
        const found = view.where.get(String(params[0]).toLowerCase());
        if (!found) return null;
        const block = view.byHeight(found.height);
        return {
          transactionHash: found.tx.hash,
          from: found.tx.from ?? sender,
          blockNumber: block.number,
          blockHash: block.hash,
          status: hex(found.tx.status ?? 1),
        };
      }
      default:
        throw new Error(`unscripted ${method}`);
    }
  }

  const routes = {};
  const wraps = {};
  const reshapes = {};

  // A read's route key: a block by number other than "finalized" is
  // `eth_getBlockByNumber:number`.
  const routeOf = (method, params) =>
    method === 'eth_getBlockByNumber' && params[0] !== 'finalized' ? `${method}:number` : method;

  const request = jest.fn(async (_chainId, method, params) => {
    const route = routeOf(method, params);
    const view = views[routes[route] ?? 'canonical'];
    let result = answer(view, method, params);
    if (reshapes[route]) result = reshapes[route](result, params);
    return (wraps[route] ?? quorum)(result);
  });

  return {
    request,
    views,
    defineView,
    canonicalHash,
    forkHash,
    /** Which view answers a read (by route key). */
    route(route, view) {
      routes[route] = view;
    },
    /** How a read's answer is wrapped (a reply maker). */
    wrap(route, wrapper) {
      wraps[route] = wrapper;
    },
    /** Change a read's answer before it is wrapped. */
    reshape(route, fn) {
      reshapes[route] = fn;
    },
    /**
     * A prover's answer to a read: the canonical chain's, at any depth,
     * reshaped as for `request` but not wrapped.
     */
    prove(method, params) {
      const route = routeOf(method, params);
      let result = answer(views.canonical, method, params, Infinity);
      if (reshapes[route]) result = reshapes[route](result, params);
      return result;
    },
    /** The reads made, as [method, params]. */
    reads: () => request.mock.calls.map(([, method, params]) => [method, params]),
    /**
     * One view's own answer to a read, reshaped as for `request` but not
     * wrapped: what one endpoint would answer (a thrown error, its error).
     */
    answerFrom(name, method, params) {
      const route = routeOf(method, params);
      let result = answer(views[name], method, params);
      if (reshapes[route]) result = reshapes[route](result, params);
      return result;
    },
  };
}

module.exports = { fakeFinalityChain, quorum, canonicalHash, forkHash, hex };
