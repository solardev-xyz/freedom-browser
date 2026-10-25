'use strict';

// A surviving workload process that keeps swapping a subdirectory of a cleanup
// target between a real directory and a link to an outside directory, for the
// S1 cleanup regressions (macOS `removeSandboxTree`, Windows `remove-tree`).
//
// The racer runs in its own process, as a real survivor would, so the cleanup
// under test races an independent scheduler rather than this one's event loop.
// Inside the real directory it writes decoys under the same names as the
// outside files: a cleanup that resolves `sub/<name>` through the link once it
// is swapped in deletes the outside file, which `raceCleanup` then reports.
//
// Used by `secure-files.test.js` (macOS) and `scripts/qualify-windows-workspace.js`
// (Windows), and unit-tested on every platform by `cleanup-racer.test.js`.
// Lives under `__tests__/`, which the packaged app never includes.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SUBDIRECTORY = 'sub';
const PRESERVED = 'preserved';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function present(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// A Windows junction is a directory reparse point: `unlink` refuses it on some
// Node releases, `rmdir` removes the link and never its target.
function removeLink(link) {
  try {
    fs.unlinkSync(link);
  } catch (error) {
    if (!['EPERM', 'EISDIR'].includes(error.code)) throw error;
    fs.rmdirSync(link);
  }
}

async function race({ target, outside, names, linkType, holdMs, maxMs }) {
  const sub = path.join(target, SUBDIRECTORY);
  const counts = { directories: 0, links: 0, errors: 0 };
  let stopping = false;
  let announced = false;
  let generation = 0;
  let reason = 'deadline';
  process.on('message', (message) => {
    if (message === 'counts') process.send({ type: 'counts', counts: { ...counts } });
    if (message === 'stop') stopping = true;
  });
  // Set the current real directory aside under a fresh name, so the cleanup
  // still has it to walk while the link takes its place.
  const setAside = () => fs.renameSync(sub, path.join(target, `moved-${generation++}`));
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (stopping) {
      reason = 'stopped';
      break;
    }
    try {
      fs.mkdirSync(sub);
      for (const name of names) fs.writeFileSync(path.join(sub, name), 'inside decoy');
      counts.directories += 1;
      // Let a cleanup that is reading this directory get into it.
      await tick();
      setAside();
      fs.symlinkSync(outside, sub, linkType);
      counts.links += 1;
      if (!announced) {
        announced = true;
        process.send({ type: 'ready' });
      }
      await sleep(holdMs);
      removeLink(sub);
    } catch {
      if (!present(target)) {
        reason = 'target-removed';
        break;
      }
      counts.errors += 1;
      // The cleanup took part of the tree from under us. Put `sub` back into a
      // known state and carry on.
      try {
        const stats = fs.lstatSync(sub);
        if (stats.isSymbolicLink()) removeLink(sub);
        else setAside();
      } catch {
        // Already gone, or the cleanup is removing it right now.
      }
      await tick();
    }
  }
  process.send({ type: 'done', counts: { ...counts }, reason }, () => process.disconnect());
}

/**
 * Start the racer against `target`, which must exist. Resolves once the first
 * link has been swapped in, so a cleanup started after that is racing it.
 */
function startCleanupRacer({
  target,
  outside,
  names,
  linkType = 'dir',
  holdMs = 4,
  maxMs = 10000,
}) {
  const child = spawn(
    process.execPath,
    [__filename, JSON.stringify({ target, outside, names, linkType, holdMs, maxMs })],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }
  );
  let final = null;
  const waiters = new Set();
  const settle = (message) => {
    for (const waiter of [...waiters]) waiter(message);
  };
  child.on('message', (message) => {
    if (message?.type === 'done') final = { ...message.counts, reason: message.reason };
    settle(message);
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      final = final || { reason: `exited ${code ?? signal}` };
      settle({ type: 'exit' });
      resolve(final);
    });
  });
  // The next message of one of `types`, or the racer's exit, whichever is first.
  const next = (types) =>
    new Promise((resolve) => {
      if (final && child.exitCode !== null) return resolve({ type: 'exit' });
      const waiter = (message) => {
        if (!types.includes(message.type) && message.type !== 'exit') return;
        waiters.delete(waiter);
        resolve(message);
      };
      waiters.add(waiter);
    });
  const racer = {
    /** The swap counts now, or the final ones if the racer has already stopped. */
    async counts() {
      if (final) return final;
      const reply = next(['counts', 'done']);
      if (child.connected) child.send('counts');
      const message = await reply;
      return message.type === 'counts' ? message.counts : final;
    },
    /** Stop racing (if it has not already) and return the final counts. */
    async stop() {
      if (!final && child.connected) child.send('stop');
      return exited;
    },
    exited,
  };
  return next(['ready', 'done']).then(async (message) => {
    if (message.type === 'ready') return racer;
    await exited;
    throw new Error(`Cleanup racer never swapped in a link (${final?.reason})`);
  });
}

/**
 * Run `cleanup(target)` while a racer swaps `target/sub` for a link to
 * `outside`, then report what the race did.
 *
 * `overlapped` is true when a link was swapped in while a cleanup attempt
 * was running; `preserved` when every outside file still holds its original
 * contents. The cleanup is allowed to fail while the racer keeps the tree
 * non-empty, and is retried, up to `attempts` times, until one attempt has
 * overlapped a swap or removed the target: a single fast attempt can fail
 * between two swaps without ever racing one (seen on a Windows 11 standard
 * user with Defender on, #779), which says nothing about the cleanup.
 * Once the racer has stopped, `cleanup` runs again and `removed` says
 * whether the target is gone.
 */
async function raceCleanup({
  target,
  outside,
  names,
  linkType,
  cleanup,
  holdMs,
  maxMs,
  attempts = 10,
}) {
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.mkdir(outside, { recursive: true });
  for (const name of names) await fs.promises.writeFile(path.join(outside, name), PRESERVED);
  const racer = await startCleanupRacer({ target, outside, names, linkType, holdMs, maxMs });
  let before;
  let during;
  let firstError = null;
  let overlapped = false;
  let made = 0;
  try {
    before = await racer.counts();
    let start = before;
    while (made < attempts) {
      made += 1;
      try {
        await cleanup(target);
      } catch (error) {
        firstError = firstError ?? error.message;
      }
      const end = await racer.counts();
      if (end.links > start.links) {
        overlapped = true;
        break;
      }
      if (!present(target)) break;
      start = end;
    }
    during = await racer.counts();
  } finally {
    await racer.stop();
  }
  const final = await racer.exited;
  let lastError = null;
  if (present(target)) {
    try {
      await cleanup(target);
    } catch (error) {
      lastError = error.message;
    }
  }
  const survivors = (await fs.promises.readdir(outside)).sort();
  const intact = await Promise.all(
    names.map(async (name) => {
      try {
        return (await fs.promises.readFile(path.join(outside, name), 'utf8')) === PRESERVED;
      } catch {
        return false;
      }
    })
  );
  return {
    overlapped,
    attempts: made,
    preserved: intact.every(Boolean) && survivors.length === names.length,
    removed: !present(target),
    missing: names.filter((_name, index) => !intact[index]),
    before,
    during,
    final,
    firstError,
    lastError,
  };
}

/** `count` outside file names, enough for a recursive delete to dwell in `sub`. */
const racerNames = (count = 64) => Array.from({ length: count }, (_, index) => `f${index}.txt`);

if (require.main === module) {
  race(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { startCleanupRacer, raceCleanup, racerNames, SUBDIRECTORY };
