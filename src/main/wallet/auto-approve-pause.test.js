// D12: "Always allow" pauses for a site while one of its payments is in
// Payments waiting. The predicate, against the list main serves.

const mockWaiting = jest.fn();
jest.mock('./intent-ipc', () => ({ waitingIntents: () => mockWaiting() }));
jest.mock('../logger', () => ({ warn: jest.fn() }));

const {
  sitePaymentWaiting,
  takeSiteTurn,
  transactionAutoApprovePaused,
} = require('./auto-approve-pause');

const waiting = (origin, overrides = {}) => ({
  intentId: `intent-${origin}`,
  kind: origin ? 'dapp-send' : 'wallet-send',
  origin,
  receipt: null,
  ...overrides,
});

beforeEach(() => {
  mockWaiting.mockReset().mockResolvedValue([]);
});

describe('transactionAutoApprovePaused', () => {
  test("a site's payment in Payments waiting pauses that site only", async () => {
    mockWaiting.mockResolvedValue([waiting('https://swap.example')]);
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('https://other.example')).resolves.toBe(false);
  });

  test('nothing waiting, or only payments no site requested: nothing paused', async () => {
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(false);
    mockWaiting.mockResolvedValue([waiting(null), waiting(undefined)]);
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(false);
  });

  test("sites compare as permission keys: the page's path and the name's case don't matter", async () => {
    mockWaiting.mockResolvedValue([waiting('https://swap.example'), waiting('vitalik.eth')]);
    await expect(transactionAutoApprovePaused('https://swap.example/trade')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('ens://VITALIK.ETH/#/app')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('https://swap.example.evil')).resolves.toBe(false);
  });

  test("records that can't be read pause it: asking is the safe reading", async () => {
    mockWaiting.mockRejectedValue(
      Object.assign(new Error("The wallet's payment records are not loaded."), {
        code: 'INTENT_STORE_UNAVAILABLE',
      })
    );
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(true);
  });

  test('no site, nothing to pause, and the records are not read', async () => {
    for (const origin of [undefined, null, '', 42]) {
      await expect(transactionAutoApprovePaused(origin)).resolves.toBe(false);
    }
    expect(mockWaiting).not.toHaveBeenCalled();
  });
});

// Review of #788: no payment of a site may be committed between a silent
// send's reading of Payments waiting and its own commit. A site's dApp
// sends take turns, from before that reading until each one's commit.
describe("a site's turns", () => {
  const SITE = 'https://swap.example';
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('one send of a site at a time, in order; other sites are not held up', async () => {
    const order = [];
    const first = await takeSiteTurn(SITE);
    const second = takeSiteTurn(`${SITE}/trade`).then((leave) => {
      order.push('second');
      return leave;
    });
    const third = takeSiteTurn(SITE).then((leave) => {
      order.push('third');
      return leave;
    });
    const other = await takeSiteTurn('https://other.example');
    await flush();
    expect(order).toEqual([]);

    first();
    first(); // leaving twice is harmless: the queue still counts the others
    (await second)();
    const lastLeave = await third;
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(true);
    lastLeave();
    expect(order).toEqual(['second', 'third']);
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(false);
    other();
  });

  test('the site reads as paused while one of its sends is queued or under way', async () => {
    const leave = await takeSiteTurn(SITE);
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('https://other.example')).resolves.toBe(false);
    leave();
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(false);
  });

  test("in its turn, a send reads only the records: its own turn doesn't pause it", async () => {
    const leave = await takeSiteTurn(SITE);
    await expect(sitePaymentWaiting(SITE)).resolves.toBe(false);
    mockWaiting.mockResolvedValueOnce([waiting(SITE)]);
    await expect(sitePaymentWaiting(`${SITE}/trade`)).resolves.toBe(true);
    mockWaiting.mockRejectedValueOnce(new Error('not loaded'));
    await expect(sitePaymentWaiting(SITE)).resolves.toBe(true);
    leave();
  });

  test('no site: no turn to wait for, nothing waiting', async () => {
    const leave = await takeSiteTurn('');
    leave();
    await expect(sitePaymentWaiting(undefined)).resolves.toBe(false);
    expect(mockWaiting).not.toHaveBeenCalled();
  });
});
