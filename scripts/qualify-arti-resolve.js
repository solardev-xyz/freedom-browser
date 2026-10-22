#!/usr/bin/env node
'use strict';

/**
 * Qualify the pinned Arti for IPFS through Tor (freedom-core design 0007,
 * "The SOCKS contract"; implementation step 8, B5).
 *
 * Under `socks5`, freedom-ipfsd resolves every ordinary name through the
 * proxy with Tor's `RESOLVE` extension (SOCKS command 0xF0), checks the
 * answer, and connects to the checked address. If the Arti the app ships
 * can't `RESOLVE`, the "Route IPFS through Tor" setting doesn't ship (0007's
 * open question 10). This script starts that Arti on its own, waits for it
 * to bootstrap, and asks it:
 *
 *   - **resolve:** `RESOLVE` for a known name, without authentication: one
 *     IPv4 or IPv6 address, never a domain-typed answer, `0.0.0.0` or `::`.
 *     Required.
 *   - **resolve_with_credentials:** the same, authenticating with a
 *     username and password (RFC 1929), as per-instance stream isolation
 *     would (0007's open question 11). Reported; required with
 *     `--require-credentials`.
 *   - **connect:** `CONNECT` to the address the first `RESOLVE` answered, on
 *     port 443, as freedom-ipfsd connects to a checked address. Reported:
 *     an exit's policy can refuse it, which says nothing about Arti.
 *
 * Each check is tried up to three times before it counts as failed.
 *
 * Only the pinned Arti qualifies: `qualified` needs `arti --version` to
 * name `PINNED_ARTI_VERSION` (scripts/fetch-arti.js) and the required checks
 * to pass. Another version's checks are still run and reported
 * (`checks_passed`), as an unpinned result that doesn't qualify; so is a
 * binary whose version can't be read. `reason` says why a run doesn't
 * qualify.
 *
 * It needs network access (Tor's), so it is a release-pipeline job, not a
 * unit test. It prints a JSON report and exits 0 only when qualified.
 *
 * Usage:
 *   node scripts/qualify-arti-resolve.js [--arti <path>] [--name <host>]
 *     [--bootstrap-timeout-ms <ms>] [--require-credentials] [--allow-root]
 *
 * Arti refuses to run as root; `--allow-root` sets its
 * `application.allow_running_as_root` for a container that only has root.
 *
 * The Arti binary defaults to `arti-bin/<os>-<arch>/arti` (`npm run
 * tor:download` builds it). Its configuration mirrors the one
 * src/main/tor-manager.js writes: a pinned SOCKS port, and state and cache
 * in a directory of its own (a temporary one here).
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { socks5Request, isUsableAnswer } = require('./lib/socks5-client');
const { platformKey, artiBinaryName, PINNED_ARTI_VERSION } = require('./fetch-arti');

const BOOTSTRAPPED = /Sufficiently bootstrapped/i;

function parseArgs(argv) {
  const options = {
    arti: null,
    name: 'example.com',
    bootstrapTimeoutMs: 180000,
    requireCredentials: false,
    allowRoot: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--arti') options.arti = argv[++i];
    else if (arg === '--name') options.name = argv[++i];
    else if (arg === '--bootstrap-timeout-ms') options.bootstrapTimeoutMs = Number(argv[++i]);
    else if (arg === '--require-credentials') options.requireCredentials = true;
    else if (arg === '--allow-root') options.allowRoot = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** The binary `npm run tor:download` builds for this host. */
function defaultArtiPath() {
  return path.join(__dirname, '..', 'arti-bin', platformKey(), artiBinaryName());
}

/** A free loopback port, released before Arti binds it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The same keys src/main/tor-manager.js writes into arti.toml, plus
 * `allow_running_as_root` with `allowRoot`.
 */
function writeConfig(dir, socksPort, { allowRoot = false } = {}) {
  const stateDir = path.join(dir, 'state');
  const cacheDir = path.join(dir, 'cache');
  for (const d of [stateDir, cacheDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const toml = [
    '[proxy]',
    `socks_listen = ${socksPort}`,
    '',
    '[storage]',
    `cache_dir = ${JSON.stringify(cacheDir)}`,
    `state_dir = ${JSON.stringify(stateDir)}`,
    '',
    '[logging]',
    'console = "info"',
    '',
    ...(allowRoot ? ['[application]', 'allow_running_as_root = true', ''] : []),
  ].join('\n');
  const configPath = path.join(dir, 'arti.toml');
  fs.writeFileSync(configPath, toml, 'utf-8');
  return configPath;
}

/**
 * The version `line` (`arti --version`'s first) names, as `Arti 2.7.0`
 * does; `null` without one.
 */
function parseVersion(line) {
  const match = /^arti\s+v?(\d+\.\d+\.\d+\S*)$/i.exec((line || '').trim());
  return match ? match[1] : null;
}

/**
 * The command that runs Arti at `artiPath` with `args`: the binary itself,
 * or, with a `launcher` (a command prefix such as `[process.execPath]`, for
 * the tests' stand-in script), the launcher with the path as its argument.
 */
function artiCommand(artiPath, args, launcher = []) {
  if (launcher.length === 0) return { file: artiPath, args };
  return { file: launcher[0], args: [...launcher.slice(1), artiPath, ...args] };
}

/** Arti's version: the first line `arti --version` prints. */
function artiVersion(artiPath, launcher = []) {
  const { file, args } = artiCommand(artiPath, ['--version'], launcher);
  try {
    return execFileSync(file, args, { encoding: 'utf-8' }).split('\n')[0].trim();
  } catch {
    return null;
  }
}

/**
 * Starts Arti and resolves once it says it is bootstrapped. A failure
 * carries Arti's last lines of output.
 */
function startArti(artiPath, configPath, timeoutMs, launcher = []) {
  return new Promise((resolve, reject) => {
    const { file, args } = artiCommand(artiPath, ['proxy', '-c', configPath], launcher);
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const failed = (message) =>
      new Error(tail.length ? `${message}; its last output:\n${tail.join('\n')}` : message);
    const timer = setTimeout(() => {
      child.kill();
      reject(failed(`Arti didn't bootstrap within ${timeoutMs} ms`));
    }, timeoutMs);
    const watch = (stream) => {
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk.toString('utf-8');
        const lines = pending.split('\n');
        pending = lines.pop();
        tail.push(...lines);
        tail.splice(0, Math.max(0, tail.length - 10));
        if (lines.some((line) => BOOTSTRAPPED.test(line))) {
          clearTimeout(timer);
          resolve(child);
        }
      });
    };
    watch(child.stdout);
    watch(child.stderr);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(failed(`Arti exited with code ${code} before it bootstrapped`));
    });
  });
}

/**
 * One check's outcome: `{ ok, code, address, attempts }`, or `{ ok: false,
 * error, attempts }`. A check that fails is tried again, up to `attempts`
 * times: a fresh circuit through Tor can take longer than one request's
 * deadline, which says nothing about whether Arti can `RESOLVE`.
 */
async function check(run, attempts = 3) {
  let outcome;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      outcome = await run();
    } catch (error) {
      outcome = { ok: false, error: error.message };
    }
    outcome.attempts = attempt;
    if (outcome.ok) break;
  }
  return outcome;
}

/**
 * Whether the checks pass: `RESOLVE` without authentication must, and with
 * credentials too under `requireCredentials`. `CONNECT` is reported only.
 */
function qualifies(report, { requireCredentials }) {
  return Boolean(report.resolve.ok && (!requireCredentials || report.resolve_with_credentials.ok));
}

/**
 * The verdict: `{ qualified, reason }`. Qualified only when the checks pass
 * (`qualifies`) and the version is the pinned one.
 */
function verdict(report, options) {
  if (!report.version) {
    return {
      qualified: false,
      reason: 'the version is unavailable, so it may not be the pinned one',
    };
  }
  if (report.version !== report.pinned) {
    return {
      qualified: false,
      reason: `Arti ${report.version} is not the pinned ${report.pinned}: an unpinned result`,
    };
  }
  if (!qualifies(report, options)) {
    return { qualified: false, reason: 'a required check failed' };
  }
  return { qualified: true };
}

/**
 * Runs the checks against the Arti `options` names. `launcher` is a seam
 * for the tests only (`artiCommand`): the command line never sets it, so
 * the release job always runs the binary itself.
 */
async function qualify(options, { launcher = [] } = {}) {
  const artiPath = options.arti || defaultArtiPath();
  if (!fs.existsSync(artiPath)) {
    throw new Error(`no Arti binary at ${artiPath}: run \`npm run tor:download\` first`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-qualify-'));
  const socksPort = await freePort();
  const proxy = { host: '127.0.0.1', port: socksPort };
  const arti = artiVersion(artiPath, launcher);
  const report = {
    arti,
    version: parseVersion(arti),
    pinned: PINNED_ARTI_VERSION,
    name: options.name,
  };
  let child = null;
  try {
    const config = writeConfig(dir, socksPort, { allowRoot: options.allowRoot });
    child = await startArti(artiPath, config, options.bootstrapTimeoutMs, launcher);
    const resolveWith = (credentials) =>
      check(async () => {
        const { code, address } = await socks5Request(
          proxy,
          { command: 'resolve', name: options.name },
          { credentials }
        );
        return { ok: code === 0 && isUsableAnswer(address), code, address };
      });
    report.resolve = await resolveWith(null);
    report.resolve_with_credentials = await resolveWith({
      username: 'freedom-ipfs-qualification',
      password: crypto.randomBytes(16).toString('hex'),
    });
    report.connect = report.resolve.ok
      ? await check(async () => {
          const { code } = await socks5Request(proxy, {
            command: 'connect',
            ip: report.resolve.address.ip,
            port: 443,
          });
          return { ok: code === 0, code };
        })
      : { ok: false, error: 'no address to connect to' };
  } finally {
    if (child) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report.checks_passed = qualifies(report, options);
  Object.assign(report, verdict(report, options));
  return report;
}

if (require.main === module) {
  qualify(parseArgs(process.argv.slice(2)))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.qualified ? 0 : 1);
    })
    .catch((error) => {
      console.error(`qualify-arti-resolve: ${error.message}`);
      process.exit(2);
    });
}

module.exports = {
  parseArgs,
  writeConfig,
  check,
  qualifies,
  parseVersion,
  verdict,
  artiCommand,
  qualify,
};
