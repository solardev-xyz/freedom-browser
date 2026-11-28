/**
 * permission-manifests.js's store cases (freedom-core design 0015, D3 and
 * D6; the SWM-6 to SWM-9 plan's PR 6.3), for the suites that play them on
 * the core's manifest store: permission-manifests-core.test.js on the
 * simulated core (test/helpers/simulated-swarm-stores-core.js),
 * permission-manifests.integration.test.js on the real one. Each case is
 * one of permission-manifests.test.js's or
 * permission-manifests.recovery.test.js's store cases, written as the page
 * path and the chrome reach the store: a page's check, decide and release
 * (`checkPageManifest`, `decidePageManifest`, `releasePageManifest`) and
 * the chrome's get, use-individual and disconnect (their IPC handlers). A
 * suite plays each case twice: on main's module with the store the core's,
 * and on the reference module (test/helpers/reference-permission-manifests.js)
 * on a root of its own, the Swarm grants on a simulated grant core
 * (test/helpers/simulated-grant-core.js), and then holds that each answer,
 * each manifest fetched and each file is the same, timestamps and tokens
 * aside (`normalized`).
 *
 * A case: `{ name, seed?, steps }`. `seed` gives `grants` (the Swarm
 * grants' entries, as swarm-permissions.json holds them) and `files` (name
 * to text, written to the store's root before anything runs). A step is
 * one of:
 * - `{ check: key, url?, serve?, eager? }`: a page's check for `key` at its
 *   committed `url` (`bzz://<key>/` by default), eager unless `eager:
 *   false`, the manifest's fetch answered as `serve` says (`responseFor`);
 * - `{ decide: key, consent: i, outcome, live? }`: the consent step `i`'s
 *   check gave, decided `outcome` with the guard answering `live` (true by
 *   default);
 * - `{ release: i }`: step `i`'s consent released;
 * - `{ get: origin }`, `{ useIndividual: origin, capability }`,
 *   `{ disconnect: origin }`: the chrome's handlers.
 */

const IPC = require('../../src/shared/ipc-channels');

const KIB = 1024;

/** A manifest asking for `capabilities` (each `{ why }`). */
function manifest(capabilities, { name = 'Test app', description = 'Exercises manifests' } = {}) {
  return {
    schema: 'freedom-manifest/1',
    name,
    description,
    capabilities: { swarm: capabilities },
  };
}

/**
 * A fresh answer to a manifest's fetch, as `serve` says: a manifest (an
 * object with `schema`) as JSON, 200; `{ status }`, an empty body;
 * `{ text }`, that body, 200; `{ pad, to }`, `pad`'s JSON padded with spaces
 * to `to` bytes, 200; `'severed'`, a 200 whose body breaks after its first
 * bytes; `'throws'`, a fetch that fails. Null for a fetch that throws.
 */
function responseFor(serve) {
  if (serve === 'throws' || serve === undefined) return null;
  const json = { status: 200, headers: { 'content-type': 'application/json' } };
  if (serve === 'severed') {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"schema":"freedom-mani'));
          controller.error(new Error('socket hang up'));
        },
      }),
      json
    );
  }
  if (Object.hasOwn(serve, 'schema')) return new Response(JSON.stringify(serve), json);
  if (Object.hasOwn(serve, 'pad')) {
    const text = JSON.stringify(serve.pad);
    return new Response(text + ' '.repeat(serve.to - Buffer.byteLength(text)), json);
  }
  if (Object.hasOwn(serve, 'text')) return new Response(serve.text, json);
  return new Response('', { status: serve.status });
}

const SITE = 'app.eth';
const OTHER = 'other.eth';
const PUBLISH = manifest({ publish: { why: 'Publish releases' } });
const FEEDS = manifest({ feeds: { why: 'Update feed' } });

/** The Swarm grants a site the user connected holds, as the file has it. */
function connected(origin, autoApprove = {}) {
  return {
    [origin]: {
      origin,
      connectedAt: 1700000000000,
      lastUsed: 1700000000000,
      autoApprove: {
        publish: false,
        feeds: false,
        signing: false,
        messaging: false,
        ...autoApprove,
      },
    },
  };
}

/** A feed store whose site uses a stored ethereum-wallet identity (#89). */
function ethereumWalletFeeds(origin) {
  return JSON.stringify({
    version: 2,
    nextPublisherKeyIndex: 0,
    origins: {
      [origin]: {
        activeIdentityId: 'ethereum-wallet:0',
        feedGranted: false,
        grantedAt: 1700000000000,
        identities: {
          'ethereum-wallet:0': {
            id: 'ethereum-wallet:0',
            mode: 'ethereum-wallet',
            publisherKeyIndex: null,
            walletIndex: 0,
            label: 'Wallet 1',
            createdAt: 1700000000000,
            lastUsedAt: 1700000000000,
          },
        },
        feeds: {},
      },
    },
  });
}

/** A manifest store left with a journal: a crash between its journal and its commit. */
function journaled(origin, operations, record) {
  return JSON.stringify(
    {
      version: 1,
      records: {},
      pending: { origin, record, operations },
    },
    null,
    2
  );
}

const MANAGED_PUBLISH_RECORD = {
  managed: { connection: ['publish'], 'autoApprove.publish': ['publish'] },
  acknowledged: {
    publish: {
      decision: 'managed',
      source: 'sheet',
      whyShown: 'Publish releases',
      decidedAt: 1700000000000,
    },
  },
  revision: 1,
};

const PERMISSION_MANIFEST_CASES = [
  {
    name: 'an allow projects feeds and signing, the identity made before the feed grant',
    steps: [
      {
        check: SITE,
        serve: manifest({
          feeds: { why: 'Update the app feed' },
          signing: { why: 'Sign app updates' },
        }),
      },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { get: SITE },
    ],
  },
  {
    name: 'an individual decision connects the site and keeps no batch flags',
    steps: [
      { check: SITE, serve: manifest({ messaging: { why: 'Receive updates' } }) },
      { decide: SITE, consent: 0, outcome: 'individual' },
      { get: SITE },
    ],
  },
  {
    name: "a first contact's denial keeps nothing it observed",
    steps: [
      { check: SITE, serve: PUBLISH },
      { decide: SITE, consent: 0, outcome: 'deny' },
      { get: SITE },
    ],
  },
  {
    name: "a user's own complete grants are acknowledged without a sheet",
    seed: { grants: { swarm: connected(SITE, { publish: true }) } },
    steps: [{ check: SITE, serve: PUBLISH }, { get: SITE }],
  },
  {
    name: 'a page consent decides once, and a wording-only redeploy asks nothing',
    steps: [
      { check: SITE, serve: manifest({ publish: { why: 'First wording' } }) },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { check: SITE, serve: manifest({ publish: { why: 'New wording' } }) },
      { get: SITE },
    ],
  },
  {
    name: 'a receipt attests the bytes its sheet showed, and a later consent is stale',
    steps: [
      { check: SITE, serve: manifest({ publish: { why: 'First wording' } }) },
      { check: SITE, serve: manifest({ publish: { why: 'New wording' } }) },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { get: SITE },
      { decide: SITE, consent: 1, outcome: 'allow' },
    ],
  },
  {
    name: 'using a capability one by one drops its batch flag, keeping the connection',
    steps: [
      { check: SITE, serve: PUBLISH },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { useIndividual: SITE, capability: 'publish' },
      { useIndividual: SITE, capability: 'publish' },
      { useIndividual: OTHER, capability: 'publish' },
      { useIndividual: SITE, capability: 'nonsense' },
      { get: SITE },
    ],
  },
  {
    name: 'a newer manifest makes the consent of an older one stale',
    steps: [
      { check: SITE, serve: PUBLISH },
      {
        check: SITE,
        serve: manifest({ publish: { why: 'Publish releases' }, feeds: { why: 'Update feed' } }),
      },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { decide: SITE, consent: 1, outcome: 'allow' },
      { get: SITE },
    ],
  },
  {
    name: 'a truncated store is read from its backup',
    seed: {
      grants: { swarm: connected(SITE, { publish: true }) },
      files: {
        'swarm-manifest-grants.json': '{truncated',
        'swarm-manifest-grants.json.bak': JSON.stringify(
          { version: 1, records: { [SITE]: MANAGED_PUBLISH_RECORD } },
          null,
          2
        ),
      },
    },
    steps: [{ get: SITE }, { check: SITE, serve: PUBLISH }, { get: SITE }],
  },
  {
    name: 'a manifest gone for good prunes its authority but keeps the identity',
    steps: [
      { check: SITE, serve: FEEDS },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { check: SITE, serve: { status: 404 }, eager: false },
      { get: SITE },
    ],
  },
  {
    name: 'removals apply before a mixed change is denied, and its addition never does',
    steps: [
      {
        check: SITE,
        serve: manifest({ publish: { why: 'Publish releases' }, feeds: { why: 'Update feed' } }),
      },
      { decide: SITE, consent: 0, outcome: 'allow' },
      {
        check: SITE,
        serve: manifest({ feeds: { why: 'Update feed' }, messaging: { why: 'Receive updates' } }),
        eager: false,
      },
      { decide: SITE, consent: 2, outcome: 'deny' },
      { get: SITE },
    ],
  },
  {
    name: 'a 503 is transient: the managed grants stay',
    steps: [
      {
        check: SITE,
        serve: manifest({ publish: { why: 'Publish releases' }, feeds: { why: 'Update feed' } }),
      },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { check: SITE, serve: { status: 503 }, eager: false },
      { get: SITE },
    ],
  },
  {
    name: 'a body that breaks is transient, and backs off the next check',
    steps: [
      { check: SITE, serve: 'severed' },
      { check: SITE, serve: PUBLISH },
      { check: OTHER, serve: 'throws' },
      { get: SITE },
    ],
  },
  {
    name: 'absent, not JSON, 8 KiB exactly and 8 KiB and a byte',
    steps: [
      { check: 'absent.eth', serve: { status: 404 } },
      { check: 'notjson.eth', serve: { text: 'not json' } },
      { check: 'exact.eth', serve: { pad: PUBLISH, to: 8 * KIB } },
      { check: 'over.eth', serve: { pad: PUBLISH, to: 8 * KIB + 1 } },
      { check: 'large.eth', serve: { text: 'x'.repeat(40 * KIB) } },
      { check: 'teapot.eth', serve: { status: 418 } },
      { get: 'exact.eth' },
      { get: 'over.eth' },
    ],
  },
  {
    name: "a URL that isn't bzz:, or isn't the key's, fetches nothing it shouldn't",
    steps: [
      { check: 'https://app.example', url: 'https://app.example/' },
      { check: SITE, url: `bzz://${OTHER}/`, serve: PUBLISH },
      { check: SITE, eager: false },
      { get: SITE },
    ],
  },
  {
    name: 'the guard decides: a refusal writes nothing and spends the consent',
    steps: [
      { check: SITE, serve: PUBLISH },
      { decide: SITE, consent: 0, outcome: 'allow', live: false },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { check: SITE, serve: PUBLISH },
      { decide: OTHER, consent: 3, outcome: 'allow' },
      { decide: SITE, consent: 3, outcome: 'allow' },
      { get: SITE },
    ],
  },
  {
    name: 'a released consent is gone, and the chrome disconnects a managed site',
    steps: [
      {
        check: SITE,
        serve: manifest({
          publish: { why: 'Publish' },
          feeds: { why: 'Feeds' },
          messaging: { why: 'Chat' },
        }),
      },
      { release: 0 },
      { decide: SITE, consent: 0, outcome: 'allow' },
      {
        check: SITE,
        serve: manifest({
          publish: { why: 'Publish' },
          feeds: { why: 'Feeds' },
          messaging: { why: 'Chat' },
        }),
      },
      { decide: SITE, consent: 3, outcome: 'allow' },
      { release: 3 },
      { disconnect: SITE },
      { get: SITE },
      { disconnect: OTHER },
    ],
  },
  {
    name: 'site keys main is given unnormalized reach the normalized record',
    steps: [
      { check: 'App.eth', url: 'bzz://app.eth/', serve: PUBLISH },
      { decide: 'APP.ETH', consent: 0, outcome: 'allow' },
      { get: 'bzz://App.eth/index.html' },
      { useIndividual: 'App.Eth', capability: 'publish' },
      { get: SITE },
      { disconnect: 'bzz://APP.eth/page' },
      { get: SITE },
    ],
  },
  {
    name: 'a stored ethereum-wallet identity refuses feeds before anything is journaled',
    seed: { files: { 'swarm-feeds.json': ethereumWalletFeeds(SITE) } },
    steps: [
      { check: SITE, serve: manifest({ feeds: { why: 'Update feed' }, signing: { why: 'Sign' } }) },
      { decide: SITE, consent: 0, outcome: 'allow' },
      { get: SITE },
      { check: SITE, serve: manifest({ feeds: { why: 'Update feed' }, signing: { why: 'Sign' } }) },
      { decide: SITE, consent: 3, outcome: 'individual' },
      { get: SITE },
    ],
  },
  {
    name: "a journal is replayed by the next change, an ethereum-wallet site's without its identity grants",
    seed: {
      files: {
        'swarm-feeds.json': ethereumWalletFeeds(SITE),
        'swarm-manifest-grants.json': journaled(
          SITE,
          [
            { projection: 'connection', enabled: true },
            { projection: 'feedGrant', enabled: true },
            { projection: 'autoApprove.feeds', enabled: true },
          ],
          {
            managed: {
              connection: ['feeds'],
              feedGrant: ['feeds'],
              'autoApprove.feeds': ['feeds'],
            },
            acknowledged: {
              feeds: {
                decision: 'managed',
                source: 'sheet',
                whyShown: 'Feeds',
                decidedAt: 1700000000000,
              },
            },
            revision: 1,
          }
        ),
      },
    },
    steps: [{ get: SITE }, { get: OTHER }],
  },
  {
    name: 'a journal of a plain site replays its grants',
    seed: {
      files: {
        'swarm-manifest-grants.json': journaled(
          SITE,
          [
            { projection: 'connection', enabled: true },
            { projection: 'autoApprove.publish', enabled: true },
          ],
          MANAGED_PUBLISH_RECORD
        ),
      },
    },
    steps: [{ disconnect: OTHER }, { get: SITE }],
  },
];

/** The keys whose numbers are times, and the token, in an answer or a file. */
const TIMES = new Set([
  'checkedAt',
  'decidedAt',
  'connectedAt',
  'lastUsed',
  'createdAt',
  'lastUsedAt',
  'grantedAt',
  'retryAt',
]);

/** `value` with its times and tokens replaced: what both runs share. */
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (TIMES.has(key) && typeof item === 'number') out[key] = '<time>';
    else if (key === 'token' && typeof item === 'string') out[key] = '<token>';
    else out[key] = normalized(item);
  }
  return out;
}

/** An answer, or what was thrown: its class's name and message. */
async function outcomeOf(run) {
  try {
    return { answer: await run() };
  } catch (err) {
    return { thrown: { name: err?.name, message: err?.message, code: err?.code } };
  }
}

/** The committed URL of a step's check. */
function urlOf(step) {
  return step.url ?? `bzz://${step.check}/`;
}

/**
 * Plays `kase` on `world`: `{ serve(spec), guest(), check(request),
 * decide(key, token, outcome, guard), release(token), handlers }`, where
 * `check`, `decide` and `release` are the page path's and `handlers` the
 * chrome's IPC handlers by channel. Resolves each step's outcome, in order
 * (`{ answer }` or `{ thrown }`).
 */
async function playPermissionManifestCase(kase, world) {
  const outcomes = [];
  const tokens = [];
  for (const step of kase.steps) {
    let run;
    if (Object.hasOwn(step, 'check')) {
      world.serve(step.serve);
      run = () =>
        world.check({
          key: step.check,
          url: urlOf(step),
          guest: world.guest(),
          eager: step.eager !== false,
        });
    } else if (Object.hasOwn(step, 'decide')) {
      const live = step.live !== false;
      run = () =>
        world.decide(step.decide, tokens[step.consent], step.outcome, {
          recheck: async () => live,
          holds: () => true,
        });
    } else if (Object.hasOwn(step, 'release')) {
      run = () => world.release(tokens[step.release]);
    } else if (Object.hasOwn(step, 'get')) {
      run = () => world.handlers[IPC.SWARM_MANIFEST_GET]({}, step.get);
    } else if (Object.hasOwn(step, 'useIndividual')) {
      run = () =>
        world.handlers[IPC.SWARM_MANIFEST_USE_INDIVIDUAL](
          {},
          { origin: step.useIndividual, capability: step.capability }
        );
    } else if (Object.hasOwn(step, 'disconnect')) {
      run = () => world.handlers[IPC.SWARM_MANIFEST_DISCONNECT]({}, step.disconnect);
    } else {
      throw new Error(`a step of ${kase.name} names nothing to do`);
    }
    const outcome = await outcomeOf(run);
    tokens.push(outcome.answer?.token);
    outcomes.push(outcome);
  }
  return outcomes;
}

module.exports = {
  PERMISSION_MANIFEST_CASES,
  manifest,
  normalized,
  playPermissionManifestCase,
  responseFor,
};
