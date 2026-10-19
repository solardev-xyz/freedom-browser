const { createPickTokenStore, TOKEN_TTL_MS } = require('./publish-pick-tokens');

describe('publish pick tokens', () => {
  let clock;
  let store;

  beforeEach(() => {
    clock = 1_000_000;
    store = createPickTokenStore({ now: () => clock });
  });

  const mintFile = (extra = {}) =>
    store.mint({ path: '/home/u/photo.png', kind: 'file', senderId: 7, ...extra });

  test('redeems once for the sender and kind that picked', () => {
    const token = mintFile();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.redeem(token, { kind: 'file', senderId: 7 })).toEqual({ path: '/home/u/photo.png' });
  });

  test('a token is single use', () => {
    const token = mintFile();
    store.redeem(token, { kind: 'file', senderId: 7 });
    expect(store.redeem(token, { kind: 'file', senderId: 7 })).toEqual({ error: 'invalid' });
  });

  test('a token expires after the TTL', () => {
    const token = mintFile();
    clock += TOKEN_TTL_MS - 1;
    const fresh = mintFile();
    clock += 1;
    expect(store.redeem(token, { kind: 'file', senderId: 7 })).toEqual({ error: 'invalid' });
    expect(store.redeem(fresh, { kind: 'file', senderId: 7 })).toEqual({ path: '/home/u/photo.png' });
  });

  test('another sender cannot redeem it, and the attempt spends it', () => {
    const token = mintFile();
    expect(store.redeem(token, { kind: 'file', senderId: 8 })).toEqual({ error: 'invalid' });
    expect(store.redeem(token, { kind: 'file', senderId: 7 })).toEqual({ error: 'invalid' });
  });

  test('a file token cannot publish a directory', () => {
    const token = mintFile();
    expect(store.redeem(token, { kind: 'directory', senderId: 7 })).toEqual({ error: 'invalid' });
  });

  test('a raw path or anything that is not a minted token is refused', () => {
    mintFile();
    for (const bogus of ['/home/u/photo.png', '~/.ssh', '', null, undefined, 42, {}]) {
      expect(store.redeem(bogus, { kind: 'file', senderId: 7 })).toEqual({ error: 'invalid' });
    }
  });

  test('revokeSender drops only that sender\'s tokens', () => {
    const mine = mintFile();
    const theirs = mintFile({ senderId: 9 });
    store.revokeSender(7);
    expect(store.redeem(mine, { kind: 'file', senderId: 7 })).toEqual({ error: 'invalid' });
    expect(store.redeem(theirs, { kind: 'file', senderId: 9 })).toEqual({ path: '/home/u/photo.png' });
  });

  test('expired tokens are swept, not kept forever', () => {
    mintFile();
    mintFile();
    clock += TOKEN_TTL_MS;
    mintFile();
    expect(store.size()).toBe(1);
  });

  test('mint refuses a missing path, unknown kind or sender', () => {
    expect(() => store.mint({ path: '', kind: 'file', senderId: 1 })).toThrow();
    expect(() => store.mint({ path: '/x', kind: 'socket', senderId: 1 })).toThrow();
    expect(() => store.mint({ path: '/x', kind: 'file' })).toThrow();
  });
});
