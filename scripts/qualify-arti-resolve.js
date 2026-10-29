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
 *     username and password (RFC 1929), as each IPFS instance does under
 *     `socks5` (0007, "Stream isolation"). Reported; required with
 *     `--require-credentials`.
 *   - **connect:** `CONNECT` to the address the first `RESOLVE` answered, on
 *     port 443, as freedom-ipfsd connects to a checked address. Reported:
 *     an exit's policy can refuse it, which says nothing about Arti.
 *   - **isolation**, with `--isolation` only: that distinct credentials get
 *     distinct circuits, and the same credentials the same one. Required
 *     then. Both IPFS (each instance's credentials, 0007 "Stream
 *     isolation", freedom-ipfsd v0.2.1) and Radicle (each remote node's,
 *     0008) rely on it, and neither was qualified for it before. A circuit
 *     can't be seen through SOCKS, but its exit can: each connection asks an
 *     echo service (`--echo-url`, check.torproject.org's by default) for the
 *     address it comes from.
 *     - One set of credentials asks twice: both must come from the same
 *       exit, since Arti keeps a set of credentials on its circuit.
 *     - Three more sets ask once each. With those four sets, at least two
 *       exits must answer: four circuits of Tor's thousands of exits, all on
 *       one, is a chance too small to matter, while credentials that
 *       weren't isolated would all share one circuit.
 *
 * Each check is tried up to three times before it counts as failed. Each
 * attempt of the credentials check sends new credentials, so Arti gives it
 * a new isolated circuit: one circuit's exit can keep failing a name (reply
 * 0x01 on every attempt), which says nothing about Arti, and a retry on the
 * same credentials would only ask that exit again.
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
 *     [--bootstrap-timeout-ms <ms>] [--require-credentials] [--isolation]
 *     [--echo-url <url>] [--allow-root]
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
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { socks5Request, isUsableAnswer } = require('./lib/socks5-client');
const { platformKey, artiBinaryName, PINNED_ARTI_VERSION } = require('./fetch-arti');

const BOOTSTRAPPED = /Sufficiently bootstrapped/i;

/** The echo service the isolation check asks for each connection's exit. */
const DEFAULT_ECHO_URL = 'https://check.torproject.org/api/ip';

/** How many sets of credentials the isolation check asks with, in all. */
const ISOLATION_SETS = 4;

function parseArgs(argv) {
  const options = {
    arti: null,
    name: 'example.com',
    bootstrapTimeoutMs: 180000,
    requireCredentials: false,
    isolation: false,
    echoUrl: DEFAULT_ECHO_URL,
    allowRoot: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--arti') options.arti = argv[++i];
    else if (arg === '--name') options.name = argv[++i];
    else if (arg === '--bootstrap-timeout-ms') options.bootstrapTimeoutMs = Number(argv[++i]);
    else if (arg === '--require-credentials') options.requireCredentials = true;
    else if (arg === '--isolation') options.isolation = true;
    else if (arg === '--echo-url') options.echoUrl = argv[++i];
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
 * Whether the checks pass: `RESOLVE` without authentication must, with
 * credentials too under `requireCredentials`, and isolation under
 * `isolation`. `CONNECT` is reported only.
 */
function qualifies(report, { requireCredentials, isolation = false }) {
  return Boolean(
    report.resolve.ok &&
    (!requireCredentials || report.resolve_with_credentials.ok) &&
    (!isolation || (report.isolation && report.isolation.ok))
  );
}

/**
 * The address a connection through `proxy` with `credentials` comes from,
 * as the echo service at `echoUrl` sees it: a `GET` through a `CONNECT` to
 * its host, over TLS for an `https` URL. Its answer is JSON with an `IP`, as
 * check.torproject.org's is.
 */
async function exitAddress(proxy, credentials, echoUrl, timeoutMs = 60000) {
  const url = new URL(echoUrl);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const { code, socket } = await socks5Request(
    proxy,
    { command: 'connect', name: url.hostname, port },
    { credentials, timeoutMs, keep: true }
  );
  if (code !== 0) {
    throw new Error(`the proxy refused the connection to ${url.hostname} (reply ${code})`);
  }
  const connection = secure ? tls.connect({ socket, servername: url.hostname }) : socket;
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(
        {
          host: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { Connection: 'close' },
          createConnection: () => connection,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`the echo service answered ${res.statusCode}`));
            } else {
              resolve(Buffer.concat(chunks).toString('utf-8'));
            }
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('no answer from the echo service')));
      req.on('error', reject);
      req.end();
      // The SOCKS client hands the connection over paused. Over TLS, the TLS
      // socket reads it; in the clear, it flows once the request has taken it,
      // which it does on the next tick.
      if (!secure) process.nextTick(() => socket.resume());
    });
  } finally {
    connection.destroy();
  }
  const ip = JSON.parse(body).IP;
  if (typeof ip !== 'string' || net.isIP(ip) === 0) {
    throw new Error('the echo service named no address');
  }
  return ip;
}

/**
 * The isolation check, asking `exit(credentials)` for the exit of a new
 * connection with those credentials: one set twice, then
 * `ISOLATION_SETS - 1` more once each. It passes when the first set's two
 * connections share their exit, and the sets' first connections come from
 * at least two.
 */
async function isolation(exit, credentials = freshCredentials) {
  const first = credentials();
  const same = [await exit(first), await exit(first)];
  const distinct = [same[0]];
  for (let i = 1; i < ISOLATION_SETS; i += 1) {
    distinct.push(await exit(credentials()));
  }
  const exits = new Set(distinct).size;
  return {
    ok: same[0] === same[1] && exits >= 2,
    same_credentials: same,
    distinct_credentials: distinct,
    exits,
  };
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
/**
 * New RFC 1929 credentials, as an IPFS instance's are made: a fixed
 * username and 128 random bits. Each set is an isolated circuit of its own
 * in Arti.
 */
function freshCredentials() {
  return {
    username: 'freedom-ipfs-qualification',
    password: crypto.randomBytes(16).toString('hex'),
  };
}

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
    // `credentials()` is asked once per attempt.
    const resolveWith = (credentials) =>
      check(async () => {
        const { code, address } = await socks5Request(
          proxy,
          { command: 'resolve', name: options.name },
          { credentials: credentials() }
        );
        return { ok: code === 0 && isUsableAnswer(address), code, address };
      });
    report.resolve = await resolveWith(() => null);
    report.resolve_with_credentials = await resolveWith(freshCredentials);
    if (options.isolation) {
      report.isolation = await check(() =>
        isolation((credentials) => exitAddress(proxy, credentials, options.echoUrl))
      );
    }
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
  isolation,
  exitAddress,
  qualify,
};
