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
// The gate's evidence that a cleanup is running: files at the top of the tree
// that only a cleanup removes. Enough of them that a recursive delete is still
// working through them after the racer has seen the first go and swapped.
const CANARY = 'canary';
const CANARIES = 256;

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
// a directory the cleanup cannot empty, and releasing it only on a swap made
// after the cleanup has visibly started deleting, means no cleanup attempt can
// remove the target before the racer has swapped during it.
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

// How many of this arm's canaries a cleanup has removed so far, or null once
// the target itself is gone.
function canariesGone(target, canaries) {
  let entries;
  try {
    entries = new Set(fs.readdirSync(target));
  } catch {
    return null;
  }
  let gone = 0;
  for (const name of canaries) if (!entries.has(name)) gone += 1;
  return gone;
}

async function race({ target, outside, names, linkType, holdMs, maxMs }) {
  const sub = path.join(target, SUBDIRECTORY);
  // `raced` counts the gate's evidence of a real overlap: a swap with a
  // cleanup deletion seen before it began and another (or the target's
  // removal) after it was done, so the cleanup was running on both sides.
  const counts = { directories: 0, links: 0, errors: 0, raced: 0 };
  let stopping = false;
  let announced = false;
  let wake = null;
  let watchHold = null;
  let generation = 0;
  let reason = 'deadline';
  // Gate state, reset by every arm: the canaries planted for this attempt,
  // whether the pin is still on, and the swap waiting for a later deletion.
  let arm = null;
  let arms = 0;
  // A swap made after a deletion becomes `raced` once anything more is gone.
  const settle = () => {
    if (!arm?.pending) return false;
    const gone = canariesGone(target, arm.canaries);
    if (gone !== null && gone <= arm.pending.gone) return false;
    arm.pending = null;
    counts.raced += 1;
    return true;
  };
  process.on('message', (message) => {
    if (message === 'counts') {
      settle();
      process.send({ type: 'counts', counts: { ...counts } });
    }
    if (message === 'stop') {
      stopping = true;
      wake?.();
    }
    if (message === 'arm') {
      // Pin the tree and plant fresh canaries. No swap is started here: one
      // made now would land before the cleanup has even started, and the
      // cleanup could then run inside the idle hold after it (#843 again).
      let pinned = false;
      arm = null;
      try {
        pinTarget(target);
        const canaries = [];
        arms += 1;
        for (let index = 0; index < CANARIES; index += 1) {
          const name = `${CANARY}-${arms}-${index}`;
          fs.writeFileSync(path.join(target, name), CANARY);
          canaries.push(name);
        }
        arm = { canaries, pinned: true, pending: null };
        pinned = true;
      } catch {
        // The target is gone; the loop will notice and report it.
      }
      process.send({ type: 'armed', pinned, counts: { ...counts } });
      // A hold already under way when the arm came starts watching now.
      watchHold?.();
    }
  });
  // Ungated, a plain idle hold. Armed, it also watches the canaries: it ends
  // at the cleanup's first deletion, so the swap that follows is one made
  // during the cleanup, and it settles a pending swap as soon as it can.
  const hold = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, holdMs);
      wake = finish;
      let watching = false;
      const watch = () => {
        if (done || !arm) {
          watching = false;
          return;
        }
        settle();
        const gone = canariesGone(target, arm.canaries);
        if (gone === null || (arm.pinned && gone > 0)) return finish();
        setImmediate(watch);
      };
      watchHold = () => {
        if (watching || done) return;
        watching = true;
        setImmediate(watch);
      };
      watchHold();
    }).finally(() => {
      wake = null;
      watchHold = null;
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
      // Has the cleanup already deleted something? Measured before the swap
      // starts, so a deletion seen here came before it.
      const started = arm ? canariesGone(target, arm.canaries) > 0 : false;
      setAside();
      fs.symlinkSync(outside, sub, linkType);
      counts.links += 1;
      if (started) {
        // Measured after the swap is done, so anything gone beyond this was
        // deleted after it.
        if (!arm.pending) arm.pending = { gone: canariesGone(target, arm.canaries) ?? 0 };
        if (arm.pinned) {
          arm.pinned = false;
          unpinTarget(target);
        }
      }
      if (!announced) {
        announced = true;
        process.send({ type: 'ready' });
      }
      await hold();
      removeLink(sub);
    } catch {
      if (!present(target)) {
        settle();
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
     * Pin the target and plant canaries for one gated attempt: the pin comes
     * off on the first swap after a cleanup has removed a canary. Returns the
     * counts at the moment of pinning, or the final ones if the racer has
     * already stopped.
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
 * the target with a read-only directory (see `pinTarget`) and plants canary
 * files beside it. It releases the pin only on a swap that began after a
 * canary was gone, so a cleanup running as an ordinary user cannot remove the
 * target until a link was swapped in while it was deleting. A gated attempt
 * counts as `overlapped` only for such a swap with a further deletion (or the
 * target's removal) after it, so the cleanup was running before and after the
 * swap; a swap that merely happened after `arm` and before the cleanup reached
 * the tree, which an earlier version of the gate counted, no longer does.
 * POSIX permissions only: not for Windows, and not for a cleanup running as
 * root.
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
      if (gate ? end.raced > start.raced : end.links > start.links) {
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
  CANARY,
};
