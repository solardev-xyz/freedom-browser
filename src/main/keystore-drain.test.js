/**
 * The drain of the forget file (freedom-core design 0013, "Forgetting an
 * item", PRF-2), with the helper and the subcommands given. The real
 * binary, killed at each step, is keystore.integration.test.js's.
 */

const fs = require('fs');
const path = require('path');

/**
 * freedom-core's helper-answer vectors (`vectors/keystore.json`, design 0013
 * "Vectors": "the helper's answers under a fixed request key, with the
 * refusals"), whose `answers` give the core's reading of each answer main
 * relays. Skipped unless found: FREEDOM_CORE_KEYSTORE_VECTORS names the
 * file, or it sits beside FREEDOM_CORE_VECTORS, or in the freedom-core
 * checkout FREEDOM_CORED_PATH was built in. CI checks out freedom-core's at
 * the reviewed commit and names it; a file named there that is missing
 * fails the suite rather than skipping it.
 */
function keystoreVectorsPath() {
  if (process.env.FREEDOM_CORE_KEYSTORE_VECTORS) return process.env.FREEDOM_CORE_KEYSTORE_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) {
    return path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'keystore.json');
  }
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'keystore.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}
const vectorsFile = keystoreVectorsPath();
const vectors =
  vectorsFile && fs.existsSync(vectorsFile)
    ? JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))
    : null;

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

describe("the helper's answer to a forget, read as the core reads it", () => {
  // A backslash, so the escapes below reach the parser as written.
  const BS = String.fromCharCode(92);
  const padded = (bytes) => `{"ok":true${' '.repeat(bytes - 11)}}`;

  test.each([
    ['ok', '{"ok":true}'],
    ["ok, with JSON's whitespace", ' { "ok" : true } '],
    ['not_found', '{"ok":false,"error":"not_found"}'],
    ['not_found, its members in another order', '{"error":"not_found","ok":false}'],
    ['not_found with a reason in form', '{"ok":false,"error":"not_found","reason":"gone_2"}'],
    ['a member name escaped, which the core decodes', `{"${BS}u006fk":true}`],
    ['not_found escaped, which the core decodes', `{"ok":false,"error":"not${BS}u005ffound"}`],
    ['4096 bytes', padded(4096)],
  ])('%s: forgotten', (_, line) => {
    expect(isForgotten(line)).toBe(true);
  });

  test.each([
    // Members named twice: JSON.parse keeps the last, the core refuses.
    ['backend, then not_found', '{"ok":false,"error":"backend","error":"not_found"}'],
    ['ok named twice', '{"ok":true,"ok":true}'],
    ['ok false, then true', '{"ok":false,"error":"denied","ok":true}'],
    ['not_found named twice', '{"ok":false,"error":"not_found","error":"not_found"}'],
    ['ok named twice, once escaped', `{"ok":true,"o${BS}u006b":true}`],
    // Unknown members.
    ['an unknown member beside ok', '{"ok":true,"unknown":1}'],
    ['an unknown string member beside ok', '{"ok":true,"extra":"x"}'],
    ['an unknown member beside not_found', '{"ok":false,"error":"not_found","extra":true}'],
    ['__proto__ beside ok', '{"ok":true,"__proto__":"x"}'],
    // Fields the kind doesn't have.
    ['an error beside ok', '{"ok":true,"error":"backend"}'],
    ['not_found beside ok', '{"ok":true,"error":"not_found"}'],
    ['a reason beside ok', '{"ok":true,"reason":"gone"}'],
    ['a key, as for an open', '{"ok":true,"key":"AAAA"}'],
    ['a blob, as for a Windows create', '{"ok":true,"sealed":"AAAA"}'],
    ['a key on not_found', '{"ok":false,"error":"not_found","key":"ciphertext"}'],
    ['a blob on not_found', '{"ok":false,"error":"not_found","sealed":"AAAA"}'],
    // Out of form.
    ['a reason in capitals', '{"ok":false,"error":"not_found","reason":"Gone"}'],
    ['an empty reason', '{"ok":false,"error":"not_found","reason":""}'],
    ['a reason of 33 bytes', `{"ok":false,"error":"not_found","reason":"${'a'.repeat(33)}"}`],
    ['a reason as null', '{"ok":false,"error":"not_found","reason":null}'],
    ['a reason as true', '{"ok":false,"error":"not_found","reason":true}'],
    ['a key as null', '{"ok":true,"key":null}'],
    ['ok as a string', '{"ok":"true"}'],
    ['ok as null', '{"ok":null}'],
    ['no ok', '{"error":"not_found"}'],
    ['a failure without an error', '{"ok":false}'],
    ['an empty object', '{}'],
    ['a trailing comma', '{"ok":true,}'],
    ['an object inside', '{"ok":true,"x":{"ok":true}}'],
    ['bytes after the object', '{"ok":true} x'],
    ['two objects', '{"ok":true}{"ok":true}'],
    ['4097 bytes', padded(4097)],
    // Other failures.
    ['unavailable', '{"ok":false,"error":"unavailable","reason":"no_keychain"}'],
    ['denied', '{"ok":false,"error":"denied"}'],
    ['backend', '{"ok":false,"error":"backend","reason":"status"}'],
    ['an array', '[{"ok":true}]'],
    ['null', 'null'],
    ['not JSON', 'ok'],
    ['nothing', ''],
  ])('%s: kept', (_, line) => {
    expect(isForgotten(line)).toBe(false);
  });

  test('anything but a line is kept', () => {
    expect(isForgotten(undefined)).toBe(false);
    expect(isForgotten(Buffer.from('{"ok":true}'))).toBe(false);
  });
});

/** Answers to another op that the core refuses only as not the kind the op
 * needs: as a forget's answer, each is a Done. */
const DONE_FOR_ANOTHER_OP = new Set(['done-to-create', 'done-to-open']);

/** Whether the core takes `answer`'s text, as a forget's answer, as gone. */
function goneAsTheCoreReads(answer) {
  if (answer.request.op === 'forget') return answer.outcome.done === true;
  return answer.outcome.error === 'not_found' || DONE_FOR_ANOTHER_OP.has(answer.id);
}

(process.env.FREEDOM_CORE_KEYSTORE_VECTORS ? test : test.skip)(
  'the vectors FREEDOM_CORE_KEYSTORE_VECTORS names are there',
  () => {
    expect(fs.existsSync(vectorsFile)).toBe(true);
    expect(vectors?.answers?.length).toBeGreaterThan(0);
  }
);

(vectors ? describe : describe.skip)("freedom-core's helper-answer vectors", () => {
  const answers = vectors?.answers ?? [];

  test('they hold the cases this reading rests on', () => {
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    for (const id of [
      'forget',
      'forget-not-found',
      'duplicate-ok-forget',
      'trailing-bytes',
      'key-to-forget',
      'unknown-member',
      'duplicate-error',
    ]) {
      expect(byId.has(id)).toBe(true);
    }
    for (const id of DONE_FOR_ANOTHER_OP) {
      expect(byId.get(id)).toMatchObject({
        text: '{"ok":true}',
        outcome: { reason: 'answer_form' },
      });
    }
  });

  test.each(answers.map((answer) => [answer.id, answer]))(
    '%s, as a forget answer, clears the record only where the core takes it as gone',
    (_, answer) => {
      expect(isForgotten(answer.text)).toBe(goneAsTheCoreReads(answer));
    }
  );
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

  test.each(['linux', 'win32'])(
    '%s: forget-list still runs, so the core drops foreign records, but no helper and no forget-done',
    async (platform) => {
      const runner = runnerOf({ [A]: '{"ok":true}', [B]: '{"ok":true}' });
      const subcommand = jest.fn(async () => ({ items: [] }));
      const log = quiet();
      // After a delete: no helper, no subcommand.
      await expect(
        forgetItems('/apps/Freedom', [{ policy: 'unattended', item: A }], {
          runner,
          subcommand,
          platform,
          log,
        })
      ).resolves.toEqual({ forgotten: 0, kept: 1 });
      expect(subcommand).not.toHaveBeenCalled();

      // The drain: forget-list, whose native list is empty here.
      await expect(
        drainForgetFile('/apps/Freedom', { runner, subcommand, platform, log })
      ).resolves.toEqual({ forgotten: 0, kept: 0 });
      expect(subcommand.mock.calls).toEqual([['forget-list', '/apps/Freedom', []]]);

      // Even if it listed some, no helper runs for them, and they stay.
      subcommand.mockClear();
      subcommand.mockResolvedValueOnce({ items: [{ policy: 'unattended', item: B }] });
      await expect(
        drainForgetFile('/apps/Freedom', { runner, subcommand, platform, log })
      ).resolves.toEqual({ forgotten: 0, kept: 1 });
      expect(subcommand.mock.calls).toEqual([['forget-list', '/apps/Freedom', []]]);
      expect(runner.run).not.toHaveBeenCalled();
    }
  );

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

  test.each(['linux', 'win32'])(
    "%s: profile open reported some: forget-list runs on the profile's app root, and no helper",
    async (platform) => {
      const runner = runnerOf({});
      const subcommand = jest.fn(async () => ({ items: [] }));
      await expect(
        drainAfterFirstWindow({
          resolver: resolverOf(1),
          runner,
          subcommand,
          platform,
          log: quiet(),
        })
      ).resolves.toEqual({ forgotten: 0, kept: 0 });
      expect(subcommand.mock.calls).toEqual([['forget-list', '/apps/Freedom', []]]);
      expect(runner.run).not.toHaveBeenCalled();
    }
  );

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
