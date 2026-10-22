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
  qualify,
} = require('./qualify-arti-resolve');
const { PINNED_ARTI_VERSION } = require('./fetch-arti');

/**
 * A stand-in Arti in `dir`: `--version` prints `versionLine`, or fails
 * when it's `null`; `proxy -c <config>` serves SOCKS5 on the config's port
 * (any one method, RFC 1929 accepted, `RESOLVE` answering 93.184.215.14,
 * `CONNECT` succeeding) and says it bootstrapped.
 */
function fakeArti(dir, versionLine) {
  const script = `#!/usr/bin/env node
const fs = require('fs');
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
net
  .createServer((socket) => {
    let phase = 'greeting';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (phase === 'greeting') {
        const method = chunk[2];
        socket.write(Buffer.from([5, method]));
        phase = method === 2 ? 'authentication' : 'request';
      } else if (phase === 'authentication') {
        socket.write(Buffer.from([1, 0]));
        phase = 'request';
      } else if (chunk[1] === 0xf0) {
        socket.end(Buffer.from([5, 0, 0, 1, 93, 184, 215, 14, 0, 0]));
      } else {
        socket.end(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  })
  .listen(port, '127.0.0.1', () => console.log('INFO arti: Sufficiently bootstrapped; system SOCKS proxy ready.'));
`;
  const artiPath = path.join(dir, 'arti');
  fs.writeFileSync(artiPath, script, { mode: 0o755 });
  return artiPath;
}

describe('qualify-arti-resolve', () => {
  test('arguments default to a known name and a 3-minute bootstrap', () => {
    expect(parseArgs([])).toEqual({
      arti: null,
      name: 'example.com',
      bootstrapTimeoutMs: 180000,
      requireCredentials: false,
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
        '--allow-root',
      ])
    ).toEqual({
      arti: '/opt/arti',
      name: 'torproject.org',
      bootstrapTimeoutMs: 5000,
      requireCredentials: true,
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

  describe('qualify(), against a stand-in Arti', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-qualify-fake-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const run = (versionLine) =>
      qualify({
        arti: fakeArti(dir, versionLine),
        name: 'example.com',
        bootstrapTimeoutMs: 10000,
        requireCredentials: true,
        allowRoot: false,
      });

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
