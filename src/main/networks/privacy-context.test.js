const { createPrivacyScope, getPrivacyContext } = require('./privacy-context');

const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const subject = { kind: 'public-address', principal: address, chainId: 11155111, role: 'rpc' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('privacy contexts', () => {
  let lifetime;
  let scope;
  beforeEach(() => {
    lifetime = new AbortController();
    scope = createPrivacyScope({ profileId: 'profile-a', signal: lifetime.signal });
  });
  afterEach(() => scope.close());

  test('canonical address/chain variants reuse opaque handles and random tokens', () => {
    const handle = scope.getContext(subject);
    expect(
      scope.getContext({
        ...subject,
        chainId: '11155111',
        principal: `0x${address.slice(2).toUpperCase()}`,
      })
    ).toBe(handle);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(Object.isFrozen(handle)).toBe(true);
    const context = getPrivacyContext(handle);
    expect(context.isolationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(context.isolationToken).not.toContain(address.slice(2));
    expect(context.requirements).toEqual({
      origin: 'tor',
      content: 'public',
      correctness: 'any',
      maxAgeMs: null,
    });
    expect(Object.isFrozen(context.requirements)).toBe(true);
  });

  test('accounts, chains, roles, operations, requirements and profiles have separate tokens', () => {
    const other = createPrivacyScope({ profileId: 'profile-b', signal: lifetime.signal });
    const handles = [
      scope.getContext(subject),
      scope.getContext({ ...subject, principal: `0x${'1'.repeat(40)}` }),
      scope.getContext({ ...subject, chainId: 1 }),
      scope.getContext({ ...subject, role: 'relayer' }),
      scope.getContext({ ...subject, operation: 'withdraw-1' }),
      scope.getContext(subject, { correctness: 'proof' }),
      other.getContext(subject),
    ];
    expect(new Set(handles.map((h) => getPrivacyContext(h).isolationToken)).size).toBe(
      handles.length
    );
    expect(() => scope.commit(handles.at(-1), () => {})).toThrow('another privacy session');
    other.close();
  });

  test('private protocol accounts require deployment and never reuse funding contexts', () => {
    const privateSubject = {
      ...subject,
      kind: 'private-account',
      principal: 'private-1',
      protocol: 'ppv2',
      deployment: 'v9',
    };
    const handle = scope.getContext(privateSubject);
    expect(handle).not.toBe(scope.getContext(subject));
    expect(handle).not.toBe(scope.getContext({ ...privateSubject, deployment: 'v10' }));
    expect(() => scope.getContext({ ...privateSubject, deployment: undefined })).toThrow(
      'protocol and deployment'
    );
  });

  test('rejects forged handles, wrong chains, invalid subjects and unknown protection requirements', () => {
    expect(() => getPrivacyContext({})).toThrow('Unknown privacy context');
    expect(() => getPrivacyContext(scope.getContext(subject), 1)).toThrow('another chain');
    expect(() => scope.getContext({ ...subject, principal: '0x123' })).toThrow(
      'Invalid privacy address'
    );
    expect(() => scope.getContext({ ...subject, chainId: true })).toThrow('Invalid privacy chain');
    expect(() => scope.getContext(null)).toThrow('Invalid privacy subject');
    expect(() => scope.getContext(subject, { origin: 'direct' })).toThrow(
      'Unsupported privacy requirements'
    );
    expect(() => scope.getContext(subject, { typo: 'tor' })).toThrow('Unknown privacy requirement');
    expect(() => scope.getContext(subject, { maxAgeMs: -1 })).toThrow(
      'Unsupported privacy requirements'
    );
  });

  test('lock revokes pending work promptly even if the dependency ignores abort', async () => {
    const handle = scope.getContext(subject);
    const pending = deferred();
    const task = jest.fn(() => pending.promise);
    const write = jest.fn();
    const work = scope.run(handle, task);
    await Promise.resolve();
    expect(task).toHaveBeenCalledWith(scope.signal);
    const rejected = expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    lifetime.abort();
    await rejected;
    pending.resolve('late result');
    await Promise.resolve();
    expect(() => scope.commit(handle, write)).toThrow('Privacy session ended');
    expect(write).not.toHaveBeenCalled();
    expect(() => scope.getContext(subject)).toThrow('Privacy session ended');
    expect(() => getPrivacyContext(handle)).toThrow('Privacy session ended');
  });

  test('a queued task never starts after close, and a completed result cannot commit after lock', async () => {
    const handle = scope.getContext(subject);
    const result = await scope.run(handle, () => 42);
    expect(scope.commit(handle, () => result)).toBe(42);
    const task = jest.fn();
    const work = scope.run(handle, task);
    const rejected = expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    scope.close();
    await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(() => scope.commit(handle, () => result)).toThrow('Privacy session ended');
  });

  test('late dependency rejection is consumed after cancellation', async () => {
    const pending = deferred();
    const work = scope.run(scope.getContext(subject), () => pending.promise);
    await Promise.resolve();
    const rejected = expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    scope.close();
    await rejected;
    pending.reject(new Error('late failure'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('a new generation never revives handles from a previous scope', () => {
    const handle = scope.getContext(subject);
    const old = getPrivacyContext(handle);
    scope.close();
    scope = createPrivacyScope({ profileId: 'profile-a', signal: lifetime.signal });
    const current = getPrivacyContext(scope.getContext(subject));
    expect(current.generation).not.toBe(old.generation);
    expect(current.isolationToken).not.toBe(old.isolationToken);
    expect(() => getPrivacyContext(handle)).toThrow('Privacy session ended');
  });

  test('bounds context allocation without evicting live contexts', () => {
    const first = scope.getContext({ ...subject, operation: '0' });
    for (let i = 1; i < 256; i += 1) scope.getContext({ ...subject, operation: String(i) });
    expect(() => scope.getContext({ ...subject, operation: 'overflow' })).toThrow('limit');
    expect(scope.getContext({ ...subject, operation: '0' })).toBe(first);
  });

  test('bounds queued tasks, releases capacity on completion, and preserves task rejection', async () => {
    const handle = scope.getContext(subject);
    const pending = deferred();
    const jobs = Array.from({ length: 32 }, () => scope.run(handle, () => pending.promise));
    expect(() => scope.run(handle, () => {})).toThrow('Privacy task limit');
    pending.resolve(1);
    await expect(Promise.all(jobs)).resolves.toEqual(Array(32).fill(1));
    await expect(scope.run(handle, () => Promise.reject(null))).rejects.toBeNull();
    await expect(scope.run(handle, () => 2)).resolves.toBe(2);
  });
});
