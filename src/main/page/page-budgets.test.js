const {
  BUDGETS,
  COPIES,
  DEFAULT_COPIES,
  STREAM_BYTES,
  VALUE_BYTES,
  REQUEST_BYTES,
  TICKETS,
  chargeOf,
  largestChargeOf,
  createPageBudgets,
} = require('./page-budgets');

const MiB = 1024 * 1024;
const KiB = 1024;

describe('the charge (freedom-core design 0011, "The size and the charge")', () => {
  test('the numbers', () => {
    expect(BUDGETS).toEqual({
      document: { requests: 64, bytes: 128 * MiB },
      window: { requests: 256, bytes: 256 * MiB },
      browser: { requests: 1024, bytes: 384 * MiB },
    });
    expect(TICKETS).toEqual({ turns: 2, waiting: 16, unusedMs: 30_000, bytes: 32 });
    // A feed entry's are the JS backend's: the IPC value (a string two bytes
    // a character), a string's UTF-8, and bee-js's fetch's three copies of
    // the body (measured in Electron 45); the core's backend holds three.
    expect(COPIES).toEqual({ 'swarm:swarm_publishFiles': 2, 'swarm:swarm_publishData': 3, 'swarm:swarm_writeFeedEntry': 6 });
    // The design's 16 for every other method is 2 + 6 + 6; V8 holds a JSON
    // string with any character past U+00FF at two bytes a character, so
    // the measured worst is 2 + 12 + 6 = 20 (test-e2e/page-budgets.spec.js).
    expect(DEFAULT_COPIES).toBe(24);
    expect(STREAM_BYTES).toEqual({ 'swarm:swarm_publishFiles': MiB });
    expect(VALUE_BYTES).toBe(128);
    // Main's own bookkeeping of every request (its record, context, promises
    // and IPC event), which the uploads' exact copies leave no room for.
    expect(REQUEST_BYTES).toBe(64 * KiB);
  });

  test('size times copies, 128 bytes for each value and name, the stream buffers, and main\'s bookkeeping', () => {
    const measured = { size: 1000, values: 10, names: 4 };
    const bookkeeping = 64 * KiB;
    expect(chargeOf('swarm', 'swarm_publishFiles', measured)).toBe(2 * 1000 + 128 * 14 + MiB + bookkeeping);
    expect(chargeOf('swarm', 'swarm_publishData', measured)).toBe(3 * 1000 + 128 * 14 + bookkeeping);
    expect(chargeOf('swarm', 'swarm_writeFeedEntry', measured)).toBe(6 * 1000 + 128 * 14 + bookkeeping);
    expect(chargeOf('ethereum', 'eth_call', measured)).toBe(24 * 1000 + 128 * 14 + bookkeeping);
    expect(chargeOf('swarm', '__proto__', measured)).toBe(24 * 1000 + 128 * 14 + bookkeeping);
    // Every request is charged at least the bookkeeping.
    expect(chargeOf('swarm', 'swarm_readChunk', { size: 0, values: 1, names: 0 })).toBe(128 + bookkeeping);
    // 10,000 near-empty values cost at least 1.2 MiB, and 2.4 MiB with a name each.
    expect(chargeOf('swarm', 'swarm_readChunk', { size: 0, values: 10000, names: 0 })).toBeGreaterThan(1.2 * MiB);
    expect(chargeOf('swarm', 'swarm_readChunk', { size: 0, values: 10000, names: 10000 })).toBeGreaterThan(2.4 * MiB);
  });

  test('what the numbers give: the budgets hold the largest uploads', () => {
    const files = largestChargeOf('swarm', 'swarm_publishFiles', 50 * MiB + 64 * KiB);
    const data = largestChargeOf('swarm', 'swarm_publishData', 10 * MiB + 64 * KiB);
    const entry = largestChargeOf('swarm', 'swarm_writeFeedEntry', 10 * MiB + 64 * KiB);
    const other = largestChargeOf('ethereum', 'eth_call', MiB);
    expect(files / MiB).toBeCloseTo(103.63, 2);
    expect(data / MiB).toBeCloseTo(32.69, 2);
    expect(entry / MiB).toBeCloseTo(62.88, 2);
    expect(other / MiB).toBeCloseTo(26.5, 2);
    // The largest feed entry is within a collection's: a document holds one,
    // and a window and the browser the two the browser runs at once.
    expect(entry).toBeLessThan(files);
    // A document holds one, with about 24 MiB to spare; a window the two the
    // browser runs at once; the browser those two and about 177 MiB more.
    expect((BUDGETS.document.bytes - files) / MiB).toBeCloseTo(24.4, 1);
    expect((BUDGETS.window.bytes - 2 * files) / MiB).toBeCloseTo(48.7, 1);
    expect((BUDGETS.browser.bytes - 2 * files) / MiB).toBeCloseTo(176.7, 1);
  });
});

describe('the ledger', () => {
  const requester = (guest, window, navigation = guest) => ({ guest, window, navigation, nonce: 'n', frame: 1 });

  test('a reservation for each method with a payload class, a feed entry\'s among them, from just over 1 MiB to its size', async () => {
    const INVALID = { error: { code: -32602, message: 'Invalid parameters' } };
    let n = 0;
    const budgets = createPageBudgets({ isCurrent: () => true, randomHex: () => `t${(n += 1)}` });
    const refusal = () => ({ error: { code: 4100 } });
    let guest = 0;
    const reserve = (method, bytes) => budgets.reserve(requester((guest += 1), 1), { method, bytes }, refusal);
    for (const [method, max] of [
      ['swarm_publishData', 10 * MiB + 64 * KiB],
      ['swarm_writeFeedEntry', 10 * MiB + 64 * KiB],
      ['swarm_publishFiles', 50 * MiB + 64 * KiB],
    ]) {
      expect(await reserve(method, MiB)).toEqual(INVALID);
      expect(await reserve(method, max + 1)).toEqual(INVALID);
      const small = await reserve(method, MiB + 1);
      const large = await reserve(method, max);
      expect([small, large]).toEqual([{ ticket: expect.any(String) }, { ticket: expect.any(String) }]);
      // Each holds the most a request of its size can be charged.
      const charges = Object.values(budgets.usage().documents).slice(-2).map((usage) => usage.bytes);
      expect(charges).toEqual([largestChargeOf('swarm', method, MiB + 1), largestChargeOf('swarm', method, max)]);
      for (const ticket of [small.ticket, large.ticket]) budgets.refuseTicket(budgets.burn(ticket));
    }
    // A method with no payload class takes no ticket, whatever its size.
    for (const method of ['swarm_updateFeed', 'swarm_publishChunk', 'eth_call']) {
      expect(await reserve(method, 2 * MiB)).toEqual(INVALID);
    }
    expect(budgets.usage()).toEqual(expect.objectContaining({ turns: 0, waiting: 0, tickets: 0, browser: { requests: 0, bytes: 0 } }));
  });

  test('a charge fits only while its document, its window and the browser all have room', () => {
    const budgets = createPageBudgets({
      budgets: {
        document: { requests: 3, bytes: 100 },
        window: { requests: 5, bytes: 150 },
        browser: { requests: 7, bytes: 200 },
      },
      isCurrent: () => true,
    });
    const a = requester(1, 1);
    const b = requester(2, 1);
    const c = requester(3, 2);
    const first = budgets.admit(a, 60);
    expect(first).not.toBeNull();
    expect(budgets.admit(a, 41)).toBeNull(); // the document's bytes
    const second = budgets.admit(a, 40);
    expect(budgets.admit(a, 0)).not.toBeNull();
    expect(budgets.admit(a, 0)).toBeNull(); // the document's count
    expect(budgets.admit(b, 51)).toBeNull(); // the window's bytes
    expect(budgets.admit(b, 50)).not.toBeNull();
    expect(budgets.admit(c, 51)).toBeNull(); // the browser's bytes
    expect(budgets.admit(c, 50)).not.toBeNull();
    expect(budgets.usage()).toEqual({
      browser: { requests: 5, bytes: 200 },
      windows: { 1: { requests: 4, bytes: 150 }, 2: { requests: 1, bytes: 50 } },
      documents: { '1:1': { requests: 3, bytes: 100 }, '2:2': { requests: 1, bytes: 50 }, '3:3': { requests: 1, bytes: 50 } },
      turns: 0,
      waiting: 0,
      tickets: 0,
    });
    budgets.release(first);
    budgets.release(first);
    budgets.release(second);
    expect(budgets.usage().documents['1:1']).toEqual({ requests: 1, bytes: 0 });
    expect(budgets.usage().browser).toEqual({ requests: 3, bytes: 100 });
    expect(budgets.admit(c, 100)).toBeNull(); // still the browser's
    expect(budgets.admit(c, 50)).not.toBeNull();
  });
});
