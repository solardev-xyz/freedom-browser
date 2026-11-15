const { keyStoreMessage } = require('./key-store-messages');

// cored 0.17.0's reasons and kinds (freedom-core #385; fc-keystore's
// UnavailableReason, secrets.rs's io kinds).
const REASONS = [
  'timeout',
  'closed',
  'no_executor',
  'unsupported',
  'no_keychain',
  'read_only',
  'not_found',
  'invalidated',
  'entry_refused',
  'denied',
  'forget_backlog',
  'backend',
];
const KINDS = ['malformed', 'not_regular', 'permission', 'no_space', 'other'];

describe('keyStoreMessage', () => {
  test('each reason has its own message', () => {
    const messages = REASONS.map((reason) => keyStoreMessage('key_store_unavailable', { reason }));
    for (const message of messages) expect(message).toEqual(expect.any(String));
    expect(new Set(messages).size).toBe(REASONS.length);
  });

  test('each storage kind of the secrets file has its own message, naming the file', () => {
    const messages = KINDS.map((kind) => keyStoreMessage('storage', { kind, file: 'secrets' }));
    for (const message of messages) expect(message).toContain('secrets.json');
    expect(new Set(messages).size).toBe(KINDS.length);
  });

  test('a way forward in each: what to do next', () => {
    const all = [
      ...REASONS.map((reason) => keyStoreMessage('key_store_unavailable', { reason })),
      ...KINDS.map((kind) => keyStoreMessage('storage', { kind, file: 'secrets' })),
      keyStoreMessage('key_store_cancelled'),
    ];
    for (const message of all) {
      expect(message).toMatch(/try again|contact support|instead|restore|move/i);
    }
  });

  test('a damaged file: support, or moving it aside with the password ready', () => {
    const message = keyStoreMessage('storage', { kind: 'malformed', file: 'secrets' });
    expect(message).toMatch(/damaged/);
    expect(message).toMatch(/Contact support/);
    expect(message).toMatch(/move the file out/);
    expect(message).toMatch(/password or recovery phrase/);
  });

  test('an unknown reason or kind falls back; inherited names are unknown', () => {
    const backend = keyStoreMessage('key_store_unavailable', { reason: 'backend' });
    for (const reason of ['helper', 'shell_error', 'constructor', '__proto__', undefined]) {
      expect(keyStoreMessage('key_store_unavailable', { reason })).toBe(backend);
    }
    expect(keyStoreMessage('key_store_unavailable')).toBe(backend);
    const other = keyStoreMessage('storage', { kind: 'other', file: 'secrets' });
    for (const kind of ['toString', 'weird', undefined]) {
      expect(keyStoreMessage('storage', { kind, file: 'secrets' })).toBe(other);
    }
  });

  test('anything else keeps the core message', () => {
    expect(keyStoreMessage('storage', { kind: 'malformed' })).toBeNull();
    expect(keyStoreMessage('storage', { kind: 'malformed', file: 'vault' })).toBeNull();
    expect(keyStoreMessage('storage')).toBeNull();
    expect(keyStoreMessage('incorrect_password', { reason: 'timeout' })).toBeNull();
    expect(keyStoreMessage('not_found')).toBeNull();
  });
});
