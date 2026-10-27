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
// The gate's pin: a read-only directory holding one file, which a cleanup
// running as an ordinary user cannot empty, so it cannot remove the target.
const HOLD = 'hold';

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

// The gate (`raceCleanup({ gate: true })`, POSIX only). Pinning the tree with
// a directory the cleanup cannot empty, and releasing it only once a link has
// been swapped in, means no cleanup attempt can remove the target before the
// racer has swapped during it.
function pinTarget(target) {
  const hold = path.join(target, HOLD);
  if (present(hold)) return;
  fs.mkdirSync(hold);
  fs.writeFileSync(path.join(hold, 'pin'), 'pin');
  fs.chmodSync(hold, 0o555);
}

function unpinTarget(target) {
  const hold = path.join(target, HOLD);
  if (!present(hold)) return;
  fs.chmodSync(hold, 0o755);
  fs.rmSync(hold, { recursive: true, force: true });
}

async function race({ target, outside, names, linkType, holdMs, maxMs }) {
  const sub = path.join(target, SUBDIRECTORY);
  const counts = { directories: 0, links: 0, errors: 0 };
  let stopping = false;
  let announced = false;
  let armed = false;
  let wake = null;
  let generation = 0;
  let reason = 'deadline';
  process.on('message', (message) => {
    if (message === 'counts') process.send({ type: 'counts', counts: { ...counts } });
    if (message === 'stop') {
      stopping = true;
      wake?.();
    }
    if (message === 'arm') {
      // Pin the tree, then cut the current hold short so the next swap starts
      // now rather than after a link has sat idle in place.
      let pinned = false;
      try {
        pinTarget(target);
        pinned = true;
        armed = true;
      } catch {
        // The target is gone; the loop will notice and report it.
      }
      process.send({ type: 'armed', pinned, counts: { ...counts } });
      wake?.();
    }
  });
  const hold = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, holdMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = null;
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
      if (armed) {
        armed = false;
        unpinTarget(target);
      }
      if (!announced) {
        announced = true;
        process.send({ type: 'ready' });
      }
      await hold();
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
  try {
    unpinTarget(target);
  } catch {
    // Leave it for the caller's final cleanup to report as `removed: false`.
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
  // A racer that has just seen the target go is already disconnecting: a send
  // that loses that race fails with EPIPE, and the exit settles the waiter.
  const ignoreSendError = () => {};
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
      if (child.connected) child.send('counts', ignoreSendError);
      const message = await reply;
      return message.type === 'counts' ? message.counts : final;
    },
    /**
     * Pin the target until the racer's next swap, and start that swap now.
     * Returns the counts at the moment of pinning, or the final ones if the
     * racer has already stopped.
     */
    async arm() {
      if (final) return { ...final, pinned: false };
      const reply = next(['armed', 'done']);
      if (child.connected) child.send('arm', ignoreSendError);
      const message = await reply;
      return message.type === 'armed'
        ? { ...message.counts, pinned: message.pinned }
        : { ...final, pinned: false };
    },
    /** Stop racing (if it has not already) and return the final counts. */
    async stop() {
      if (!final && child.connected) child.send('stop', ignoreSendError);
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
 *
 * Retrying only covers attempts that fail. An attempt that *succeeds* inside
 * one of the racer's idle holds, with the link sitting still in place, removes
 * the target without a swap and ends the race with `overlapped: false` (#843:
 * the macOS `sandbox-exec rm` sometimes did; a plain `rm -rf` on Linux does
 * every time). `gate: true` closes that: before each attempt the racer pins
 * the target with a read-only directory (see `pinTarget`) that it releases
 * only after its next swap, and starts that swap at once. A cleanup running as
 * an ordinary user then cannot remove the target unless a link was swapped in
 * after the attempt began, so a removed target always comes with
 * `overlapped: true`. POSIX permissions only: not for Windows, and not for a
 * cleanup running as root.
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
  gate = false,
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
      if (gate) {
        start = await racer.arm();
        // The racer has stopped (its deadline), so there is nothing to race.
        if (!start.pinned) break;
      }
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

module.exports = {
  startCleanupRacer,
  raceCleanup,
  racerNames,
  pinTarget,
  unpinTarget,
  SUBDIRECTORY,
};
