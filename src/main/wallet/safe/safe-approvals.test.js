/**
 * The Safe approvals main holds (freedom-core design 0012, APB-1c): one per
 * Safe for its send and one for its message, bound to the SafeTx's or the
 * SafeMessage's hash, no longer presented once its end is asked, and
 * forgotten once the core has ended it. A failed end counts only once the
 * core process that gave it has ended.
 */
const mockEnd = jest.fn(async () => ({}));
// The core process answering now (`coreProcess()`), and whether the one a
// mark names has ended since.
let mockProcess = { name: 'first' };
const mockProcessEnded = jest.fn(() => false);
jest.mock('../../core/vault-backend', () => ({
  vaultBackend: {
    approval: { end: (...args) => mockEnd(...args) },
    coreProcess: () => mockProcess,
    coreProcessEnded: (...args) => mockProcessEnded(...args),
  },
}));

const approvals = require('./safe-approvals');

const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });
const A = Object.freeze({ id: 'a'.repeat(32), page: null });
const B = Object.freeze({ id: 'b'.repeat(32), page: PAGE });
const HASH = '0x' + '11'.repeat(32);
const OTHER = '0x' + '22'.repeat(32);

beforeEach(() => {
  approvals._reset({ retryDelays: [0, 0] });
  mockEnd.mockReset().mockResolvedValue({});
  mockProcess = { name: 'first' };
  mockProcessEnded.mockReset().mockReturnValue(false);
});

const failure = (code = 'busy') => Object.assign(new Error('not now'), { code });

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

test('ended: not presented from the call on, forgotten once the core answers, and only for the SafeTx named', async () => {
  await approvals.hold('message', 5, B, HASH);
  await approvals.end('message', 5, OTHER);
  expect(mockEnd).not.toHaveBeenCalled();
  let release;
  mockEnd.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
  let ended = false;
  const ending = approvals.end('message', 5, HASH).then(() => (ended = true));
  expect(approvals.held('message', 5, HASH)).toBeNull();
  // Another end of it meanwhile shares the one in flight.
  const again = approvals.end('message', 5, HASH);
  await new Promise((resolve) => setImmediate(resolve));
  expect(ended).toBe(false);
  release({});
  await Promise.all([ending, again]);
  expect(mockEnd).toHaveBeenCalledTimes(1);
  expect(mockEnd).toHaveBeenCalledWith(B.id, PAGE);
  expect(approvals.held('message', 5, HASH)).toBeNull();
});

// Review of #1245, round 1: a failed `approval.end` is no proof the
// approval is gone, unless the core process that gave it has ended.
describe("approval.end's failures", () => {
  test("{} is an end: one already ended, or one the core doesn't know", async () => {
    await approvals.hold('send', 5, A, HASH);
    mockEnd.mockResolvedValueOnce({});
    await expect(approvals.end('send', 5)).resolves.toBeUndefined();
    await expect(approvals.release(B)).resolves.toBeUndefined();
    expect(mockProcessEnded).not.toHaveBeenCalled();
  });

  test('the core process that gave it has ended (a restart): an end, asked of no other', async () => {
    const mark = mockProcess;
    await approvals.hold('send', 5, A, HASH);
    mockProcess = { name: 'second' };
    mockEnd.mockRejectedValueOnce(failure('core_unavailable'));
    mockProcessEnded.mockImplementation((asked) => asked === mark);
    await expect(approvals.end('send', 5)).resolves.toBeUndefined();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockProcessEnded).toHaveBeenCalledWith(mark);
    expect(approvals.held('send', 5, HASH)).toBeNull();
    // None answered when main held it: its process is no proof of anything
    // still running.
    mockProcess = null;
    await approvals.hold('send', 5, A, HASH);
    mockEnd.mockRejectedValueOnce(failure('core_unavailable'));
    mockProcessEnded.mockImplementation((asked) => asked === null);
    await expect(approvals.end('send', 5)).resolves.toBeUndefined();
  });

  test('any other failure is asked again, and then fails: the approval held again, and presented again', async () => {
    await approvals.hold('send', 5, A, HASH);
    mockEnd.mockRejectedValue(failure('busy'));
    const err = await approvals.end('send', 5, HASH).catch((e) => e);
    expect(err).toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED', cause: expect.objectContaining({ code: 'busy' }) });
    expect(mockEnd).toHaveBeenCalledTimes(3);
    expect(approvals.held('send', 5, HASH)).toEqual(A);
    // A failure that passes is an end.
    mockEnd.mockReset().mockRejectedValueOnce(failure('busy')).mockResolvedValueOnce({});
    await expect(approvals.end('send', 5, HASH)).resolves.toBeUndefined();
    expect(mockEnd).toHaveBeenCalledTimes(2);
    expect(approvals.held('send', 5, HASH)).toBeNull();
  });

  test('a throw before the request is sent is a failure too', async () => {
    await approvals.hold('message', 5, B, HASH);
    mockEnd.mockImplementation(() => {
      throw failure('invalid_argument');
    });
    await expect(approvals.end('message', 5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(approvals.held('message', 5, HASH)).toEqual(B);
  });

  test('one never held fails the same way; nothing else to keep', async () => {
    mockEnd.mockRejectedValue(failure());
    await expect(approvals.release(B)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    await expect(approvals.release({ id: 'not-an-id', page: null })).resolves.toBeUndefined();
    expect(mockEnd).toHaveBeenCalledTimes(3);
  });

  test("an older one whose end fails: the newer isn't held, the older stays", async () => {
    await approvals.hold('send', 5, B, HASH);
    mockEnd.mockRejectedValue(failure());
    await expect(approvals.hold('send', 5, A, OTHER)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(approvals.held('send', 5, HASH)).toEqual(B);
    expect(approvals.held('send', 5, OTHER)).toBeNull();
  });

  test("a deleted Safe's: both asked, and one failing fails the deletion", async () => {
    await approvals.hold('send', 5, A, HASH);
    await approvals.hold('message', 5, B, OTHER);
    mockEnd.mockImplementation(async (id) => {
      if (id === B.id) throw failure();
      return {};
    });
    await expect(approvals.endSafe(5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(approvals.held('send', 5, HASH)).toBeNull();
    expect(approvals.held('message', 5, OTHER)).toEqual(B);
  });
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
  expect(approvals.held('send', 5, HASH)).toBeNull();
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
