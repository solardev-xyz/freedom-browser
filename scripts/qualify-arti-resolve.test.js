const fs = require('fs');
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
  qualify,
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
 * connection (`one`, no isolation), or a new one for every connection
 * (`every`, no circuit kept).
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
const exitOf = (password) => {
  connections += 1;
  if (exits === 'one') return '198.51.100.1';
  if (exits === 'every') return '198.51.100.' + connections;
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

  test('isolation needs the same exit for the same credentials, and two exits among four sets', async () => {
    let n = 0;
    const credentials = () => ({ username: 'u', password: `p${(n += 1)}` });
    const byPassword =
      (table) =>
      async ({ password }) =>
        table[password];
    const isolated = await isolation(
      byPassword({ p1: 'a', p2: 'b', p3: 'c', p4: 'a' }),
      credentials
    );
    expect(isolated).toEqual({
      ok: true,
      same_credentials: ['a', 'a'],
      distinct_credentials: ['a', 'b', 'c', 'a'],
      exits: 3,
    });
    n = 0;
    expect(
      (await isolation(byPassword({ p1: 'a', p2: 'a', p3: 'a', p4: 'a' }), credentials)).ok
    ).toBe(false);
    // A new exit for each connection: no circuit kept for a set.
    n = 0;
    let calls = 0;
    const every = await isolation(async () => `e${(calls += 1)}`, credentials);
    expect(every).toMatchObject({ ok: false, same_credentials: ['e1', 'e2'] });
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
        isolation: {
          ok: true,
          attempts: 1,
          exits: 4,
          same_credentials: ['198.51.100.1', '198.51.100.1'],
        },
        checks_passed: true,
        qualified: true,
      });
    });

    test('--isolation fails when every set of credentials shares one circuit', async () => {
      const report = await run(`Arti ${PINNED_ARTI_VERSION}`, { exits: 'one' }, { isolate: true });
      expect(report).toMatchObject({
        isolation: { ok: false, attempts: 3, exits: 1 },
        checks_passed: false,
        qualified: false,
        reason: 'a required check failed',
      });
    });

    test('--isolation fails when the same credentials get a new circuit each time', async () => {
      const report = await run(
        `Arti ${PINNED_ARTI_VERSION}`,
        { exits: 'every' },
        { isolate: true }
      );
      expect(report).toMatchObject({
        isolation: { ok: false, attempts: 3 },
        qualified: false,
      });
      expect(report.isolation.same_credentials[0]).not.toBe(report.isolation.same_credentials[1]);
    });

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
