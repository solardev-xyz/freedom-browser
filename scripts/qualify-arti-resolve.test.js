const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  writeConfig,
  check,
  qualifies,
  parseVersion,
  verdict,
  artiCommand,
  isolation,
  retrying,
  shuffled,
  exitAddress,
  qualify,
  ISOLATION_SETS,
  ISOLATION_ROUNDS,
  ISOLATION_SWITCHES,
  ECHO_MAX_BYTES,
} = require('./qualify-arti-resolve');
const { PINNED_ARTI_VERSION } = require('./fetch-arti');

/**
 * A stand-in Arti in `dir`, a Node script run through `process.execPath`
 * (qualify()'s launcher seam), so it starts on Windows too: `--version`
 * prints `versionLine`, or fails when it's `null`; `proxy -c <config>`
 * serves SOCKS5 on the config's port (any one method, RFC 1929 accepted,
 * `RESOLVE` answering 93.184.215.14, `CONNECT` succeeding) and says it
 * bootstrapped. With `failFirstPassword`, a `RESOLVE` under the first
 * password it saw fails (reply 0x01), as a failing exit on that
 * credentials' isolated circuit would, every time.
 *
 * A `CONNECT` to `echo.test` is the echo service: it answers an HTTP `GET`
 * with the connection's exit, as JSON. `exits` says which: one per
 * password (`credentials`, isolation as Arti does it), the same for every
 * connection (`one`, no isolation), a new one for every connection
 * (`every`, no circuit kept), or, blind to the credentials, one exit for
 * `n` connections in a row and then the next (`blind:<n>`), as a proxy
 * that reuses a circuit a while and then rotates it would. `migrate` is one
 * per password too, but the first password moves to a new exit after its
 * third connection, as Arti can move a set to a new circuit.
 */
function fakeArti(dir, versionLine, { failFirstPassword = false, exits = 'credentials' } = {}) {
  const script = `const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  const line = ${JSON.stringify(versionLine)};
  if (line === null) process.exit(1);
  console.log(line);
  process.exit(0);
}
const config = fs.readFileSync(args[args.indexOf('-c') + 1], 'utf-8');
const port = Number(/socks_listen = (\\d+)/.exec(config)[1]);
const failFirstPassword = ${JSON.stringify(failFirstPassword)};
const exits = ${JSON.stringify(exits)};
let firstPassword = null;
const passwords = [];
let connections = 0;
const seen = [];
const exitOf = (password) => {
  connections += 1;
  if (exits === 'one') return '198.51.100.1';
  if (exits === 'every') return '198.51.100.' + connections;
  if (exits === 'migrate') {
    if (!passwords.includes(password)) passwords.push(password);
    const set = passwords.indexOf(password);
    seen[set] = (seen[set] || 0) + 1;
    return set === 0 && seen[set] > 3 ? '198.51.100.200' : '198.51.100.' + (set + 1);
  }
  if (exits.startsWith('blind:')) {
    return '198.51.100.' + (Math.floor((connections - 1) / Number(exits.slice(6))) + 1);
  }
  if (!passwords.includes(password)) passwords.push(password);
  return '198.51.100.' + (passwords.indexOf(password) + 1);
};
net
  .createServer((socket) => {
    let phase = 'greeting';
    let password = null;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (phase === 'greeting') {
        const method = chunk[2];
        socket.write(Buffer.from([5, method]));
        phase = method === 2 ? 'authentication' : 'request';
      } else if (phase === 'authentication') {
        const userLength = chunk[1];
        password = chunk.subarray(3 + userLength, 3 + userLength + chunk[2 + userLength]).toString();
        if (firstPassword === null) firstPassword = password;
        socket.write(Buffer.from([1, 0]));
        phase = 'request';
      } else if (phase === 'echo') {
        const body = JSON.stringify({ IsTor: true, IP: exitOf(password) });
        socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body);
      } else if (chunk[1] === 0x01 && chunk[3] === 0x03 && chunk.subarray(5, 5 + chunk[4]).toString() === 'echo.test') {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        phase = 'echo';
      } else if (chunk[1] === 0xf0 && failFirstPassword && password !== null && password === firstPassword) {
        socket.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      } else if (chunk[1] === 0xf0) {
        socket.end(Buffer.from([5, 0, 0, 1, 93, 184, 215, 14, 0, 0]));
      } else {
        socket.end(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  })
  .listen(port, '127.0.0.1', () => console.log('INFO arti: Sufficiently bootstrapped; system SOCKS proxy ready.'));
`;
  const artiPath = path.join(dir, 'fake-arti.js');
  fs.writeFileSync(artiPath, script);
  return artiPath;
}

describe('qualify-arti-resolve', () => {
  test('arguments default to a known name and a 3-minute bootstrap', () => {
    expect(parseArgs([])).toEqual({
      arti: null,
      name: 'example.com',
      bootstrapTimeoutMs: 180000,
      requireCredentials: false,
      isolation: false,
      echoUrl: 'https://check.torproject.org/api/ip',
      allowRoot: false,
    });
    expect(
      parseArgs([
        '--arti',
        '/opt/arti',
        '--name',
        'torproject.org',
        '--bootstrap-timeout-ms',
        '5000',
        '--require-credentials',
        '--isolation',
        '--echo-url',
        'https://echo.example/ip',
        '--allow-root',
      ])
    ).toEqual({
      arti: '/opt/arti',
      name: 'torproject.org',
      bootstrapTimeoutMs: 5000,
      requireCredentials: true,
      isolation: true,
      echoUrl: 'https://echo.example/ip',
      allowRoot: true,
    });
    expect(() => parseArgs(['--unknown'])).toThrow('unknown argument');
  });

  test("the config pins the SOCKS port and keeps state and cache in its own directory, as the app's does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-qualify-test-'));
    try {
      const configPath = writeConfig(dir, 9151);
      const toml = fs.readFileSync(configPath, 'utf-8');
      expect(toml).toContain('socks_listen = 9151');
      expect(toml).toContain(`cache_dir = ${JSON.stringify(path.join(dir, 'cache'))}`);
      expect(toml).toContain(`state_dir = ${JSON.stringify(path.join(dir, 'state'))}`);
      expect(fs.statSync(path.join(dir, 'state')).isDirectory()).toBe(true);
      expect(toml).not.toContain('allow_running_as_root');
      const rootToml = fs.readFileSync(writeConfig(dir, 9151, { allowRoot: true }), 'utf-8');
      expect(rootToml).toContain('[application]\nallow_running_as_root = true');
      // Every key it writes is one the app's tor-manager writes too.
      const torManager = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'tor-manager.js'),
        'utf-8'
      );
      for (const key of [
        '[proxy]',
        'socks_listen = ',
        '[storage]',
        'cache_dir = ',
        'state_dir = ',
      ]) {
        expect(torManager).toContain(key);
      }
      expect(torManager).toContain('\'console = "info"\'');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failing check is tried again, up to its attempts, and says how many it took', async () => {
    const outcomes = [
      new Error('no SOCKS5 answer in request'),
      { ok: false, code: 1 },
      { ok: true },
    ];
    const run = jest.fn(async () => {
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    expect(await check(run, 3)).toEqual({ ok: true, attempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);

    const failing = jest.fn(async () => {
      throw new Error('no SOCKS5 answer in request');
    });
    expect(await check(failing, 2)).toEqual({
      ok: false,
      error: 'no SOCKS5 answer in request',
      attempts: 2,
    });
    expect(failing).toHaveBeenCalledTimes(2);

    const first = jest.fn(async () => ({ ok: true, code: 0 }));
    expect(await check(first)).toEqual({ ok: true, code: 0, attempts: 1 });
    expect(first).toHaveBeenCalledTimes(1);
  });

  test('RESOLVE qualifies; credentials count only when required; CONNECT never does', () => {
    const report = (resolve, withCredentials, connect) => ({
      resolve: { ok: resolve },
      resolve_with_credentials: { ok: withCredentials },
      connect: { ok: connect },
    });
    expect(qualifies(report(true, false, false), { requireCredentials: false })).toBe(true);
    expect(qualifies(report(true, false, true), { requireCredentials: true })).toBe(false);
    expect(qualifies(report(true, true, false), { requireCredentials: true })).toBe(true);
    expect(qualifies(report(false, true, true), { requireCredentials: false })).toBe(false);
    expect(qualifies(report(false, true, true), { requireCredentials: true })).toBe(false);
  });

  test('isolation counts only under --isolation, and then must pass', () => {
    const report = (isolated) => ({
      resolve: { ok: true },
      resolve_with_credentials: { ok: true },
      connect: { ok: true },
      ...(isolated === undefined ? {} : { isolation: { ok: isolated } }),
    });
    expect(qualifies(report(undefined), { requireCredentials: true })).toBe(true);
    expect(qualifies(report(false), { requireCredentials: true })).toBe(true);
    expect(qualifies(report(true), { requireCredentials: true, isolation: true })).toBe(true);
    expect(qualifies(report(false), { requireCredentials: true, isolation: true })).toBe(false);
    expect(qualifies(report(undefined), { requireCredentials: true, isolation: true })).toBe(false);
  });

  /** Credentials `u`/`p1`, `u`/`p2`, …, in the order they are made. */
  const numbered = () => {
    let n = 0;
    return () => ({ username: 'u', password: `p${(n += 1)}` });
  };

  /**
   * An exit function blind to credentials: the `i`th connection's exit is
   * `exitAt(i)`, counting from 0.
   */
  const blind = (exitAt) => {
    let i = 0;
    return async () => exitAt(i++);
  };

  /** A seeded generator, for orders that repeat from run to run. */
  const seeded = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const permuteWith = (random) => (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  /** An exit function that answers by password, from `table`. */
  const byPassword =
    (table) =>
    async ({ password }) =>
      table[password];

  test('isolation asks every set once a round, and wants no exit shared between sets', async () => {
    const isolated = await isolation(byPassword({ p1: 'a', p2: 'b', p3: 'c', p4: 'd' }), {
      credentials: numbered(),
    });
    expect(isolated).toMatchObject({ ok: true, steady: true, shared: false, exits: 4 });
    expect(isolated.switches).toEqual([0, 0, 0, 0]);
    expect(isolated.observations).toEqual(
      ['a', 'b', 'c', 'd'].map((exit) => Array(ISOLATION_ROUNDS).fill(exit))
    );
    // Each round asks every set once.
    for (let round = 0; round < ISOLATION_ROUNDS; round += 1) {
      const sets = isolated.order.slice(round * ISOLATION_SETS, (round + 1) * ISOLATION_SETS);
      expect([...sets].sort()).toEqual([0, 1, 2, 3]);
    }
    // Two sets on one exit: not isolated from each other.
    expect(
      await isolation(byPassword({ p1: 'a', p2: 'b', p3: 'c', p4: 'a' }), {
        credentials: numbered(),
      })
    ).toMatchObject({ ok: false, steady: true, shared: true });
    // One exit for everything: no isolation.
    expect(await isolation(async () => 'a', { credentials: numbered() })).toMatchObject({
      ok: false,
      shared: true,
      exits: 1,
    });
    // A new exit for each connection: no circuit kept for a set.
    expect(
      await isolation(
        blind((i) => `e${i}`),
        { credentials: numbered() }
      )
    ).toMatchObject({
      ok: false,
      steady: false,
    });
  });

  test('the sets may change their exits a few times in all, not more', async () => {
    // Set 0 moves to a new exit of its own every `k` connections, and the
    // others stay.
    const moving = (k) => {
      let asked = 0;
      return async ({ password }) => {
        if (password !== 'p1') return password;
        asked += 1;
        return `p1-${Math.floor((asked - 1) / k)}`;
      };
    };
    // Every connection after the first, but one: as many changes as allowed.
    const changes = (k) => Math.floor((ISOLATION_ROUNDS - 1) / k);
    const allowed = [1, 2, 3, 4, 5, 6, 7].filter((k) => changes(k) <= ISOLATION_SWITCHES);
    for (const k of allowed) {
      const outcome = await isolation(moving(k), { credentials: numbered() });
      expect(outcome).toMatchObject({ ok: true, steady: true });
      expect(outcome.switches).toEqual([changes(k), 0, 0, 0]);
    }
    // Set 0 moving at every connection: one change past the limit.
    expect(ISOLATION_ROUNDS - 1).toBe(ISOLATION_SWITCHES + 1);
    const over = await isolation(moving(1), { credentials: numbered() });
    expect(over.switches).toEqual([ISOLATION_SWITCHES + 1, 0, 0, 0]);
    expect(over).toMatchObject({ ok: false, steady: false, shared: false });
    // The limit is on all the sets' changes together: four of set 0's and
    // three of set 1's are one too many, though neither is past it alone.
    const asked = {};
    const both = async ({ password }) => {
      asked[password] = (asked[password] || 0) + 1;
      const n = asked[password];
      if (password === 'p1') return `p1-${Math.min(4, n - 1)}`;
      if (password === 'p2') return `p2-${Math.min(3, n - 1)}`;
      return password;
    };
    const together = await isolation(both, { credentials: numbered() });
    expect(together.switches).toEqual([4, 3, 0, 0]);
    expect(together).toMatchObject({ ok: false, steady: false, shared: false });
    // Back to an exit it left is a change too, and still not shared.
    let back = 0;
    const returning = async ({ password }) => {
      if (password !== 'p1') return password;
      back += 1;
      return back % 2 === 0 ? 'elsewhere' : 'p1';
    };
    expect(await isolation(returning, { credentials: numbered() })).toMatchObject({
      ok: false,
      steady: false,
      shared: false,
    });
  });

  test('the order of each round is drawn at random', () => {
    const orders = new Set();
    for (let i = 0; i < 50; i += 1) orders.add(shuffled([0, 1, 2, 3]).join(''));
    expect(orders.size).toBeGreaterThan(1);
    for (const order of orders) expect([...order].sort().join('')).toBe('0123');
  });

  test('a proxy blind to credentials that reuses an exit, then rotates, never passes', async () => {
    const total = ISOLATION_SETS * ISOLATION_ROUNDS;
    for (let n = 1; n <= total; n += 1) {
      // `n` connections an exit, then the next exit: the review's
      // [1, 1, 2, 2, …] is n = 2.
      for (let run = 0; run < 10; run += 1) {
        const outcome = await isolation(
          blind((i) => `e${Math.floor(i / n)}`),
          { credentials: numbered() }
        );
        expect(outcome.ok).toBe(false);
      }
      // `n` connections on one exit, then another for good.
      const outcome = await isolation(
        blind((i) => (i < n ? 'e0' : 'e1')),
        { credentials: numbered() }
      );
      expect(outcome.ok).toBe(false);
    }
  });

  test('a blind proxy cycling through exits passes only if it could predict the order', async () => {
    const cycle = () => blind((i) => `e${i % ISOLATION_SETS}`);
    // In the same order every round, each set would land on one exit.
    expect(
      (await isolation(cycle(), { credentials: numbered(), permute: (items) => items })).ok
    ).toBe(true);
    // In orders drawn at random it doesn't: 200 runs, with a seeded
    // generator so that the result is the same each time.
    const permute = permuteWith(seeded(0x5eed));
    for (let run = 0; run < 200; run += 1) {
      expect((await isolation(cycle(), { credentials: numbered(), permute })).ok).toBe(false);
    }
  });

  test("a connection's exit is asked again, with the same credentials, when it fails", async () => {
    const asked = [];
    let failures = 2;
    const flaky = retrying(async (credentials) => {
      asked.push(credentials.password);
      if (failures > 0) {
        failures -= 1;
        throw new Error('the echo service failed');
      }
      return 'a';
    });
    await expect(flaky({ username: 'u', password: 'p1' })).resolves.toBe('a');
    expect(asked).toEqual(['p1', 'p1', 'p1']);
    const failing = retrying(async () => {
      throw new Error('the echo service failed');
    }, 3);
    await expect(failing({ username: 'u', password: 'p1' })).rejects.toThrow(
      'the echo service failed'
    );
  });

  test('a check that completes is final unless failures are retried; one that throws is retried', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return { ok: false };
    };
    expect(await check(failing, 3, { retryFailures: false })).toEqual({ ok: false, attempts: 1 });
    expect(calls).toBe(1);
    calls = 0;
    expect(await check(failing)).toEqual({ ok: false, attempts: 3 });
    expect(calls).toBe(3);
    calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('the echo service failed');
      return { ok: true };
    };
    expect(await check(flaky, 3, { retryFailures: false })).toEqual({ ok: true, attempts: 3 });
  });

  describe('exitAddress(), against a stand-in proxy and echo service', () => {
    /**
     * An in-process SOCKS5 proxy that grants a `CONNECT` (or refuses it,
     * for `refuse`) and answers the request on it as `echo` says.
     */
    const proxy = (echo) =>
      new Promise((resolve) => {
        const timers = [];
        const server = net.createServer((socket) => {
          let phase = 'greeting';
          socket.on('error', () => {});
          socket.on('data', (chunk) => {
            if (phase === 'greeting') {
              socket.write(Buffer.from([5, chunk[2]]));
              phase = chunk[2] === 2 ? 'authentication' : 'request';
            } else if (phase === 'authentication') {
              socket.write(Buffer.from([1, 0]));
              phase = 'request';
            } else if (phase === 'request') {
              if (echo === 'refuse') {
                socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
                return;
              }
              socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
              phase = 'http';
            } else if (phase === 'http') {
              phase = 'answered';
              const answer = (status, body, length = body.length) =>
                `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`;
              if (echo === 'close') socket.destroy();
              else if (echo === 'status') socket.end(answer('500 Internal Server Error', '{}'));
              else if (echo === 'malformed') socket.end(answer('200 OK', 'not JSON'));
              else if (echo === 'non-ip') socket.end(answer('200 OK', '{"IP":"nope"}'));
              else if (echo === 'large') {
                const body = JSON.stringify({
                  IP: '198.51.100.7',
                  pad: 'x'.repeat(ECHO_MAX_BYTES),
                });
                socket.end(answer('200 OK', body));
              } else if (echo === 'trickle') {
                // A body that never ends, a byte at a time, well within the
                // inactivity timeout.
                socket.write(answer('200 OK', '', 1_000_000));
                const timer = setInterval(() => socket.write(' '), 20);
                timers.push(timer);
                socket.on('close', () => clearInterval(timer));
              } else socket.end(answer('200 OK', '{"IP":"198.51.100.7"}'));
            }
          });
        });
        server.listen(0, '127.0.0.1', () =>
          resolve({
            address: { host: '127.0.0.1', port: server.address().port },
            close: () => {
              for (const timer of timers) clearInterval(timer);
              return new Promise((done) => server.close(done));
            },
          })
        );
      });
    const ask = async (echo, timeoutMs = 2000) => {
      const stand = await proxy(echo);
      try {
        return await exitAddress(
          stand.address,
          { username: 'u', password: 'p' },
          'http://echo.test/api/ip',
          timeoutMs
        );
      } finally {
        await stand.close();
      }
    };

    test('an answer naming an IP address gives it', async () => {
      await expect(ask('ok')).resolves.toBe('198.51.100.7');
    });

    test.each([
      ['refuse', /refused the connection/],
      ['close', /./],
      ['status', /answered 500/],
      ['malformed', /isn't JSON/],
      ['non-ip', /named no address/],
      ['large', new RegExp(`over ${ECHO_MAX_BYTES} bytes`)],
    ])('it fails closed on %s', async (echo, message) => {
      await expect(ask(echo)).rejects.toThrow(message);
    });

    test('a body that trickles on without end fails at the deadline', async () => {
      const started = Date.now();
      await expect(ask('trickle', 300)).rejects.toThrow(/no whole answer .* in 300 ms/);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  test('the version is read from `arti --version`, or is null', () => {
    expect(parseVersion('Arti 2.7.0')).toBe('2.7.0');
    expect(parseVersion('arti 99.0.0')).toBe('99.0.0');
    expect(parseVersion('Arti 2.7.0-beta.1')).toBe('2.7.0-beta.1');
    for (const line of [null, '', 'Arti', 'Arti 2.7', 'Tor 0.4.8.1', 'Arti 2.7.0 extra']) {
      expect(parseVersion(line)).toBeNull();
    }
  });

  test('the verdict needs the pinned version and the required checks', () => {
    const report = (version, resolve) => ({
      version,
      pinned: '2.7.0',
      resolve: { ok: resolve },
      resolve_with_credentials: { ok: true },
      connect: { ok: true },
    });
    const options = { requireCredentials: false };
    expect(verdict(report('2.7.0', true), options)).toEqual({ qualified: true });
    expect(verdict(report('2.7.0', false), options)).toEqual({
      qualified: false,
      reason: 'a required check failed',
    });
    expect(verdict(report('2.8.0', true), options).qualified).toBe(false);
    expect(verdict(report(null, true), options).qualified).toBe(false);
  });

  test('Arti runs as the binary itself unless a launcher is given', () => {
    expect(artiCommand('/opt/arti', ['--version'])).toEqual({
      file: '/opt/arti',
      args: ['--version'],
    });
    expect(artiCommand('/opt/arti', ['proxy', '-c', 'a.toml'], [])).toEqual({
      file: '/opt/arti',
      args: ['proxy', '-c', 'a.toml'],
    });
    expect(artiCommand('fake.js', ['--version'], ['/usr/bin/node'])).toEqual({
      file: '/usr/bin/node',
      args: ['fake.js', '--version'],
    });
    expect(artiCommand('fake.js', ['--version'], ['/usr/bin/node', '--no-warnings'])).toEqual({
      file: '/usr/bin/node',
      args: ['--no-warnings', 'fake.js', '--version'],
    });
  });

  test('the command line never sets the launcher', () => {
    const source = fs.readFileSync(path.join(__dirname, 'qualify-arti-resolve.js'), 'utf-8');
    const main = source.slice(source.indexOf('if (require.main === module)'));
    expect(main).toContain('qualify(parseArgs(process.argv.slice(2)))');
    expect(main).not.toContain('launcher');
  });

  describe('qualify(), against a stand-in Arti', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-qualify-fake-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const run = (versionLine, fake = {}, { isolate = false } = {}) =>
      qualify(
        {
          arti: fakeArti(dir, versionLine, fake),
          name: 'example.com',
          bootstrapTimeoutMs: 10000,
          requireCredentials: true,
          isolation: isolate,
          echoUrl: 'http://echo.test/api/ip',
          allowRoot: false,
        },
        { launcher: [process.execPath] }
      );

    test('the pinned version, with the checks passing, qualifies', async () => {
      const report = await run(`Arti ${PINNED_ARTI_VERSION}`);
      expect(report).toMatchObject({
        version: PINNED_ARTI_VERSION,
        pinned: PINNED_ARTI_VERSION,
        resolve: { ok: true, address: { ip: '93.184.215.14' } },
        resolve_with_credentials: { ok: true },
        connect: { ok: true },
        checks_passed: true,
        qualified: true,
      });
      expect(report.reason).toBeUndefined();
      // Isolation isn't checked unless asked for.
      expect(report.isolation).toBeUndefined();
    });

    test('--isolation passes when each set of credentials keeps a circuit of its own', async () => {
      const report = await run(`Arti ${PINNED_ARTI_VERSION}`, {}, { isolate: true });
      expect(report).toMatchObject({
        isolation: { ok: true, steady: true, shared: false, attempts: 1, exits: 4 },
        checks_passed: true,
        qualified: true,
      });
      expect(report.isolation.observations).toHaveLength(ISOLATION_SETS);
      for (const exits of report.isolation.observations) {
        expect(exits).toHaveLength(ISOLATION_ROUNDS);
      }
    });

    test('--isolation passes when a set of credentials moves to a new circuit once', async () => {
      const report = await run(
        `Arti ${PINNED_ARTI_VERSION}`,
        { exits: 'migrate' },
        { isolate: true }
      );
      expect(report).toMatchObject({
        isolation: { ok: true, attempts: 1, exits: 5 },
        qualified: true,
      });
      // The set the stand-in saw first, whichever the order drew.
      expect([...report.isolation.switches].sort()).toEqual([0, 0, 0, 1]);
    });

    test('--isolation fails, once, when every set of credentials shares one circuit', async () => {
      const report = await run(`Arti ${PINNED_ARTI_VERSION}`, { exits: 'one' }, { isolate: true });
      expect(report).toMatchObject({
        isolation: { ok: false, shared: true, attempts: 1, exits: 1 },
        checks_passed: false,
        qualified: false,
        reason: 'a required check failed',
      });
    });

    test('--isolation fails, once, when the same credentials get a new circuit each time', async () => {
      const report = await run(
        `Arti ${PINNED_ARTI_VERSION}`,
        { exits: 'every' },
        { isolate: true }
      );
      expect(report).toMatchObject({
        isolation: { ok: false, steady: false, attempts: 1 },
        qualified: false,
      });
    });

    test.each([1, 2, 3, 5, 8])(
      '--isolation fails, once, for a proxy blind to credentials that rotates every %i connections',
      async (n) => {
        const report = await run(
          `Arti ${PINNED_ARTI_VERSION}`,
          { exits: `blind:${n}` },
          { isolate: true }
        );
        expect(report).toMatchObject({
          isolation: { ok: false, attempts: 1 },
          qualified: false,
        });
      }
    );

    test('each attempt of the credentials check gets new credentials, so a new circuit', async () => {
      // The first credentials' circuit fails RESOLVE every time: a retry
      // on them would fail all three attempts.
      const report = await run(`Arti ${PINNED_ARTI_VERSION}`, { failFirstPassword: true });
      expect(report).toMatchObject({
        resolve: { ok: true, attempts: 1 },
        resolve_with_credentials: { ok: true, attempts: 2 },
        checks_passed: true,
        qualified: true,
      });
    });

    test('another version passing the checks is an unpinned result, not qualified', async () => {
      const report = await run('arti 99.0.0');
      expect(report).toMatchObject({
        version: '99.0.0',
        pinned: PINNED_ARTI_VERSION,
        checks_passed: true,
        qualified: false,
      });
      expect(report.reason).toContain('not the pinned');
    });

    test('a version that cannot be read is not qualified', async () => {
      const report = await run(null);
      expect(report).toMatchObject({
        arti: null,
        version: null,
        checks_passed: true,
        qualified: false,
      });
      expect(report.reason).toContain('unavailable');
    });
  });
});
