/**
 * window.swarm's contract cases beyond the vectors
 * (src/main/page/page-swarm.contract.test.js; freedom-core design 0015,
 * SWM-7's Done-when, the SWM-6 to SWM-9 plan's point 9 and PR 7.6b): the
 * behaviour the five provider suites check that `vectors/swarm.json`'s
 * `methods` cases don't record, in the same form, through main's
 * dispatcher, which both backends must pass with the same answers.
 *
 * Each case starts from a vectors case's world (`from`: its grants, feed
 * store, node and clock) and replaces its steps. A step is a page's
 * request as the vectors write one (`plain` params in place of the typed
 * form), `{ concurrent: [...] }` for requests a page makes at once, or
 * `{ socket: { message } }` for a frame the node sends on every open
 * subscription socket. `check(record, { backend, fixAt })` lists each way
 * a run on `backend` differs from what the suite's behaviour wants (empty
 * when it holds); `fixAt(got, want)` takes a time the core's clock wrote
 * within the run as the case's.
 *
 * Each check also holds every step's requests to what the reference makes,
 * in the wire form compareCase compares (`referenceWants`: `coreWants` on
 * `core`) and with no clock adjusted (none of these requests carries a
 * time): a step that is a vectors step unchanged, to that step's requests
 * as compareCase does (`stepAsVectors`); a step of calls made at once, to
 * each call's requests from the vectors case that records that call, its
 * paths re-derived for the call's own feed, index or blob and its SOC
 * upload rebuilt for its own data (`socUpload`), in any order between the
 * calls but each call's in its own (`stepAtOnce`). The test applies
 * compareCase's per-request checks (`requestProblems`) to every step and
 * compares the WebSockets opened with the base case's.
 *
 * - **feed-service** (`withWriteLock`): two writes to one feed at once get
 *   consecutive indexes, never the same one; writes to two feeds go
 *   together (the second runs to its upload while the node holds the
 *   first's), each at its own first index.
 * - **messaging-service** (`openSubscriptionSocket`): every frame the node
 *   sends reaches the document, in order, byte-identical repeats included;
 *   a node that refuses the subscription (close 1013 before the grace) is
 *   the retryable 4900 `node_subscription_limit`.
 * - **messaging-service** (`deriveGsoc`'s per-origin new-topic budget): a
 *   topic already mined costs nothing once the budget is spent, and another
 *   site's budget is its own.
 * - **swarm-provider-ipc**: a feed read on a node that isn't reachable is
 *   4900 `node-stopped`, before any feed request; and two blob reads at
 *   once can't both start past the read budget: the size is reserved
 *   before the join, so the other is refused `rate_limited` before its
 *   body is read.
 */

const crypto = require('crypto');
const { content } = require('./swarm-vectors');
const { feedIdentifier, libraries, splitTree } = require('./swarm-contract-node');
const { interleaves, referenceWants, sameAnswer, sameRequestsOn, wire } = require('./swarm-contract-compare');

const OTHER = 'https://other.example';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const show = (value) => JSON.stringify(value);
const write = (data) => ({ method: 'swarm_writeFeedEntry', plain: { name: 'blog', data } });

/** The answers of a `concurrent` step, as `{ result }` or `{ error }`. */
const answers = (step) => step?.answers || [];

const isSoc = (r) => r.method === 'POST' && r.path.startsWith('/soc/');

/**
 * A SOC upload as the reference makes it, from one the vectors record
 * (`template`: its headers, status and marks): `data` in its content
 * chunk, the span (8 bytes, little-endian, the data's length) and then
 * the data, with no time in it (a feed entry's and a GSOC message's
 * payload is the data itself), signed by `key` (hex) under `identifier`
 * with core-sdk's signer, the reference's own. Its signatures are
 * deterministic: the vectors' SOC uploads are core-sdk's, and the core's
 * match them exactly (compareCase compares their `sig`).
 */
function socUpload(template, { identifier, key, data }) {
  const { core } = libraries();
  const soc = core.makeContentAddressedChunk(Buffer.from(data)).toSingleOwnerChunk(identifier, key.replace(/^0x/, ''));
  // SOC data: identifier (32 bytes) ‖ signature (65) ‖ span ‖ payload.
  const body = Buffer.from(soc.data).subarray(32 + 65);
  return {
    ...template,
    path: `/soc/${soc.owner.toHex()}/${soc.identifier.toHex()}`,
    query: [['sig', soc.signature.toHex()]],
    body: { bytes: body.length, base64: body.toString('base64') },
  };
}

/**
 * Step `k`'s requests against `wanted` (the reference's, as the vectors
 * record them) on `backend`, as compareCase compares a vectors step: no
 * problem, or the difference as text.
 */
function stepAsVectors(backend, record, k, wanted) {
  const ran = record.steps[k];
  const got = ran.requests.map((r) => wire(r, backend));
  const wants = referenceWants(backend, wanted);
  return sameRequestsOn(backend, got, wants, { window: record.window, walks: ran.walks })
    ? []
    : [`step ${k} requests: ${show(got)} against ${show(wants)}`];
}

/**
 * Step `k`'s requests against `sequences` (the reference's for each call
 * the step makes at once, as the vectors record them) on `backend`: every
 * request one of theirs, exactly, each call's in its own order
 * (`interleaves`).
 */
function stepAtOnce(backend, record, k, sequences) {
  const ran = record.steps[k];
  const got = ran.requests.map((r) => wire(r, backend));
  const wants = sequences.map((sequence) => referenceWants(backend, sequence));
  return interleaves(got, wants, { walks: ran.walks })
    ? []
    : [`step ${k} requests: ${show(got)} against these made at once: ${show(wants)}`];
}

/** The cases, given the vectors (`swarm`) to start from and their test keys (`keys`, swarm-contract-node.js `testKeys`). */
async function contractCases(swarm, keys) {
  const base = (id) => {
    const kase = swarm.methods.find((one) => one.id === id);
    if (!kase) throw new Error(`no vectors case ${id}`);
    return structuredClone(kase);
  };
  const cases = [];

  // A feed write's requests as the reference makes them (the cases below
  // write to the Bee wallet's feeds of write-feed-rule's world): those of
  // the vectors case that records a write at the same index, index 0 on a
  // feed with no update (write-feed-rule) and index 1 on one whose update 0
  // exists (write-feed-head-0), each a stamps read, the index lookup, the
  // probes and the SOC upload. For the feed named `name` the lookup's and
  // each probe's path are re-derived (a probe's from the index the vectors
  // mark it with), and the upload is the write's own: at
  // /soc/<owner>/<keccak256(topic ‖ index as 8 bytes big-endian)>, its data
  // signed by the owner's key. The entries here are short, so none is
  // wrapped (`feed-wrap-root`). null for an index no vectors case records.
  const libs = libraries();
  const owner = keys.bee.address.slice(2).toLowerCase();
  const written = [base('write-feed-rule'), base('write-feed-head-0')];
  const byIndex = written.map((one) => one.steps[0].requests);
  const writeRequests = (name, data, index) => {
    const recorded = byIndex[index];
    if (!recorded) return null;
    const topic = libs.beeJs.Topic.fromString(`${written[index].origin}/${name}`);
    const probe = (n) => libs.core.makeSOCAddress(feedIdentifier(libs, topic, n), new libs.core.EthAddress(owner)).toHex();
    return recorded.map((r) => {
      if (r.method === 'GET' && r.path.startsWith('/feeds/')) return { ...r, path: `/feeds/${owner}/${topic.toHex()}` };
      if (r.feed) return { ...r, path: `/chunks/${probe(r.feed.index)}` };
      if (isSoc(r)) return socUpload(r, { identifier: feedIdentifier(libs, topic, index), key: keys.bee.privateKey, data });
      return r;
    });
  };
  // Rebuilt for its own feed and data, each recorded write is what the
  // vectors record: the derivations above are the reference's.
  for (const [index, recorded] of byIndex.entries()) {
    const data = Buffer.from(recorded.find(isSoc).body.base64, 'base64').subarray(8);
    if (show(writeRequests('blog', data, index)) !== show(recorded)) {
      throw new Error(`a feed write at index ${index}, rebuilt, isn't the vectors': ${show(writeRequests('blog', data, index))}`);
    }
  }

  // feed-service: withWriteLock serializes writes to the same topic.
  {
    const kase = base('write-feed-rule');
    cases.push({
      ...kase,
      id: 'contract/feed-writes-one-feed-at-once',
      suite: 'feed-service',
      steps: [{ concurrent: [write('first'), write('second')] }],
      check: (record, { backend }) => {
        const problems = [];
        const got = answers(record.steps[0]);
        const indexes = got.map((one) => one.result?.index).sort();
        if (show(indexes) !== show([0, 1])) problems.push(`indexes ${show(got)}, against 0 and 1`);
        const socs = record.steps[0].requests.filter(isSoc);
        if (socs.length !== 2 || socs[0].path === socs[1].path) problems.push(`SOC uploads ${show(socs.map((r) => r.path))}`);
        const rows = record.after.history.filter((row) => row.type === 'feed-entry' && row.status === 'completed');
        if (rows.length !== 2) problems.push(`history ${show(record.after.history)}`);
        // Each write's requests at the index it answered, exactly.
        const sequences = ['first', 'second'].map((data, i) => writeRequests('blog', data, got[i]?.result?.index));
        if (!sequences.includes(null)) problems.push(...stepAtOnce(backend, record, 0, sequences));
        return problems;
      },
    });
  }

  // feed-service: writes to two topics go in parallel, each at its own index.
  // The node holds the first SOC upload (inside its write's lock on both
  // backends) until the other feed's reaches it, as the provider test holds
  // one write while the other starts and ends: a lock shared by both topics
  // would keep the second write from its upload until the hold timed out.
  {
    const kase = base('write-feed-rule');
    const beeJs = require('@ethersphere/bee-js');
    const feeds = JSON.parse(kase.feeds);
    const site = feeds.origins[kase.origin];
    site.feeds.news = {
      ...site.feeds.blog,
      topic: beeJs.Topic.fromString(`${kase.origin}/news`).toHex(),
      manifestReference: 'ce'.repeat(32),
    };
    kase.node.rules = [
      {
        match: { method: 'POST', prefix: '/soc/' },
        times: 1,
        reply: async (request, node) => {
          await node.holdUntil(request, isSoc);
          return node.own(request);
        },
      },
      ...(kase.node.rules || []),
    ];
    cases.push({
      ...kase,
      id: 'contract/feed-writes-two-feeds-at-once',
      suite: 'feed-service',
      feeds: JSON.stringify(feeds, null, 2),
      steps: [
        {
          concurrent: [write('blog entry'), { method: 'swarm_writeFeedEntry', plain: { name: 'news', data: 'news entry' } }],
        },
      ],
      check: (record, { backend }) => {
        const problems = [];
        const got = answers(record.steps[0]);
        if (show(got) !== show([{ result: { index: 0 } }, { result: { index: 0 } }])) {
          problems.push(`answers ${show(got)}, against index 0 for each feed`);
        }
        // Each write's requests at index 0 of its own feed, exactly.
        problems.push(...stepAtOnce(backend, record, 0, [writeRequests('blog', 'blog entry', 0), writeRequests('news', 'news entry', 0)]));
        const socs = record.steps[0].requests.filter(isSoc);
        const held = socs.filter((r) => r.held !== undefined);
        const other = socs.find((r) => !held.includes(r));
        if (socs.length !== 2 || held.length !== 1 || !other || held[0].held !== other.path) {
          problems.push(
            `the first SOC upload held until the other feed's reached the node: ${show(socs.map((r) => ({ path: r.path, held: r.held })))}`
          );
        }
        return problems;
      },
    });
  }

  // messaging-service: every frame reaches the document, repeats included.
  {
    const kase = base('subscribe-pss-topic');
    const frames = ['aGVsbG8=', 'aGVsbG8=', 'd29ybGQ='];
    cases.push({
      ...kase,
      id: 'contract/subscribe-frames-delivered',
      suite: 'messaging-service',
      steps: [kase.steps[0], ...frames.map((message) => ({ socket: { message } }))],
      check: (record, { backend, fixAt }) => {
        // The subscribe is the vectors' step; a frame asks the node nothing.
        const problems = stepAsVectors(backend, record, 0, kase.steps[0].requests);
        frames.forEach((_data, i) => {
          if (record.steps[i + 1].requests.length) problems.push(`frame ${i}: requests ${show(record.steps[i + 1].requests)}`);
        });
        const subscribed = record.steps[0].result;
        if (!subscribed?.subscriptionId) return [...problems, `subscribe answered ${show(record.steps[0])}`];
        frames.forEach((data, i) => {
          const step = record.steps[i + 1];
          const delivered = step.events.filter((e) => e.delivered).map((e) => e.delivered);
          const want = {
            type: 'swarm_subscription',
            subscription: subscribed.subscriptionId,
            result: { kind: 'pss', key: subscribed.key, data, encoding: 'base64', receivedAt: kase.clock },
          };
          if (step.delivered !== 1 || delivered.length !== 1 || show(fixAt(delivered[0], want)) !== show(want)) {
            problems.push(`frame ${i}: ${show(delivered)} against ${show(want)}`);
          }
        });
        return problems;
      },
    });
  }

  // messaging-service: a node that refuses the subscription (1013).
  {
    const kase = base('subscribe-pss-topic');
    cases.push({
      ...kase,
      id: 'contract/subscribe-node-limit',
      suite: 'messaging-service',
      websocket_close: { code: 1013, reason: 'Try Again Later' },
      steps: [kase.steps[0]],
      check: (record, { backend }) => {
        const want = {
          error: {
            code: 4900,
            message: 'Node subscription capacity exhausted: Try Again Later',
            data: { reason: 'node_subscription_limit' },
          },
        };
        // The vectors' subscribe step: its node probe, then the socket the
        // node refuses.
        const problems = stepAsVectors(backend, record, 0, kase.steps[0].requests);
        const got = { error: record.steps[0].error, result: record.steps[0].result };
        if (show({ error: got.error }) !== show(want) || got.result !== undefined) {
          problems.push(`answered ${show(got)} against ${show(want)}`);
        }
        return problems;
      },
    });
  }

  // messaging-service: deriveGsoc's budget, per origin, cache hits free.
  {
    const kase = base('send-gsoc-topic-budget');
    kase.grants[OTHER] = { ...kase.grants[kase.origin], origin: OTHER };
    const spent = kase.steps.length - 1;
    // The other site's new topic is one the vectors' GSOC derivations hold
    // (`gsoc`: mined as messaging-service.js mines), so its signer's key,
    // SOC address and identifier are the vectors'; none of the budget
    // case's topics is it. Its requests: step 0's stamps read, and its own
    // SOC of the same message, signed by that key.
    const derived = (swarm.gsoc || []).find((one) => one.id === 'gsoc-topic-chat');
    if (!derived) throw new Error('no GSOC derivation gsoc-topic-chat in the vectors');
    const [mined] = kase.steps;
    const otherRequests = mined.requests.map((r) =>
      isSoc(r) ? socUpload(r, { identifier: derived.identifier, key: derived.result.key, data: 'hi' }) : r
    );
    if (!otherRequests.some((r) => r.path === `/soc/${derived.result.owner}/${derived.identifier}`)) {
      throw new Error(`the GSOC derivation's SOC isn't at its owner's: ${show(otherRequests)}`);
    }
    cases.push({
      ...kase,
      id: 'contract/gsoc-budget-cache-hit-and-other-site',
      suite: 'messaging-service',
      steps: [
        ...kase.steps,
        { method: 'swarm_sendGsoc', plain: { topic: 'room 4', data: 'hi' } },
        { method: 'swarm_sendGsoc', origin: OTHER, plain: { topic: derived.topic, data: 'hi' } },
      ],
      check: (record, { backend }) => {
        const problems = [];
        const refused = record.steps[spent].error;
        if (refused?.data?.reason !== 'rate_limited') problems.push(`the 17th new topic answered ${show(record.steps[spent])}`);
        const first = mined.result;
        const again = record.steps[spent + 1];
        if (show(again.result) !== show(first)) problems.push(`the mined topic again: ${show(again)} against ${show(first)}`);
        const other = record.steps[spent + 2];
        if (show(other.result) !== show({ sent: true, address: derived.result.address })) {
          problems.push(`another site's new topic: ${show(other)} against address ${derived.result.address}`);
        }
        // Steps 0 to 16 are the vectors' own; the mined topic again makes
        // step 0's requests again (the same SOC: no time in it).
        kase.steps.forEach((step, k) => problems.push(...stepAsVectors(backend, record, k, step.requests || [])));
        problems.push(...stepAsVectors(backend, record, spent + 1, mined.requests));
        problems.push(...stepAsVectors(backend, record, spent + 2, otherRequests));
        return problems;
      },
    });
  }

  // swarm-provider-ipc: a feed read checks the node is reachable first.
  {
    const kase = base('read-feed-latest');
    kase.node.rules = [{ match: { method: 'GET', path: '/node' }, reply: { status: 500 } }];
    // The vectors step's node probe, answered the rule's 500, and nothing after.
    const probe = kase.steps[0].requests.find((r) => r.method === 'GET' && r.path === '/node');
    const wanted = [{ ...probe, status: kase.node.rules[0].reply.status }];
    cases.push({
      ...kase,
      id: 'contract/read-feed-node-unreachable',
      suite: 'swarm-provider-ipc',
      check: (record, { backend }) => {
        const want = { code: 4900, message: 'Node not available: node-stopped', data: { reason: 'node-stopped' } };
        const step = record.steps[0];
        const problems = stepAsVectors(backend, record, 0, wanted);
        if (show(step.error) !== show(want)) problems.push(`answered ${show(step)} against ${show({ error: want })}`);
        if (step.requests.some((r) => r.path.startsWith('/feeds/'))) problems.push('a feed request to a node that is down');
        return problems;
      },
    });
  }

  // swarm-provider-ipc: two blob reads at once, past the anonymous budget.
  // Each blob is within the per-read bound (512 KiB), so the read that
  // doesn't fit what is left of the window is refused rate_limited, as the
  // vectors record the reserve's refusal, and before its body is read: of
  // the refused blob only its root chunk reaches the node.
  {
    const kase = base('read-data-524288-anonymous');
    const reserveRefused = base('read-data-reserve-refused').steps.at(-1);
    const refusal = reserveRefused.error;
    const length = 300000;
    const blobs = ['contract/a', 'contract/b'].map((seed) => ({ seed, length }));
    const refs = [];
    for (const blob of blobs) refs.push((await splitTree(require('@ethersphere/core-sdk'), content(blob.seed, length))).root.address);
    kase.node = { data: blobs };
    // Each read's requests as the vectors record them, for its own blob:
    // a read, the anonymous read's (its node probe, root chunk and join,
    // the verified walk on `core`); a refusal, the reserve's refusal's
    // (its node probe and root chunk).
    const rootOf = (requests) => requests.find((r) => r.path.startsWith('/chunks/')).path.slice('/chunks/'.length);
    const forBlob = (requests, root) => requests.map((r) => ({ ...r, path: r.path.split(rootOf(requests)).join(root) }));
    const join = kase.steps[0].requests.find((r) => r.path.startsWith('/bytes/'));
    cases.push({
      ...kase,
      id: 'contract/read-data-two-at-once-past-the-budget',
      suite: 'swarm-provider-ipc',
      steps: [
        {
          concurrent: refs.map((reference) => ({ method: 'swarm_readData', plain: { reference } })),
          // Either blob may be the one read: each one's verified walk.
          joins: refs.map((root) => ({ root, status: join.status })),
        },
      ],
      check: (record, { backend }) => {
        const step = record.steps[0];
        const got = answers(step);
        const read = got.filter((one) => one.result);
        const refused = got.filter((one) => one.error);
        const problems = [];
        if (read.length !== 1 || refused.length !== 1) return [`answers ${show(got)}: one read and one refused`];
        const bytes = Buffer.from(read[0].result.data, 'base64');
        const i = got.indexOf(read[0]);
        if (bytes.length !== length || sha256(bytes) !== sha256(content(blobs[i].seed, length))) problems.push('the read blob');
        if (!sameAnswer(refused[0], { error: refusal })) problems.push(`the refusal ${show(refused[0])} against ${show({ error: refusal })}`);
        // Only the read blob's body reaches the node (its join, ranged on
        // `core`), and of the refused blob nothing but its root chunk.
        const bodies = step.requests.filter((r) => r.path.startsWith('/bytes/')).map((r) => r.path);
        if (show(bodies) !== show([`/bytes/${refs[i]}`])) problems.push(`body reads ${show(bodies)}, against /bytes/${refs[i]} alone`);
        const ofRefused = step.requests.filter((r) => r.path.includes(refs[1 - i])).map((r) => `${r.method} ${r.path}`);
        if (show(ofRefused) !== show([`GET /chunks/${refs[1 - i]}`])) {
          problems.push(`the refused blob's requests ${show(ofRefused)}, against its root chunk alone`);
        }
        // Each read's requests, exactly, made at once.
        problems.push(...stepAtOnce(backend, record, 0, [forBlob(kase.steps[0].requests, refs[i]), forBlob(reserveRefused.requests, refs[1 - i])]));
        return problems;
      },
    });
  }

  return cases;
}

/**
 * SW-1 (design 0015, "SW-1 in the core"): the vectors' raw-SOC cases under
 * the Bee wallet, an app-scoped index another site's identity holds, an
 * index only this site holds, an app-scoped identity with no index, and a
 * stored Ethereum wallet identity first. Each reaches the backend (the
 * reference's `service` event); on `core` the step must have gone to the
 * core as one `swarm.request` that the core answered, so the refusal is the
 * core's own check, through the pipe, not main's.
 */
const SW1 = Object.freeze({
  'write-soc-bee-wallet-shared': 'the Bee wallet: always shared, refused shared_identity',
  'write-soc-app-scoped-shared-index': "an app-scoped index another site's identity holds: refused shared_identity",
  'write-soc-app-scoped-other-site-other-index': 'an index only this site holds: signed and uploaded',
  'write-soc-app-scoped-index-missing': 'an app-scoped identity with no index: refused shared_identity',
  'write-soc-ethereum-wallet-first': 'a stored Ethereum wallet identity: refused before SW-1 (#89)',
});

module.exports = { SW1, contractCases };
