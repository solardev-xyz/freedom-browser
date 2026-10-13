/**
 * A held intent's label at the chain's finalized block (freedom-core design
 * 0005, "Retrying an intent": "Labels, not permissions" and "Evidence for
 * labels"):
 *
 * - **paid:** one of the intent's own transactions is included in a block
 *   of the finalized chain, with status 1;
 * - **failed:** one is included there with status 0;
 * - **taken:** another transaction of the sender, in a block of the
 *   finalized chain, used the intent's nonce: possibly this very payment
 *   signed elsewhere, so it may or may not have happened;
 * - **held:** anything else, a chain with no finalized block among it.
 *
 * A label settles the intent: its bytes are forgotten and its key freed,
 * and a new send of the same operation then takes a new nonce. So a label
 * must be true of the one finalized chain, never of a view a node made up
 * or a fork it follows.
 *
 * **Evidence.** Each read is verified (Myotis, Colibri, or a quorum agreed
 * among at least two endpoints), but separate reads may be agreed by
 * different endpoints, each an honest node's view: one lagging, one on an
 * unfinalized fork. A label therefore rests only on answers that don't
 * depend on a view, all tied to one finalized block F by hash:
 *
 * 1. F, the finalized block. Any verified answer names a finalized block
 *    (perhaps an older one).
 * 2. C, the sender's nonce *at F's hash* (EIP-1898). Every terminal label
 *    needs C > N. A node or chain that refuses the block-hash parameter
 *    leaves the intent held.
 * 3. Inclusion: a receipt counts only if its block hash is on the finalized
 *    chain, checked against a chain of headers verified from F down by
 *    hash links (`parentHash`), at most MAX_DEPTH blocks deep.
 * 4. Taken needs positive evidence: the block that used nonce N, found on
 *    that verified chain by the sender's nonce at each block's hash, holds
 *    a nonce-N transaction of the sender that is none of the intent's. A
 *    missing receipt is never evidence of anything.
 * 5. Only an explicit null receipt means absence. Receipts and blocks must
 *    be well formed, with real 32-byte hashes and the height asked for;
 *    anything else leaves the intent held.
 *
 * Every read goes through the injected `request`, called as
 * `chainData.request(chainId, method, params, options)` with trust and no
 * routing context, so it is never interactive.
 */

const LABELS = Object.freeze({
  PAID: 'paid',
  FAILED: 'failed',
  TAKEN: 'taken',
  HELD: 'held',
});

// What a held intent's reads saw, for the display: one of its transactions
// is on chain (not final yet), none is, the evidence was missing, or what
// would settle it lies deeper than the verifiable depth.
const OBSERVED = Object.freeze({
  INCLUDED: 'included',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
  UNVERIFIABLE: 'unverifiable',
});

// How far below F a label may look: headers walked, and the deepest block
// the nonce search may reach. Past it the intent stays held.
const MAX_DEPTH = 8192n;

const VERIFIED_SOURCES = new Set(['myotis', 'colibri', 'quorum']);

// The options of every read: trust, no routing context (never
// interactive), and background (never queues for Myotis, so the tracker
// doesn't hold the user's Myotis slot; the next verified source answers).
const READ_OPTIONS = Object.freeze({ includeTrust: true, background: true });

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether a read's reply is evidence for a label: verified, from Myotis,
 * Colibri, or a quorum agreed among at least two endpoints.
 */
function isVerifiedEvidence(reply) {
  const trust = reply?.trust;
  if (!trust || trust.level !== 'verified') return false;
  if (!VERIFIED_SOURCES.has(reply.source) || trust.method !== reply.source) return false;
  if (trust.method !== 'quorum') return true;
  return trust.quorum?.achieved === true && Number(trust.quorum?.m) >= 2;
}

// A JSON-RPC quantity, or null.
function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}

const hex = (n) => `0x${n.toString(16)}`;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why an intent stays held this pass. */
class Held extends Error {
  constructor(observed, reason) {
    super(reason);
    this.observed = observed;
  }
}

const unknown = (reason) => new Held(OBSERVED.UNKNOWN, reason);

/**
 * A block header from an answer, well formed: a number, and a hash and
 * parent hash of 32 bytes. With `expected`, the number and hash must be
 * those asked for.
 */
function header(answer, expected = {}) {
  if (!isObject(answer)) throw unknown('a malformed block');
  const number = quantity(answer.number);
  if (number === null || !HASH.test(answer.hash) || !HASH.test(answer.parentHash)) {
    throw unknown('a malformed block');
  }
  const found = {
    number,
    hash: answer.hash.toLowerCase(),
    parentHash: answer.parentHash.toLowerCase(),
  };
  if (expected.number !== undefined && found.number !== expected.number) {
    throw unknown('a block of another height than the one asked for');
  }
  if (expected.hash !== undefined && found.hash !== expected.hash) {
    throw unknown('a block other than the one asked for');
  }
  return found;
}

/** A receipt of `hash` from `sender`, well formed. */
function receiptOf(answer, hash, sender) {
  if (!isObject(answer)) throw unknown('a malformed receipt');
  const blockNumber = quantity(answer.blockNumber);
  const status = quantity(answer.status);
  if (
    typeof answer.transactionHash !== 'string' ||
    answer.transactionHash.toLowerCase() !== hash ||
    !ADDRESS.test(answer.from) ||
    answer.from.toLowerCase() !== sender ||
    !HASH.test(answer.blockHash) ||
    blockNumber === null ||
    (status !== 0n && status !== 1n)
  ) {
    throw unknown('a malformed receipt, or one for another transaction');
  }
  return { blockNumber, blockHash: answer.blockHash.toLowerCase(), status };
}

/**
 * A chain of headers verified by hash links, from a finalized block down:
 * immutable once verified, so a tracker keeps one per chain across passes
 * and every intent of the chain shares it.
 */
function createChainSegment() {
  return { headers: new Map(), top: null, bottom: null };
}

function resetSegment(segment, top) {
  segment.headers = new Map([[top.number, top]]);
  segment.top = top.number;
  segment.bottom = top.number;
}

/**
 * Verify the headers below `child` down to `height`, by hash link: each
 * one's hash is its child's parent hash. Headers are fetched by number,
 * all at once (the reads are bounded by the caller), and one whose hash
 * isn't the expected link is fetched again by that hash.
 */
async function walkDown(segment, child, height, read) {
  const heights = [];
  for (let h = child.number - 1n; h >= height; h -= 1n) heights.push(h);
  const byNumber = await Promise.all(
    heights.map((h) => read('eth_getBlockByNumber', [hex(h), false]).catch(() => null))
  );
  let below = child;
  for (const [i, h] of heights.entries()) {
    let found;
    try {
      found = header(byNumber[i], { number: h, hash: below.parentHash });
    } catch {
      found = header(await read('eth_getBlockByHash', [below.parentHash, false]), {
        number: h,
        hash: below.parentHash,
      });
    }
    segment.headers.set(h, found);
    below = found;
  }
  segment.bottom = height < segment.bottom ? height : segment.bottom;
}

/**
 * Tie `segment` to the finalized block `F`: extend it up to F (checking it
 * still links to what was verified before), or check that F, an older
 * finalized block, is on it.
 */
async function anchor(segment, F, read) {
  if (segment.top === null) {
    resetSegment(segment, F);
    return;
  }
  if (F.number > segment.top) {
    if (F.number - segment.top > MAX_DEPTH) {
      resetSegment(segment, F);
      return;
    }
    const top = segment.headers.get(segment.top);
    const above = createChainSegment();
    resetSegment(above, F);
    await walkDown(above, F, segment.top + 1n, read);
    const lowest = above.headers.get(segment.top + 1n) ?? F;
    if (lowest.parentHash !== top.hash) {
      // The finalized chain doesn't fork: what was verified before is
      // dropped rather than trusted against it.
      segment.headers = above.headers;
      segment.top = F.number;
      segment.bottom = above.bottom;
      return;
    }
    for (const [h, found] of above.headers) segment.headers.set(h, found);
    segment.top = F.number;
    // Keep what a label may look at, and no more.
    for (const h of segment.headers.keys()) {
      if (F.number - h > MAX_DEPTH) segment.headers.delete(h);
    }
    segment.bottom = F.number - MAX_DEPTH > segment.bottom ? F.number - MAX_DEPTH : segment.bottom;
    return;
  }
  if (segment.top - F.number > MAX_DEPTH) {
    throw new Held(OBSERVED.UNVERIFIABLE, 'a finalized block older than the verifiable depth');
  }
  if (F.number < segment.bottom) {
    await walkDown(segment, segment.headers.get(segment.bottom), F.number, read);
  }
  if (segment.headers.get(F.number)?.hash !== F.hash) {
    throw unknown('the finalized block is not on the chain verified before');
  }
}

/** The verified hash at `height`, at most MAX_DEPTH below F. */
async function hashAt(segment, F, height, read) {
  if (height > F.number) throw new Held(OBSERVED.INCLUDED, 'above the finalized block');
  if (F.number - height > MAX_DEPTH) {
    throw new Held(
      OBSERVED.UNVERIFIABLE,
      'deeper than the verifiable depth below the finalized block'
    );
  }
  if (height < segment.bottom)
    await walkDown(segment, segment.headers.get(segment.bottom), height, read);
  return segment.headers.get(height).hash;
}

function held(observed, reason) {
  return { label: LABELS.HELD, observed, reason };
}

/**
 * @param {object} intent - a held intent's view: chainId, sender, nonce,
 *   hashes [{ hash }]
 * @param {object} deps
 * @param {Function} deps.request - chainData.request
 * @param {object} [deps.segment] - the chain's verified headers, kept
 *   across intents and passes (createChainSegment)
 * @returns {Promise<{label: 'paid'|'failed', hash: string, block: number}
 *   | {label: 'taken', hash: null, block: number}
 *   | {label: 'held', observed: string, reason: string}>}
 */
async function readLabel(intent, { request, segment = createChainSegment() }) {
  const sender = intent.sender.toLowerCase();
  const nonce = BigInt(intent.nonce);
  const hashes = intent.hashes.map((entry) => entry.hash.toLowerCase());
  const read = async (method, params) => {
    const reply = await request(intent.chainId, method, params, READ_OPTIONS);
    if (!isVerifiedEvidence(reply)) {
      throw unknown(`${method} had no verified evidence (${reply?.source ?? 'none'})`);
    }
    return reply.result;
  };

  try {
    // 1. The finalized block, and the verified chain below it.
    const finalized = await read('eth_getBlockByNumber', ['finalized', false]);
    if (finalized === null) return held(OBSERVED.UNKNOWN, 'no finalized block');
    const F = header(finalized);
    await anchor(segment, F, read);

    // 2. The sender's nonce at F, by F's hash.
    const countAt = async (blockHash) => {
      const count = quantity(await read('eth_getTransactionCount', [sender, { blockHash }]));
      if (count === null) throw unknown('a malformed nonce');
      return count;
    };
    const count = await countAt(F.hash);

    // 3. A receipt of its own, in a block of the finalized chain.
    for (const hash of hashes) {
      const answer = await read('eth_getTransactionReceipt', [hash]);
      if (answer === null) continue;
      const receipt = receiptOf(answer, hash, sender);
      const onChain = await hashAt(segment, F, receipt.blockNumber, read);
      if (onChain !== receipt.blockHash) {
        return held(OBSERVED.UNKNOWN, 'its receipt is not in a block of the finalized chain');
      }
      if (count <= nonce) {
        return held(OBSERVED.UNKNOWN, 'the finalized nonce disagrees with its receipt');
      }
      return {
        label: receipt.status === 1n ? LABELS.PAID : LABELS.FAILED,
        hash,
        block: Number(F.number),
      };
    }
    if (count <= nonce) return held(OBSERVED.ABSENT, 'not included');

    // 4. The nonce was used at or below F, by none of its receipts: find
    // the block that used it, and the transaction there.
    const height = await usedAt(nonce, F, segment, read, countAt);
    const blockHash = await hashAt(segment, F, height, read);
    const block = await read('eth_getBlockByHash', [blockHash, true]);
    header(block, { number: height, hash: blockHash });
    if (!Array.isArray(block.transactions)) throw unknown('a malformed block');
    const used = block.transactions.find(
      (tx) => isObject(tx) && tx.from?.toLowerCase?.() === sender && quantity(tx.nonce) === nonce
    );
    if (!used || !HASH.test(used.hash)) {
      throw unknown('the block that used the nonce has no such transaction of the sender');
    }
    if (hashes.includes(used.hash.toLowerCase())) {
      // Its own transaction used it, but its receipt read as none: the
      // receipt reads lag. Read again next pass.
      return held(OBSERVED.INCLUDED, 'its own transaction used the nonce; no receipt yet');
    }
    return { label: LABELS.TAKEN, hash: null, block: Number(F.number) };
  } catch (err) {
    if (err instanceof Held) return held(err.observed, err.message);
    return held(OBSERVED.UNKNOWN, `read failed: ${err.message}`);
  }
}

/**
 * The height of the block that used `nonce`: the lowest on the verified
 * chain where the sender's nonce is past it. Galloping down from F, then a
 * binary search, each step a nonce read at a verified block hash.
 */
async function usedAt(nonce, F, segment, read, countAt) {
  const deepest = F.number > MAX_DEPTH ? F.number - MAX_DEPTH : 0n;
  let above = F.number; // its nonce is past `nonce`
  let below = null; // its nonce is not
  for (let step = 1n; below === null; step *= 2n) {
    let probe = above - step;
    if (probe < deepest) probe = deepest;
    if (probe >= above) {
      throw new Held(OBSERVED.UNVERIFIABLE, 'the nonce was used deeper than the verifiable depth');
    }
    if ((await countAt(await hashAt(segment, F, probe, read))) > nonce) {
      above = probe;
      if (probe === deepest) {
        throw new Held(
          OBSERVED.UNVERIFIABLE,
          'the nonce was used deeper than the verifiable depth'
        );
      }
    } else {
      below = probe;
    }
  }
  while (above - below > 1n) {
    const mid = below + (above - below) / 2n;
    if ((await countAt(await hashAt(segment, F, mid, read))) > nonce) above = mid;
    else below = mid;
  }
  return above;
}

module.exports = {
  LABELS,
  OBSERVED,
  MAX_DEPTH,
  READ_OPTIONS,
  isVerifiedEvidence,
  createChainSegment,
  readLabel,
};
