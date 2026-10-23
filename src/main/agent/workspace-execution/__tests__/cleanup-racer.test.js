'use strict';

// The racer behind the macOS and Windows S1 cleanup regressions, checked on
// every platform: those two only run on their own runners, so this is where
// a racer that quietly stopped racing would be noticed first.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startCleanupRacer, raceCleanup, racerNames, SUBDIRECTORY } = require('./cleanup-racer');

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
  expect(report).toMatchObject({ overlapped: false, attempts: 3, preserved: true, firstError: 'never races' });
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
