/**
 * The drain of the forget file (freedom-core design 0013, "Forgetting an
 * item", PRF-2), with the helper and the subcommands given. The real
 * binary, killed at each step, is keystore.integration.test.js's.
 */

const fs = require('fs');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: true } }), { virtual: true });
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('./core/cored-binary', () => ({ getCoredBinaryPath: () => '/bin/freedom-cored' }));
jest.mock('./profile-subcommands', () => ({ run: jest.fn() }));

const subcommands = require('./profile-subcommands');
const {
  drainAfterFirstWindow,
  drainForgetFile,
  forgetItems,
  isForgotten,
  itemsInForm,
} = require('./keystore-drain');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const quiet = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const forgetRequest = (item, policy = 'unattended') => ({
  op: 'forget',
  policy,
  item,
  replyKey: undefined,
  reason: undefined,
});

/** A runner answering each item's forget with `answers[item]`: a line, or an
 * error to throw. */
function runnerOf(answers) {
  return {
    run: jest.fn(async (request) => {
      const answer = answers[request.item];
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

beforeEach(() => {
  subcommands.run.mockReset();
});

describe("the helper's answer to a forget", () => {
  test.each([
    ['ok', '{"ok":true}', true],
    ['not_found', '{"ok":false,"error":"not_found"}', true],
    ['not_found with a reason', '{"ok":false,"error":"not_found","reason":"gone"}', true],
    ['unavailable', '{"ok":false,"error":"unavailable","reason":"no_keychain"}', false],
    ['denied', '{"ok":false,"error":"denied"}', false],
    ['backend', '{"ok":false,"error":"backend","reason":"status"}', false],
    ['a key, as for an open', '{"ok":true,"key":"AAAA"}', false],
    ['a blob, as for a Windows create', '{"ok":true,"sealed":"AAAA"}', false],
    ['ok as a string', '{"ok":"true"}', false],
    ['no ok', '{"error":"not_found"}', false],
    ['an array', '[{"ok":true}]', false],
    ['null', 'null', false],
    ['not JSON', 'ok', false],
  ])('%s: forgotten %s', (_, line, expected) => {
    expect(isForgotten(line)).toBe(expected);
  });
});

describe('the items main forgets', () => {
  test('those in form, each once', () => {
    expect(
      itemsInForm([
        { policy: 'unattended', item: A },
        { policy: 'user_presence', item: B },
        { policy: 'unattended', item: A },
        { policy: 'unattended', item: 'A'.repeat(32) },
        { policy: 'biometry', item: C },
        { item: C },
        null,
        'x',
      ])
    ).toEqual([forgetRequest(A), forgetRequest(B, 'user_presence')]);
    expect(itemsInForm(undefined)).toEqual([]);
    expect(itemsInForm({ policy: 'unattended', item: A })).toEqual([]);
  });
});

describe('forgetting a list', () => {
  test('a forget for each item, then forget-done for those gone: ok and not_found', async () => {
    const runner = runnerOf({
      [A]: '{"ok":true}',
      [B]: '{"ok":false,"error":"unavailable","reason":"timeout"}',
      [C]: '{"ok":false,"error":"not_found"}',
    });
    const subcommand = jest.fn(async () => ({ removed: 2 }));
    const listed = [A, B, C].map((item) => ({ policy: 'unattended', item }));
    await expect(
      forgetItems('/apps/Freedom', listed, { runner, subcommand, platform: 'darwin', log: quiet() })
    ).resolves.toEqual({ forgotten: 2, kept: 1 });
    expect(runner.run.mock.calls).toEqual([
      [forgetRequest(A)],
      [forgetRequest(B)],
      [forgetRequest(C)],
    ]);
    expect(subcommand).toHaveBeenCalledTimes(1);
    expect(subcommand).toHaveBeenCalledWith('forget-done', '/apps/Freedom', [
      '--item',
      A,
      '--item',
      C,
    ]);
  });

  test('a helper that failed, timed out or was killed keeps the record', async () => {
    const log = quiet();
    const runner = runnerOf({
      [A]: Object.assign(new Error('timeout'), { code: 'timeout' }),
      [B]: Object.assign(new Error('internal'), { code: 'internal' }),
    });
    const subcommand = jest.fn();
    const listed = [A, B].map((item) => ({ policy: 'unattended', item }));
    await expect(
      forgetItems('/apps/Freedom', listed, { runner, subcommand, platform: 'darwin', log })
    ).resolves.toEqual({ forgotten: 0, kept: 2 });
    expect(subcommand).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('record stays'), {
      code: 'timeout',
    });
  });

  test('the steps, in order: each helper, then forget-done', async () => {
    const order = [];
    const runner = {
      run: jest.fn(async (request) => {
        order.push(['helper', request.item]);
        return '{"ok":true}';
      }),
    };
    const subcommand = jest.fn(async (sub) => order.push([sub]));
    const step = jest.fn(async (name, detail) => order.push([name, detail]));
    await forgetItems(
      '/apps/Freedom',
      [A, B].map((item) => ({ policy: 'unattended', item })),
      { runner, subcommand, step, platform: 'darwin', log: quiet() }
    );
    expect(order).toEqual([
      ['before-helper', A],
      ['helper', A],
      ['before-helper', B],
      ['helper', B],
      ['before-forget-done', [A, B]],
      ['forget-done'],
    ]);
  });

  test.each(['linux', 'win32'])('nothing runs on %s', async (platform) => {
    const runner = runnerOf({ [A]: '{"ok":true}' });
    const subcommand = jest.fn();
    await expect(
      forgetItems('/apps/Freedom', [{ policy: 'unattended', item: A }], {
        runner,
        subcommand,
        platform,
      })
    ).resolves.toEqual({ forgotten: 0, kept: 0 });
    await expect(
      drainForgetFile('/apps/Freedom', { runner, subcommand, platform })
    ).resolves.toEqual({
      forgotten: 0,
      kept: 0,
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(subcommand).not.toHaveBeenCalled();
  });

  test('no items: no forget-done', async () => {
    const runner = runnerOf({});
    const subcommand = jest.fn();
    await forgetItems('/apps/Freedom', [], {
      runner,
      subcommand,
      platform: 'darwin',
      log: quiet(),
    });
    expect(subcommand).not.toHaveBeenCalled();
  });
});

describe('draining the forget file', () => {
  test('forget-list, the helper for each item, then forget-done', async () => {
    const runner = runnerOf({ [A]: '{"ok":true}', [B]: '{"ok":false,"error":"not_found"}' });
    const subcommand = jest.fn(async (sub) =>
      sub === 'forget-list'
        ? {
            items: [
              { policy: 'unattended', item: A },
              { policy: 'user_presence', item: B },
            ],
          }
        : { removed: 2 }
    );
    await expect(
      drainForgetFile('/apps/Freedom', { runner, subcommand, platform: 'darwin', log: quiet() })
    ).resolves.toEqual({ forgotten: 2, kept: 0 });
    expect(subcommand.mock.calls).toEqual([
      ['forget-list', '/apps/Freedom', []],
      ['forget-done', '/apps/Freedom', ['--item', A, '--item', B]],
    ]);
    expect(runner.run.mock.calls).toEqual([
      [forgetRequest(A)],
      [forgetRequest(B, 'user_presence')],
    ]);
  });

  test('the subcommands run on the bundled freedom-cored, with the app root', async () => {
    subcommands.run
      .mockResolvedValueOnce({ result: { items: [{ policy: 'unattended', item: A }] } })
      .mockResolvedValueOnce({ result: { removed: 1 } });
    const runner = runnerOf({ [A]: '{"ok":true}' });
    await drainForgetFile('/apps/Freedom', { runner, platform: 'darwin', log: quiet() });
    expect(subcommands.run.mock.calls).toEqual([
      ['/bin/freedom-cored', ['profile', 'forget-list', '--app-root', '/apps/Freedom']],
      [
        '/bin/freedom-cored',
        ['profile', 'forget-done', '--app-root', '/apps/Freedom', '--item', A],
      ],
    ]);
  });
});

describe('the drain at start, after the first window', () => {
  const catalogProfile = { id: 'home', source: 'catalog', appRoot: '/apps/Freedom' };
  const resolverOf = (forgetPending, profile = catalogProfile) => ({
    getProfileLaunchReport: () => ({ forgetPending }),
    getActiveProfile: () => profile,
  });

  test.each([
    ['none pending', 0, catalogProfile],
    ['the JS backend', null, catalogProfile],
    ['a profile outside the catalog', 3, { id: 't', source: 'profile-dir' }],
  ])('%s: nothing runs', async (_, pending, profile) => {
    const subcommand = jest.fn();
    await expect(
      drainAfterFirstWindow({
        resolver: resolverOf(pending, profile),
        subcommand,
        platform: 'darwin',
        log: quiet(),
      })
    ).resolves.toBeNull();
    expect(subcommand).not.toHaveBeenCalled();
  });

  test("profile open reported some: the active profile's app root is drained", async () => {
    const runner = runnerOf({ [A]: '{"ok":true}' });
    const subcommand = jest.fn(async (sub) =>
      sub === 'forget-list' ? { items: [{ policy: 'unattended', item: A }] } : { removed: 1 }
    );
    await expect(
      drainAfterFirstWindow({
        resolver: resolverOf(1),
        runner,
        subcommand,
        platform: 'darwin',
        log: quiet(),
      })
    ).resolves.toEqual({ forgotten: 1, kept: 0 });
    expect(subcommand.mock.calls[0]).toEqual(['forget-list', '/apps/Freedom', []]);
  });

  test('a failure is logged, never thrown', async () => {
    const log = quiet();
    const subcommand = jest.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    });
    await expect(
      drainAfterFirstWindow({ resolver: resolverOf(1), subcommand, platform: 'darwin', log })
    ).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('forget file'), { code: 'busy' });
  });

  test("index.js runs it once, in the first window's ready-to-show, never on the startup path", () => {
    const code = fs
      .readFileSync(path.join(__dirname, 'index.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const calls = [...code.matchAll(/\bdrainAfterFirstWindow\(/g)];
    expect(calls).toHaveLength(1);
    const handler = code.lastIndexOf("mainWindow.once('ready-to-show', () => {", calls[0].index);
    expect(handler).toBeGreaterThan(-1);
    // No line between them closes the handler.
    expect(code.slice(handler, calls[0].index)).not.toMatch(/^\s*\}\);\s*$/m);
    expect(code.slice(calls[0].index - 5, calls[0].index)).toBe('void ');
  });
});
