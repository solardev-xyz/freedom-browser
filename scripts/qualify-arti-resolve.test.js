const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, writeConfig, check, qualifies } = require('./qualify-arti-resolve');

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
});
