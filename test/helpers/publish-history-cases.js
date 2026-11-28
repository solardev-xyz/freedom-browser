/**
 * publish-history.js's store cases for the core's history (freedom-core
 * design 0015, "Methods main calls": `swarm.history`, with core PR K1's
 * `add` and `update`; D3, D7 and D10; the SWM-6 to SWM-9 plan's PR 6.4),
 * played through main with its hello naming `swarm_stores` and through the
 * reference (test/helpers/reference-publish-history.js) on a root of its
 * own, the same sequence on each: publish-history.test.js's cases, and what
 * the reference throws, in the forms main sends them.
 *
 * Each case is a world (`legacy`, the legacy publish-history.json's text,
 * and `migrated`, its `.migrated` beside it, each written before the
 * history opens, or none) and its steps:
 * - `['chrome', channel]`: the chrome's request, to the channel's handler
 *   (publish-history.js `registerPublishHistoryIpc`);
 * - `['main', fn, ...args]`: one of main's own calls, publish-history.js's
 *   function `fn` (`MAIN_FNS`), which `coreOps` stands for on the core.
 * Ids a step names are the rows' own: both sides number rows alike, from 1.
 *
 * `playPublishHistoryCase(kase, { main, reference, between, gapMs })` plays
 * the steps on `main`, then, after `between()`, on `reference` (each `{
 * chrome(channel), main(fn, args) }`), waiting `gapMs` after each step so
 * each side's clock moves on (a row's time orders the list), and resolves
 * with `[{ step, main, reference }]`, each answer `answerOf`'s form. One
 * side runs at a time: a simulated core may run the reference module
 * itself.
 *
 * `askedOf(step)` is the op a step asks the core, `[method, op, caller]`:
 * the chrome's as `chrome`, main's own as `shell`.
 */

/** Main's own calls: publish-history.js's functions, and the core's op for each. */
const MAIN_FNS = Object.freeze({
  addEntry: 'add',
  updateEntry: 'update',
  getEntries: 'list',
  clearEntries: 'clear',
  removeEntry: 'remove',
});

/** The chrome's channels, and the core's op each relays. */
const CHROME_CHANNELS = Object.freeze({
  'swarm:get-publish-history': 'list',
  'swarm:clear-publish-history': 'clear',
});

/** The history's file and the legacy file, under a Freedom root. */
const HISTORY_FILE = 'publish-history.sqlite';
const LEGACY_FILE = 'publish-history.json';
const MIGRATED_FILE = 'publish-history.json.migrated';

const legacyText = (entries) => JSON.stringify({ version: 1, entries });

const add = (entry) => ['main', 'addEntry', entry];
const update = (id, updates) => ['main', 'updateEntry', id, updates];
const list = ['main', 'getEntries'];

const PUBLISH_HISTORY_CASES = Object.freeze([
  {
    name: 'addEntry inserts a row with generated id and uploading status',
    steps: [add({ type: 'file', name: 'test.txt', status: 'uploading' }), list],
  },
  {
    name: 'addEntry with completed status sets completedAt immediately',
    steps: [add({ type: 'data', status: 'completed', reference: 'abc' })],
  },
  {
    name: 'updateEntry transitions status, reference, bzzUrl, tagUid, batchIdUsed',
    steps: [
      add({ type: 'directory', name: 'site', status: 'uploading' }),
      update(1, {
        status: 'completed',
        reference: 'deadbeef',
        bzzUrl: 'bzz://deadbeef',
        tagUid: 42,
        batchIdUsed: 'batch1',
      }),
      list,
    ],
  },
  {
    name: 'updateEntry returns null for unknown id',
    steps: [update(99999, { status: 'failed' })],
  },
  {
    name: 'updateEntry to status=failed records the error message',
    steps: [
      add({ type: 'data', status: 'uploading' }),
      update(1, { status: 'failed', errorMessage: 'stamp expired' }),
    ],
  },
  {
    name: 'getEntries returns rows newest-first and includes new columns',
    steps: [
      add({ type: 'data', name: 'first', origin: 'freedom://publish' }),
      add({ type: 'directory', name: 'second', origin: 'https://dapp.example' }),
      list,
    ],
  },
  {
    name: 'removeEntry deletes by id; clearEntries empties everything',
    steps: [
      add({ type: 'data', name: 'keep' }),
      add({ type: 'data', name: 'drop' }),
      ['main', 'removeEntry', 2],
      ['main', 'removeEntry', 2],
      list,
      ['main', 'clearEntries'],
      list,
    ],
  },
  {
    name: 'handles 200+ entries without a cap',
    steps: [...Array.from({ length: 250 }, (_, i) => add({ type: 'data', name: `e${i}` })), list],
  },
  {
    name: 'the legacy publish-history.json is imported at the first open and renamed',
    legacy: legacyText([
      {
        id: 'legacy-1',
        type: 'directory',
        name: 'old-site',
        status: 'completed',
        reference: 'legacyref',
        bzzUrl: 'bzz://legacyref',
        tagUid: 100,
        batchIdUsed: 'legacybatch',
        timestamp: '2026-04-15T19:30:32.540Z',
      },
      {
        id: 'legacy-2',
        type: 'feed-create',
        name: 'feed-x',
        status: 'completed',
        timestamp: '2026-04-15T19:31:00.000Z',
      },
    ]),
    steps: [list, add({ type: 'data', name: 'after' }), list],
  },
  {
    name: 'no legacy file, no import and no error',
    steps: [list],
  },
  {
    name: 'a stray publish-history.json beside its .migrated is dropped, not imported',
    legacy: legacyText([
      { type: 'data', name: 'stray', status: 'completed', timestamp: '2026-04-15T19:30:32.540Z' },
    ]),
    migrated: '{}',
    steps: [list],
  },
  {
    name: 'an uploading row left behind is swept to failed at the open',
    legacy: legacyText([
      { type: 'data', name: 'orphan', status: 'uploading', timestamp: '2026-04-15T19:30:32.540Z' },
    ]),
    steps: [list],
  },
  {
    name: "the chrome's handlers wrap list and clear",
    steps: [
      add({ type: 'data', name: 'one' }),
      ['chrome', 'swarm:get-publish-history'],
      ['chrome', 'swarm:clear-publish-history'],
      ['chrome', 'swarm:get-publish-history'],
      list,
    ],
  },
  {
    // The rows main's own callers write: freedom://publish's handlers'
    // (publish-service.js) and the agent's (freedom://agent, before the
    // upload), each updated after it.
    name: "freedom://publish's and the agent's rows, each updated after its upload",
    steps: [
      add({ type: 'file', name: 'notes.txt', status: 'uploading', origin: 'freedom://publish' }),
      add({
        type: 'directory',
        name: 'site (private draft link)',
        status: 'uploading',
        origin: 'freedom://agent',
        bytesSize: 4096,
      }),
      update(1, {
        status: 'completed',
        reference: 'ab'.repeat(32),
        bzzUrl: `bzz://${'ab'.repeat(32)}`,
        tagUid: 7,
        batchIdUsed: 'cd'.repeat(32),
        bytesSize: 12,
      }),
      update(2, { status: 'uploading', errorMessage: 'Waiting for postage' }),
      update(2, { status: 'failed', errorMessage: 'The node did not encrypt this upload' }),
      list,
    ],
  },
  {
    name: 'what the reference throws, the core throws',
    steps: [
      ['main', 'addEntry', null],
      ['main', 'addEntry', { type: 'data', tagUid: true }],
      ['main', 'addEntry'],
      update(1, null),
      update(1, { tagUid: true }),
      ['main', 'updateEntry', 1],
      ['main', 'removeEntry', true],
      ['main', 'removeEntry'],
      list,
    ],
  },
]);

// A row's times, which each side takes from its own clock.
const TIMES = new Set(['timestamp', 'completedAt']);
// Times at or after this are a side's own clock's; a legacy row's (from the
// legacy file, the same on both sides) are earlier, and stay as they are.
const CLOCK_SINCE = Date.now() - 60_000;

/** `value` with each time a side's clock made `'now'`, null kept. */
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      TIMES.has(key) && typeof inner === 'string' && Date.parse(inner) >= CLOCK_SINCE
        ? 'now'
        : normalized(inner);
  }
  return out;
}

/**
 * A step's answer: `{ result }` (normalized), or `{ error: { name, message,
 * code } }` for what it threw, its class's name and its code (or null).
 */
async function answerOf(run) {
  try {
    return { result: normalized(await run()) };
  } catch (err) {
    return { error: { name: err?.name, message: err?.message, code: err?.code ?? null } };
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays `step` on `side`. */
function playStep(side, [kind, name, ...args]) {
  if (kind === 'chrome') return answerOf(() => side.chrome(name));
  if (kind === 'main') {
    if (!Object.hasOwn(MAIN_FNS, name)) throw new TypeError(`unknown main call ${name}`);
    return answerOf(() => side.main(name, args));
  }
  throw new TypeError(`unknown step ${kind}`);
}

async function playSteps(side, steps, gapMs) {
  const answers = [];
  for (const step of steps) {
    answers.push(await playStep(side, step));
    await pause(gapMs);
  }
  return answers;
}

async function playPublishHistoryCase(kase, { main, reference, between = null, gapMs = 3 }) {
  const mainAnswers = await playSteps(main, kase.steps, gapMs);
  if (between) await between();
  const referenceAnswers = await playSteps(reference, kase.steps, gapMs);
  return kase.steps.map((step, i) => ({
    step,
    main: mainAnswers[i],
    reference: referenceAnswers[i],
  }));
}

/** The op a step asks the core, `[method, op, caller]`. */
function askedOf([kind, name]) {
  if (kind === 'chrome') return ['swarm.history', CHROME_CHANNELS[name], 'chrome'];
  return ['swarm.history', MAIN_FNS[name], 'shell'];
}

/** Writes a case's legacy files under `dir`, as a profile holds them before the history opens. */
function seedLegacy(kase, dir) {
  const fs = require('fs');
  const path = require('path');
  if (kase.legacy !== undefined) fs.writeFileSync(path.join(dir, LEGACY_FILE), kase.legacy);
  if (kase.migrated !== undefined) fs.writeFileSync(path.join(dir, MIGRATED_FILE), kase.migrated);
}

/** Which legacy files are under `dir`: `{ legacy, migrated }`, each a boolean. */
function legacyFiles(dir) {
  const fs = require('fs');
  const path = require('path');
  return {
    legacy: fs.existsSync(path.join(dir, LEGACY_FILE)),
    migrated: fs.existsSync(path.join(dir, MIGRATED_FILE)),
  };
}

module.exports = {
  PUBLISH_HISTORY_CASES,
  MAIN_FNS,
  CHROME_CHANNELS,
  HISTORY_FILE,
  LEGACY_FILE,
  MIGRATED_FILE,
  normalized,
  answerOf,
  askedOf,
  playPublishHistoryCase,
  seedLegacy,
  legacyFiles,
};
