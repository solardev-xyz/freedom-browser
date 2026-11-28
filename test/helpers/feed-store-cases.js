/**
 * feed-store.js's store cases for the core's feed store (freedom-core design
 * 0015, D3, D7 and D8; the SWM-6 to SWM-9 plan's PR 6.2), played through
 * main with its hello naming `swarm_stores` and through the reference
 * (test/helpers/reference-feed-store.js) on a root of its own, the same
 * sequence on each: feed-store.test.js's cases for what the move hands to
 * the core, in the forms main sends them.
 *
 * Each case is a world (`seed`, swarm-feeds.json's text before the store
 * loads, or none; the vault `unlocked` unless `locked`) and its steps:
 * - `['chrome', channel, ...args]`: the chrome's request, to the channel's
 *   handler (feed-store.js `registerFeedStoreIpc`);
 * - `['main', op, ...args]`: one of main's own ops, with the arguments
 *   page-swarm.js's feed prompt or identity-manager.js's account removal
 *   gives it (`MAIN_OPS`);
 * - `['vault', 'lock' | 'unlock']`.
 *
 * `playFeedStoreCase(kase, { main, reference, between, gapMs })` plays the
 * steps on `main`, then, after `between()`, on `reference` (each `{
 * chrome(channel, args), main(op, args), vault(state) }`), waiting `gapMs`
 * after each step so each side's clock moves on (their stamps, normalized
 * away, still order identities and sites), and resolves with `[{ step,
 * main, reference }]`, each answer `answerOf`'s form. One side runs at a
 * time: a simulated core may run the reference module itself.
 */

const IPC = require('../../src/shared/ipc-channels');

/**
 * Main's own ops as their callers call them, `[shell args, js args]` from
 * the case's arguments: the core's op takes the function's arguments
 * without `source` (feed-store.js `coreOps`), the JS function takes
 * page-swarm.js's own (`source: 'user'`).
 */
const MAIN_OPS = Object.freeze({
  hasFeedGrant: (key) => [[key], [key]],
  getOriginIdentityStateWithOwners: (key) => [[key], [key]],
  previewAppScopedIdentity: (key) => [[key], [key]],
  createAppScopedIdentityAt: (key, index) => [
    [key, index, { activate: true }],
    [key, index, { activate: true, source: 'user' }],
  ],
  ensureAntWalletIdentity: (key) => [
    [key, { activate: true }],
    [key, { activate: true, source: 'user' }],
  ],
  activateIdentity: (key, id) => [
    [key, id],
    [key, id, { source: 'user' }],
  ],
  assertFeedGrantable: (key) => [[key], [key]],
  grantFeedAccess: (key) => [[key], [key, { source: 'user' }]],
  getEthereumWalletIdentityReferences: (walletIndex) => [[walletIndex], [walletIndex]],
});

function identity(id, mode, { publisherKeyIndex = null, walletIndex = null, label, createdAt }) {
  return { id, mode, publisherKeyIndex, walletIndex, label, createdAt, lastUsedAt: null };
}

function site(activeIdentityId, identities, { feedGranted = false, grantedAt, feeds = {} }) {
  return {
    activeIdentityId,
    identities: Object.fromEntries(identities.map((one) => [one.id, one])),
    feedGranted,
    grantedAt,
    feeds,
  };
}

function seedText(nextPublisherKeyIndex, origins) {
  return JSON.stringify({ version: 2, nextPublisherKeyIndex, origins }, null, 2);
}

const appScoped = (index, createdAt) =>
  identity(`app-scoped:${index}`, 'app-scoped', {
    publisherKeyIndex: index,
    label: `App-scoped identity ${index + 1}`,
    createdAt,
  });
// An identity in the removed mode (#89), as an older build stored it.
const walletIdentity = (walletIndex, createdAt) =>
  identity(`ethereum-wallet:${walletIndex}`, 'ethereum-wallet', {
    walletIndex,
    label: `Ethereum wallet ${walletIndex + 1}`,
    createdAt,
  });
const feed = (identityId) => ({
  topic: 'ab'.repeat(32),
  owner: '0x' + '12'.repeat(20),
  manifestReference: 'cd'.repeat(32),
  identityId,
  createdAt: 1767225500000,
  lastUpdated: null,
  lastReference: null,
});

const FEED_STORE_CASES = Object.freeze([
  {
    // feed-store.test.js, "identity management IPC creates, ensures, and
    // activates identities", "get-origin-identities includes Bee wallet as an
    // available identity", "has-feed-identity", "setOriginEntry normalizes
    // origin".
    name: 'the chrome manages identities',
    steps: [
      ['chrome', IPC.SWARM_GET_ALL_ORIGINS],
      ['chrome', IPC.SWARM_HAS_FEED_IDENTITY, 'ipc-manage.eth'],
      ['chrome', IPC.SWARM_GET_IDENTITY_MODE, 'ipc-manage.eth'],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'ipc-manage.eth'],
      [
        'chrome',
        IPC.SWARM_CREATE_APP_SCOPED_IDENTITY,
        'ipc-manage.eth',
        { label: 'Second identity' },
      ],
      ['chrome', IPC.SWARM_GET_IDENTITY_MODE, 'ipc-manage.eth'],
      ['chrome', IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY, 'ipc-manage.eth'],
      ['chrome', IPC.SWARM_ACTIVATE_FEED_IDENTITY, 'ipc-manage.eth', 'bee-wallet'],
      ['chrome', IPC.SWARM_ACTIVATE_FEED_IDENTITY, 'ipc-manage.eth', 'missing'],
      ['chrome', IPC.SWARM_ACTIVATE_FEED_IDENTITY, 'nobody.eth', 'bee-wallet'],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'ipc-manage.eth'],
      [
        'chrome',
        IPC.SWARM_CREATE_APP_SCOPED_IDENTITY,
        'https://App.example/page',
        {
          activate: false,
          label: '  Padded  ',
        },
      ],
      ['chrome', IPC.SWARM_HAS_FEED_IDENTITY, 'https://app.example'],
      ['chrome', IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY, 'https://app.example', { activate: false }],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'https://app.example'],
      ['chrome', IPC.SWARM_GET_ALL_ORIGINS],
      ['chrome', IPC.SWARM_HAS_FEED_IDENTITY, 'ipc-manage.eth'],
    ],
  },
  {
    // "a stored ethereum-wallet identity loads, unavailable", "feed access is
    // never granted to a stored ethereum-wallet identity", "a stored
    // ethereum-wallet identity is never activated",
    // "getEthereumWalletIdentityReferences lists active and feed-pinned
    // identities" and "... returns empty list for unreferenced wallet".
    name: 'a stored ethereum-wallet identity (#89)',
    seed: seedText(2, {
      'myapp.eth': site(
        'app-scoped:0',
        [appScoped(0, 1767225400000), walletIdentity(2, 1767225300000)],
        { feedGranted: true, grantedAt: 1767225300000, feeds: { blog: feed('app-scoped:0') } }
      ),
      'other.eth': site('ethereum-wallet:2', [walletIdentity(2, 1767225350000)], {
        grantedAt: 1767225350000,
        feeds: { archive: feed('ethereum-wallet:2') },
      }),
      'unused.eth': site(
        'app-scoped:1',
        [appScoped(1, 1767225450000), walletIdentity(2, 1767225460000)],
        { grantedAt: 1767225450000 }
      ),
    }),
    steps: [
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'myapp.eth'],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'other.eth'],
      ['chrome', IPC.SWARM_ACTIVATE_FEED_IDENTITY, 'myapp.eth', 'ethereum-wallet:2'],
      ['chrome', IPC.SWARM_GET_IDENTITY_MODE, 'other.eth'],
      ['main', 'assertFeedGrantable', 'other.eth'],
      ['main', 'grantFeedAccess', 'other.eth'],
      ['main', 'hasFeedGrant', 'other.eth'],
      ['main', 'assertFeedGrantable', 'myapp.eth'],
      ['main', 'getEthereumWalletIdentityReferences', 2],
      ['main', 'getEthereumWalletIdentityReferences', 5],
      ['main', 'getEthereumWalletIdentityReferences', -1],
      ['chrome', IPC.SWARM_GET_ALL_ORIGINS],
      ['chrome', IPC.SWARM_CREATE_APP_SCOPED_IDENTITY, 'other.eth', {}],
      ['main', 'grantFeedAccess', 'other.eth'],
      ['main', 'hasFeedGrant', 'other.eth'],
      ['main', 'getEthereumWalletIdentityReferences', 2],
    ],
  },
  {
    // page-swarm.js's feed prompt (PRQ-7d): "previewAppScopedIdentity does not
    // allocate or persist until approval", "createAppScopedIdentityAt takes
    // exactly the key it names, or throws with nothing written", the grant's
    // lifecycle, "reports which identities other sites share (SW-1)",
    // "set-feed-identity is refused for every site and mode, writing
    // nothing" and "revoke-feed-access clears feed grant".
    name: "the feed prompt's ops",
    steps: [
      ['main', 'getOriginIdentityStateWithOwners', 'at.eth'],
      ['main', 'previewAppScopedIdentity', 'at.eth'],
      ['main', 'hasFeedGrant', 'at.eth'],
      ['chrome', IPC.SWARM_CREATE_APP_SCOPED_IDENTITY, 'other.eth', { activate: true }],
      ['main', 'createAppScopedIdentityAt', 'at.eth', 0],
      ['main', 'getOriginIdentityStateWithOwners', 'at.eth'],
      ['main', 'previewAppScopedIdentity', 'at.eth'],
      ['main', 'createAppScopedIdentityAt', 'at.eth', 1],
      ['main', 'assertFeedGrantable', 'at.eth'],
      ['main', 'hasFeedGrant', 'at.eth'],
      ['main', 'grantFeedAccess', 'at.eth'],
      ['main', 'hasFeedGrant', 'at.eth'],
      ['main', 'ensureAntWalletIdentity', 'at.eth'],
      ['main', 'activateIdentity', 'at.eth', 'app-scoped:1'],
      ['main', 'activateIdentity', 'at.eth', 'app-scoped:7'],
      ['main', 'grantFeedAccess', 'unknown.eth'],
      ['main', 'getOriginIdentityStateWithOwners', 'at.eth'],
      ['chrome', IPC.SWARM_SET_FEED_IDENTITY, 'at.eth', 'app-scoped'],
      ['chrome', IPC.SWARM_REVOKE_FEED_ACCESS, 'at.eth'],
      ['main', 'hasFeedGrant', 'at.eth'],
      ['chrome', IPC.SWARM_REVOKE_FEED_ACCESS, 'unknown.eth'],
      ['chrome', IPC.SWARM_SET_FEED_IDENTITY, 'unknown.eth', 'bee-wallet'],
      ['chrome', IPC.SWARM_HAS_FEED_IDENTITY, 'unknown.eth'],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'at.eth'],
      ['chrome', IPC.SWARM_GET_ALL_ORIGINS],
    ],
  },
  {
    // "get-origin-identities requires unlocked vault for owner inspection":
    // a change the chrome asks for while the vault is locked is written, and
    // only the state it answers with fails.
    name: 'a locked vault',
    vault: 'locked',
    seed: seedText(1, {
      'locked.eth': site('app-scoped:0', [appScoped(0, 1767225400000)], {
        feedGranted: true,
        grantedAt: 1767225400000,
      }),
    }),
    steps: [
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'locked.eth'],
      ['main', 'getOriginIdentityStateWithOwners', 'new.eth'],
      ['main', 'previewAppScopedIdentity', 'locked.eth'],
      ['main', 'hasFeedGrant', 'locked.eth'],
      ['chrome', IPC.SWARM_HAS_FEED_IDENTITY, 'locked.eth'],
      ['chrome', IPC.SWARM_CREATE_APP_SCOPED_IDENTITY, 'locked.eth', { label: 'While locked' }],
      ['chrome', IPC.SWARM_GET_IDENTITY_MODE, 'locked.eth'],
      ['vault', 'unlock'],
      ['chrome', IPC.SWARM_GET_ORIGIN_IDENTITIES, 'locked.eth'],
      ['main', 'previewAppScopedIdentity', 'locked.eth'],
    ],
  },
  {
    // D8: the references in the core's order. The sites differ only where
    // ICU root collation (and the reference's locale order, for these) and
    // a code-unit sort disagree: punctuation sorts before letters, `_`
    // before `-`. Active identities come first.
    name: 'the references in collation order (D8)',
    seed: seedText(0, {
      'ab.eth': site('ethereum-wallet:3', [walletIdentity(3, 1767225300000)], {
        grantedAt: 1767225300000,
      }),
      'a-b.eth': site('ethereum-wallet:3', [walletIdentity(3, 1767225310000)], {
        grantedAt: 1767225310000,
      }),
      'a_b.eth': site('ethereum-wallet:3', [walletIdentity(3, 1767225320000)], {
        grantedAt: 1767225320000,
      }),
      'a.b.eth': site('ethereum-wallet:3', [walletIdentity(3, 1767225330000)], {
        grantedAt: 1767225330000,
      }),
      'aa.eth': site(
        'bee-wallet',
        [
          identity('bee-wallet', 'bee-wallet', {
            label: 'Bee wallet identity',
            createdAt: 1767225340000,
          }),
          walletIdentity(3, 1767225341000),
        ],
        {
          grantedAt: 1767225340000,
          feeds: {
            notes: feed('ethereum-wallet:3'),
            z: feed('ethereum-wallet:3'),
            a: feed('ethereum-wallet:3'),
          },
        }
      ),
    }),
    steps: [
      ['main', 'getEthereumWalletIdentityReferences', 3],
      ['chrome', IPC.SWARM_GET_ALL_ORIGINS],
    ],
  },
]);

// The stamps each side takes from its own clock: normalized, but a stamp's
// presence (a number or null) still counts, and 0 (the unstored Ant wallet
// identity's) stays 0.
const STAMPS = new Set(['createdAt', 'grantedAt', 'lastUsedAt', 'lastUpdated']);

/** `value` with each stamp a number or null, a non-zero number `'stamp'`. */
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      STAMPS.has(key) && typeof inner === 'number' && inner !== 0 ? 'stamp' : normalized(inner);
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
  if (kind === 'chrome') return answerOf(() => side.chrome(name, args));
  if (kind === 'main') return answerOf(() => side.main(name, args));
  if (kind === 'vault') {
    return answerOf(async () => {
      await side.vault(name);
    });
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

async function playFeedStoreCase(kase, { main, reference, between = null, gapMs = 3 }) {
  const mainAnswers = await playSteps(main, kase.steps, gapMs);
  if (between) await between();
  const referenceAnswers = await playSteps(reference, kase.steps, gapMs);
  return kase.steps.map((step, i) => ({
    step,
    main: mainAnswers[i],
    reference: referenceAnswers[i],
  }));
}

/**
 * The sides' calls for main's op `op` (`MAIN_OPS`): `[shellArgs, jsArgs]`.
 */
function mainOpArgs(op, args) {
  if (!Object.hasOwn(MAIN_OPS, op)) throw new TypeError(`unknown main op ${op}`);
  return MAIN_OPS[op](...args);
}

module.exports = {
  FEED_STORE_CASES,
  MAIN_OPS,
  mainOpArgs,
  normalized,
  answerOf,
  playFeedStoreCase,
};
