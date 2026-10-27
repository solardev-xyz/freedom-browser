'use strict';

// The racer behind the macOS and Windows S1 cleanup regressions, checked on
// every platform: those two only run on their own runners, so this is where
// a racer that quietly stopped racing would be noticed first.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  startCleanupRacer,
  raceCleanup,
  racerNames,
  pinTarget,
  unpinTarget,
  SUBDIRECTORY,
  CANARY,
} = require('./cleanup-racer');

jest.setTimeout(30_000);

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fixture;
beforeEach(async () => {
  fixture = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-cleanup-racer-'))
  );
});
afterEach(async () => {
  await fs.promises.rm(fixture, { recursive: true, force: true });
});

// The shape S1 replaced: decide by `lstat`, then act on the path afterwards.
// Anything that resolves `sub/<name>` after the racer swapped the link in
// deletes the outside file of that name.
// It yields between looks: a synchronous spin on `lstat` kept a CPU busy and,
// on a loaded CI runner, starved the racer process of the time to put its
// directory back, so the walk ran out of time without ever catching it (the
// `test` job of run 39881059597).
const PATH_WALK_MS = 20_000;
const pathWalkingCleanup = (names) => async (target) => {
  const sub = path.join(target, SUBDIRECTORY);
  const deadline = Date.now() + PATH_WALK_MS;
  while (Date.now() < deadline) {
    let stats;
    try {
      stats = fs.lstatSync(sub);
    } catch {
      await sleep(0);
      continue;
    }
    if (!stats.isDirectory()) {
      await sleep(0);
      continue;
    }
    await sleep(2);
    for (const name of names) {
      try {
        fs.unlinkSync(path.join(sub, name));
      } catch {
        // The racer moved it; keep walking.
      }
    }
    const outside = fs.readdirSync(path.join(path.dirname(target), 'outside'));
    if (outside.length < names.length) break;
  }
  throw new Error('path-walking cleanup gave up');
};

// Takes the whole tree out of the racer's reach in one rename before deleting
// it, so nothing resolves a path the racer can still change. The pause stands
// in for a real cleanup's start-up (spawning `sandbox-exec`, the Windows
// helper), during which the racer keeps swapping.
const renameAwayCleanup = async (target) => {
  await sleep(50);
  const quarantine = `${target}.removing`;
  await fs.promises.rename(target, quarantine);
  await fs.promises.rm(quarantine, { recursive: true, force: true });
};

test('alternates the subdirectory between a real directory and a link to the outside', async () => {
  const target = path.join(fixture, 'work');
  const outside = path.join(fixture, 'outside');
  const names = racerNames(4);
  await fs.promises.mkdir(target);
  await fs.promises.mkdir(outside);
  for (const name of names) await fs.promises.writeFile(path.join(outside, name), 'preserved');
  const racer = await startCleanupRacer({ target, outside, names, linkType, maxMs: 5000 });
  const seen = new Set();
  const linkTargets = new Set();
  try {
    const deadline = Date.now() + 3000;
    while (seen.size < 2 && Date.now() < deadline) {
      try {
        const sub = path.join(target, SUBDIRECTORY);
        const stats = fs.lstatSync(sub);
        if (stats.isSymbolicLink()) {
          linkTargets.add(path.resolve(fs.readlinkSync(sub)));
          seen.add('link');
        } else if (stats.isDirectory()) {
          seen.add('directory');
        }
      } catch {
        // Between two states.
      }
      await sleep(0);
    }
  } finally {
    await racer.stop();
  }
  expect([...seen].sort()).toEqual(['directory', 'link']);
  expect([...linkTargets]).toEqual([outside]);
  expect(await racer.exited).toMatchObject({ reason: 'stopped', links: expect.any(Number) });
  expect((await racer.exited).links).toBeGreaterThan(0);
  // The racer itself never writes through its link.
  for (const name of names) {
    expect(await fs.promises.readFile(path.join(outside, name), 'utf8')).toBe('preserved');
  }
});

test('stops by itself once the cleanup has removed the target', async () => {
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names: racerNames(8),
    linkType,
    cleanup: renameAwayCleanup,
  });
  expect(report).toMatchObject({
    overlapped: true,
    preserved: true,
    removed: true,
    firstError: null,
    final: { reason: 'target-removed' },
  });
});

test('retries a cleanup that failed between two swaps until one attempt races a swap', async () => {
  // #779: on a Windows 11 standard user the helper's remove-tree can fail in
  // well under one racer iteration, so a single attempt sometimes never
  // overlapped a swap and the qualification reported a race it never ran.
  // A slow racer makes that deterministic: the first attempt fails at once,
  // long before the next swap; the second waits for a swap, then removes.
  const target = path.join(fixture, 'work');
  const sub = path.join(target, SUBDIRECTORY);
  let calls = 0;
  const report = await raceCleanup({
    target,
    outside: path.join(fixture, 'outside'),
    names: racerNames(4),
    linkType,
    holdMs: 2000,
    cleanup: async (cleanupTarget) => {
      calls += 1;
      if (calls === 1) throw new Error('failed between two swaps');
      const isLink = () => {
        try {
          return fs.lstatSync(sub).isSymbolicLink();
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 10_000;
      while (isLink() && Date.now() < deadline) await sleep(5);
      while (!isLink() && Date.now() < deadline) await sleep(1);
      await renameAwayCleanup(cleanupTarget);
    },
  });
  expect(calls).toBe(2);
  expect(report).toMatchObject({
    overlapped: true,
    attempts: 2,
    preserved: true,
    removed: true,
    firstError: 'failed between two swaps',
  });
});

test('reports no overlap when every attempt fails between two swaps', async () => {
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names: racerNames(4),
    linkType,
    holdMs: 3000,
    attempts: 3,
    cleanup: async () => {
      throw new Error('never races');
    },
  });
  expect(report).toMatchObject({
    overlapped: false,
    attempts: 3,
    preserved: true,
    firstError: 'never races',
  });
});

// A plain recursive delete, as fast as a cleanup gets: no start-up at all.
const plainCleanup = (target) => fs.promises.rm(target, { recursive: true, force: true });

test('reports no overlap when a cleanup removes the target inside an idle hold', async () => {
  // #843 without the gate: the racer has swapped its link in and sits still
  // for `holdMs`; a cleanup that finishes inside that hold removes the whole
  // tree before any swap, and the race ends there with nothing raced. The
  // macOS `sandbox-exec rm` did this now and then; this does it every time.
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names: racerNames(4),
    linkType,
    holdMs: 5000,
    cleanup: plainCleanup,
  });
  expect(report).toMatchObject({
    overlapped: false,
    attempts: 1,
    preserved: true,
    removed: true,
    firstError: null,
    final: { reason: 'target-removed' },
  });
});

// The gate pins the target with a read-only directory, which neither Windows
// permissions nor root respect. Every CI runner that runs this is POSIX and
// not root.
(process.platform === 'win32' ? test.skip : test)(
  'the gate keeps a cleanup from removing the target before a swap',
  async () => {
    // The same cleanup and idle hold as above. Pinned, the target cannot be
    // removed until the racer has swapped after the cleanup's first deletion,
    // so the race can no longer end on a removal that raced nothing. (An
    // attempt that fails on the pin first is retried, as any failed attempt
    // is.)
    //
    // No claim about `preserved` here: `fs.promises.rm` is not confined, and
    // the gate swaps *during* the attempt, so it can lstat `sub` as a
    // directory, find a link there by the time it reads or unlinks inside it,
    // and delete outside files through it. Whether a cleanup survives that is
    // what the platform tests (and the path-walking control below) check; this
    // test checks only that the gate makes every removal come with an overlap.
    const report = await raceCleanup({
      target: path.join(fixture, 'work'),
      outside: path.join(fixture, 'outside'),
      names: racerNames(4),
      linkType,
      holdMs: 5000,
      gate: true,
      cleanup: plainCleanup,
    });
    expect(report).toMatchObject({ removed: true, lastError: null });
    if (report.final.reason === 'target-removed') expect(report.overlapped).toBe(true);
  }
);

(process.platform === 'win32' ? test.skip : test)(
  'a pinned target survives a recursive delete until it is unpinned',
  async () => {
    const target = path.join(fixture, 'work');
    await fs.promises.mkdir(path.join(target, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(target, 'sub', 'decoy'), 'decoy');
    pinTarget(target);
    await expect(plainCleanup(target)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EACCES|EPERM)$/),
    });
    const rm = spawnSync('/bin/rm', ['-rf', '--', target]);
    expect(rm.status).not.toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    unpinTarget(target);
    await plainCleanup(target);
    expect(fs.existsSync(target)).toBe(false);
  }
);

const gatedTest = process.platform === 'win32' ? test.skip : test;

// The canaries the racer planted for the current arm, as `arm` left them.
const canariesIn = (target) => {
  try {
    return fs.readdirSync(target).filter((name) => name.startsWith(`${CANARY}-`));
  } catch {
    return [];
  }
};
const waitFor = async (condition, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(2);
  return condition();
};

// `renameAwayCleanup` for a gated race: the tree it takes away may still carry
// the pin, which a plain delete cannot get through.
const renameAwayPinned = async (target) => {
  await sleep(50);
  const quarantine = `${target}.removing`;
  await fs.promises.rename(target, quarantine);
  unpinTarget(quarantine);
  await fs.promises.rm(quarantine, { recursive: true, force: true });
};

gatedTest(
  'arming pins the target and swaps only once a cleanup has deleted something',
  async () => {
    const target = path.join(fixture, 'work');
    const outside = path.join(fixture, 'outside');
    const hold = path.join(target, 'hold');
    await fs.promises.mkdir(target);
    await fs.promises.mkdir(outside);
    // An idle hold far longer than this test: only a deletion can bring the
    // next swap inside it.
    const racer = await startCleanupRacer({
      target,
      outside,
      names: racerNames(4),
      linkType,
      holdMs: 20_000,
      maxMs: 25_000,
    });
    try {
      const armed = await racer.arm();
      expect(armed.pinned).toBe(true);
      const canaries = canariesIn(target);
      expect(canaries.length).toBeGreaterThan(1);
      // Arming alone swaps nothing: a swap here would come before any cleanup
      // had started (#843 R2-F1).
      await sleep(300);
      expect((await racer.counts()).links).toBe(armed.links);
      expect(fs.existsSync(hold)).toBe(true);
      // The cleanup's first deletion: the racer swaps at once and the pin
      // comes off, but nothing has deleted anything *after* that swap yet.
      fs.unlinkSync(path.join(target, canaries[0]));
      expect(await waitFor(() => !fs.existsSync(hold))).toBe(true);
      const swapped = await racer.counts();
      expect(swapped.links).toBe(armed.links + 1);
      expect(swapped.raced).toBe(armed.raced);
      // A deletion after the swap: the cleanup was running on both sides of it.
      fs.unlinkSync(path.join(target, canaries[1]));
      expect((await racer.counts()).raced).toBe(armed.raced + 1);
    } finally {
      await racer.stop();
    }
  }
);

gatedTest(
  'the gate does not count a swap that came before the cleanup reached the tree',
  async () => {
    // R2-F1: the first version of the gate swapped as soon as it was armed,
    // usually before the cleanup had started, and counted that swap as the
    // overlap. A cleanup that then removed the tree inside the idle hold after
    // it, raced nothing and still came back `overlapped: true`. This cleanup
    // does exactly that: it waits out what the arm did and takes the tree in
    // one rename while the link sits still.
    const report = await raceCleanup({
      target: path.join(fixture, 'work'),
      outside: path.join(fixture, 'outside'),
      names: racerNames(4),
      linkType,
      holdMs: 5000,
      gate: true,
      cleanup: renameAwayPinned,
    });
    expect(report).toMatchObject({
      overlapped: false,
      attempts: 1,
      preserved: true,
      removed: true,
      firstError: null,
      final: { reason: 'target-removed', raced: 0 },
    });
  }
);

gatedTest('the gate counts a swap with cleanup deletions on both sides of it', async () => {
  const target = path.join(fixture, 'work');
  const hold = path.join(target, 'hold');
  const report = await raceCleanup({
    target,
    outside: path.join(fixture, 'outside'),
    names: racerNames(4),
    linkType,
    holdMs: 5000,
    gate: true,
    cleanup: async (cleanupTarget) => {
      const [first, second] = canariesIn(cleanupTarget);
      fs.unlinkSync(path.join(cleanupTarget, first));
      // The racer's swap, which releases the pin.
      if (!(await waitFor(() => !fs.existsSync(hold)))) throw new Error('never released');
      fs.unlinkSync(path.join(cleanupTarget, second));
      await renameAwayPinned(cleanupTarget);
    },
  });
  expect(report).toMatchObject({
    overlapped: true,
    attempts: 1,
    preserved: true,
    removed: true,
    firstError: null,
    final: { reason: 'target-removed', raced: 1 },
  });
});

// A spawned `rm`, as the macOS cleanup is: it reaches the tree only after its
// own start-up, which the first version of the gate swapped through.
const spawnedRm = (target) =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/rm', ['-rf', '--', target]);
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rm exited ${code}`))));
  });

gatedTest('under the gate, a spawned rm removes the target only after racing a swap', async () => {
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names: racerNames(4),
    linkType,
    gate: true,
    cleanup: spawnedRm,
  });
  expect(report).toMatchObject({ removed: true, lastError: null });
  if (report.final.reason === 'target-removed') expect(report.overlapped).toBe(true);
  if (report.overlapped) expect(report.final.raced).toBeGreaterThan(0);
});

test('reports the outside files a path-walking cleanup deleted through the link', async () => {
  // The negative control: the same race the platform tests run, against a
  // cleanup that is not confined, has to come back `preserved: false`. If the
  // racer ever stopped swapping, this is the test that would go green
  // without it.
  const names = racerNames(16);
  let walked = false;
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names,
    linkType,
    // Outlast the walk, so the racer is still swapping whenever it looks.
    maxMs: PATH_WALK_MS + 5_000,
    cleanup: async (target) => {
      if (!walked) {
        walked = true;
        await pathWalkingCleanup(names)(target).catch(() => {});
      }
      await fs.promises.rm(target, { recursive: true, force: true });
    },
  });
  expect(report.overlapped).toBe(true);
  expect(report.preserved).toBe(false);
  expect(report.missing.length).toBeGreaterThan(0);
});

test('fails to start, rather than hanging, when the target does not exist', async () => {
  await expect(
    startCleanupRacer({
      target: path.join(fixture, 'missing'),
      outside: fixture,
      names: ['a'],
      linkType,
      maxMs: 2000,
    })
  ).rejects.toThrow('never swapped in a link (target-removed)');
});
