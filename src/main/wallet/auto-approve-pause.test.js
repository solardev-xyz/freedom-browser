// D12: "Always allow" pauses for a site while one of its payments is in
// Payments waiting. The predicate, against the list main serves.

const mockWaiting = jest.fn();
jest.mock('./intent-ipc', () => ({ waitingIntents: () => mockWaiting() }));
jest.mock('../logger', () => ({ warn: jest.fn() }));

const {
  admitAutoApprovedTransaction,
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

// Review of #788: two silent requests of a site sent together must not both
// pass the check before either payment is in the records.
describe('admitAutoApprovedTransaction', () => {
  const SITE = 'https://swap.example';

  test('one admission per site at a time: the site is paused until it is released', async () => {
    const release = await admitAutoApprovedTransaction(SITE);
    expect(release).toEqual(expect.any(Function));
    await expect(admitAutoApprovedTransaction(`${SITE}/trade`)).resolves.toBeNull();
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(true);
    // Other sites are not held up.
    const other = await admitAutoApprovedTransaction('https://other.example');
    expect(other).toEqual(expect.any(Function));
    other();

    release();
    release(); // twice is harmless
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(false);
    const again = await admitAutoApprovedTransaction(SITE);
    expect(again).toEqual(expect.any(Function));
    again();
  });

  test('two admissions started together: only the first is admitted', async () => {
    let read;
    mockWaiting.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          read = () => resolve([]);
        })
    );
    const first = admitAutoApprovedTransaction(SITE);
    const second = admitAutoApprovedTransaction(SITE);
    await expect(second).resolves.toBeNull();
    read();
    const release = await first;
    expect(release).toEqual(expect.any(Function));
    release();
  });

  test('a waiting payment, or records that cannot be read, admit nothing and hold nothing', async () => {
    mockWaiting.mockResolvedValueOnce([waiting(SITE)]);
    await expect(admitAutoApprovedTransaction(SITE)).resolves.toBeNull();
    mockWaiting.mockRejectedValueOnce(new Error('not loaded'));
    await expect(admitAutoApprovedTransaction(SITE)).resolves.toBeNull();
    await expect(transactionAutoApprovePaused(SITE)).resolves.toBe(false);
  });

  test('no site admits nothing', async () => {
    await expect(admitAutoApprovedTransaction('')).resolves.toBeNull();
    await expect(admitAutoApprovedTransaction(undefined)).resolves.toBeNull();
  });
});
