/**
 * The Safe approvals main holds (freedom-core design 0012, APB-1c): one per
 * Safe for its send and one for its message, bound to the SafeTx's or the
 * SafeMessage's hash, forgotten at once when ended and ended in the core.
 */
const mockEnd = jest.fn(async () => ({}));
jest.mock('../../core/vault-backend', () => ({
  vaultBackend: { approval: { end: (...args) => mockEnd(...args) } },
}));

const approvals = require('./safe-approvals');

const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });
const A = Object.freeze({ id: 'a'.repeat(32), page: null });
const B = Object.freeze({ id: 'b'.repeat(32), page: PAGE });
const HASH = '0x' + '11'.repeat(32);
const OTHER = '0x' + '22'.repeat(32);

beforeEach(() => {
  approvals._reset();
  mockEnd.mockReset().mockResolvedValue({});
});

test('held for its SafeTx only, per Safe and kind', async () => {
  await approvals.hold('send', 5, A, HASH);
  expect(approvals.held('send', 5, HASH)).toEqual(A);
  expect(approvals.held('send', 5, OTHER)).toBeNull();
  expect(approvals.held('message', 5, HASH)).toBeNull();
  expect(approvals.held('send', 6, HASH)).toBeNull();
  expect(mockEnd).not.toHaveBeenCalled();
});

test("a new one for the Safe's slot ends the older one first, under its own holder", async () => {
  await approvals.hold('send', 5, B, HASH);
  await approvals.hold('send', 5, A, OTHER);
  expect(mockEnd).toHaveBeenCalledWith(B.id, PAGE);
  expect(approvals.held('send', 5, OTHER)).toEqual(A);
});

test('ended: forgotten before the core answers, and only for the SafeTx named', async () => {
  await approvals.hold('message', 5, B, HASH);
  await approvals.end('message', 5, OTHER);
  expect(mockEnd).not.toHaveBeenCalled();
  let release;
  mockEnd.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
  const ending = approvals.end('message', 5, HASH);
  expect(approvals.held('message', 5, HASH)).toBeNull();
  release({});
  await ending;
  expect(mockEnd).toHaveBeenCalledWith(B.id, PAGE);
});

test('never rejects: the core gone, or the approval gone', async () => {
  await approvals.hold('send', 5, A, HASH);
  mockEnd.mockRejectedValueOnce(new Error('core gone'));
  await expect(approvals.end('send', 5)).resolves.toBeUndefined();
  await expect(approvals.release(B)).resolves.toBeUndefined();
  await expect(approvals.release({ id: 'not-an-id', page: null })).resolves.toBeUndefined();
  expect(mockEnd).toHaveBeenCalledTimes(2);
});

test('forgotten without the core (one it no longer knows); a Safe deleted ends both', async () => {
  await approvals.hold('send', 5, A, HASH);
  approvals.forget('send', 5, OTHER);
  expect(approvals.held('send', 5, HASH)).toEqual(A);
  approvals.forget('send', 5, HASH);
  expect(approvals.held('send', 5, HASH)).toBeNull();
  expect(mockEnd).not.toHaveBeenCalled();
  await approvals.hold('send', 5, A, HASH);
  await approvals.hold('message', 5, B, OTHER);
  const ending = approvals.endSafe(5);
  expect(approvals.held('send', 5, HASH)).toBeNull();
  expect(approvals.held('message', 5, OTHER)).toBeNull();
  await ending;
  expect(mockEnd.mock.calls).toEqual([
    [A.id, null],
    [B.id, PAGE],
  ]);
});

test('only an approval the core gave is held', async () => {
  for (const bad of [null, {}, { id: 'A'.repeat(32), page: null }, { id: 'a'.repeat(31), page: null }, { id: A.id, page: {} }]) {
    expect(approvals.isApproval(bad)).toBe(false);
    await expect(approvals.hold('send', 5, bad, HASH)).rejects.toThrow(/Not a Safe approval/);
  }
  await expect(approvals.hold('send', 5, A, '')).rejects.toThrow(/held for its SafeTx/);
  expect(() => approvals.held('other', 5, HASH)).toThrow(/Not a Safe approval kind/);
});
