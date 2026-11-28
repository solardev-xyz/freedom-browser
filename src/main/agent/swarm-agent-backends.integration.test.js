/**
 * The agent's Swarm modules on both backends (freedom-core design 0015,
 * SWM-8's Done-when "each module's suite"; the SWM-6 to SWM-9 plan's PR
 * 8.4): swarm-publication-controller.js and swarm-postage-readiness.js
 * with their own default calls, in a development build with
 * FREEDOM_SWARM_BACKEND=js and then =core, each against the real
 * freedom-cored (on `js` for the vault's signatures alone) and a node on
 * loopback that stores what it is sent (test/helpers/swarm-agent-node.js).
 *
 * Only the controller's non-Swarm boundaries are the test's: where the
 * content comes from, the pre-publish scan (run in the test's thread), the
 * approval (approved, each card kept) and its polling intervals. Everything
 * Swarm is main's own: on `js` publish-service.js, feed-service.js,
 * swarm-signer.js and swarm-service.js over bee-js, the history main's own
 * publish-history.sqlite; on `core` swarm-agent-core.js's `swarm.publish`,
 * `swarm.upload_status`, `swarm.feed` and `swarm.stamps` through main's
 * executor (core/swarm-shell.js), swarm-node-reads.js's `/batches`,
 * `/chainstate` and `/bytes` on the node's transport, and the core's
 * history (the build's hello names `swarm_stores` there).
 *
 * Each case runs on `js` first and then on `core`, and on `core` its record
 * must equal `js`'s: the readiness answers and errors; the controller's
 * receipt (or error), its progress states and the approval cards; the
 * history rows; each upload the node took (its name, Swarm headers, entries
 * and reference); and the node calls made, each once (the readiness reads
 * its three in parallel, and bee-js's batch choice reads `/stamps` again
 * for a batch that isn't usable). On `core` each case also leaves the same core
 * running, the executor empty and the Swarm I/O pool at 0.
 *
 * Skipped without the binary; FREEDOM_CORED_SWARM_TEST=1 requires it (npm
 * run core:download), as FREEDOM_CORED_PATH names one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startAgentNode } = require('../../../test/helpers/swarm-agent-node');

jest.setTimeout(120_000);

const SRC = path.join(__dirname, '..');
const SRC_PATH = (rel) => path.join(SRC, rel);

/** The pinned freedom-cored, or null (the suite skips). */
function coredBinary() {
  const required = process.env.FREEDOM_CORED_SWARM_TEST === '1';
  const binary =
    process.env.FREEDOM_CORED_PATH ||
    (required ? jest.requireActual(SRC_PATH('core/cored-binary.js')).getCoredBinaryPath() : null);
  if (required && (!binary || !fs.existsSync(binary))) {
    throw new Error('FREEDOM_CORED_SWARM_TEST=1 needs freedom-cored: run npm run core:download');
  }
  return binary && fs.existsSync(binary) ? binary : null;
}

const BINARY = coredBinary();
const describeIfCore = BINARY ? describe : describe.skip;

const PASSWORD = 'swarm-agent-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const SILENT = { info() {}, warn() {}, error() {}, debug() {}, log() {}, verbose() {} };

const BATCH = 'a1'.repeat(32);
const OTHER_BATCH = 'b2'.repeat(32);
/** A node's raw batch (`/stamps`): usable, depth 22 (7.07 GB of room), 10 days. */
const stamp = (batchID, fields = {}) => ({
  batchID,
  utilization: 0,
  usable: true,
  label: 'freedom',
  depth: 22,
  amount: '100000000000',
  bucketDepth: 16,
  blockNumber: 1000,
  immutableFlag: true,
  exists: true,
  batchTTL: 864000,
  ...fields,
});
/** The chain's view of a batch (`/batches/<id>`), started at block 80. */
const chainBatch = (batchID, fields = {}) => ({
  batchID,
  batchTTL: 864000,
  bucketDepth: 16,
  depth: 22,
  immutable: true,
  owner: '9858effd232b4033e47d90003d41ec34ecaeda94',
  start: 80,
  value: '100000000000',
  ...fields,
});

/**
 * The node's state at the start of each case: the batch the agent picks,
 * a quarter used (so its room is below its size), and a shorter one; both
 * ready (block 100 ≥ 80 + 10).
 */
function freshState() {
  return {
    stamps: [stamp(BATCH, { batchTTL: 864000, utilization: 16 }), stamp(OTHER_BATCH, { batchTTL: 86400 })],
    global: { [BATCH]: chainBatch(BATCH), [OTHER_BATCH]: chainBatch(OTHER_BATCH) },
    chain: { block: 100, chainTip: 100, totalAmount: '5000', currentPrice: '24000' },
    tag: 41,
    ignoreEncrypt: false,
    serveBytes: true,
    failUploads: [],
  };
}

const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({
      error: {
        message: error?.message,
        ...(error?.code !== undefined && { code: error.code }),
        ...(error?.permanent !== undefined && { permanent: error.permanent }),
        ...(error?.suggestedAction !== undefined && { suggestedAction: error.suggestedAction }),
      },
    })
  );

/** A history row, its times as whether it has them. */
const rowOf = (row) => ({
  ...row,
  timestamp: Boolean(row.timestamp),
  createdAt: Boolean(row.createdAt),
  completedAt: Boolean(row.completedAt),
});

// ---- The cases ----------------------------------------------------------------

const TEXT = { text: '<h1>hello from the agent</h1>', contentType: 'text/html' };
const SITE = {
  kind: 'folder',
  name: 'site',
  files: [
    { path: 'index.html', bytes: Buffer.from('<!doctype html><title>site</title><script src="assets/app.js"></script>') },
    { path: 'assets/app.js', bytes: Buffer.from('document.title = "site";\n') },
    { path: 'about/index.html', bytes: Buffer.from('<p>about</p>') },
  ],
};
const NOTES = { kind: 'file', name: 'notes.md', contentType: 'text/markdown', data: Buffer.from('# Notes\n\nPlain text.\n') };

/**
 * Each case's run on a backend's world: what it answered, for the record
 * the two backends must share. `world.controller()` makes a controller
 * with the backend's own calls; `world.readiness()` a readiness.
 */
const CASES = [
  {
    name: 'readiness: Ant’s start=0 needs ten advancing blocks after the first confirmed read',
    core: ['swarm.stamps'],
    async run(world) {
      world.node.state.global[BATCH].start = 0;
      const readiness = world.readiness();
      const first = await settle(readiness.inspect(BATCH, 10));
      const again = await settle(readiness.inspect(BATCH, 10, 100));
      world.node.state.chain.block = 110;
      const later = await settle(readiness.inspect(BATCH, 10, 100));
      return { first, again, later };
    },
    check(record) {
      expect(record.first).toEqual({ value: { ready: false, firstConfirmedBlock: 100, blocksRemaining: 10 } });
      expect(record.again.value).toMatchObject({ ready: false });
      expect(record.later.value).toMatchObject({ ready: true, blocksRemaining: 0 });
    },
  },
  {
    name: 'readiness: a genuine start; an expired batch and one without room are permanent; a chain out of schema is not',
    core: ['swarm.stamps'],
    async run(world) {
      const readiness = world.readiness();
      const genuine = await settle(readiness.inspect(BATCH, 10));
      world.node.state.global[BATCH].batchTTL = 0;
      const expired = await settle(readiness.inspect(BATCH, 10));
      world.node.state.global[BATCH].batchTTL = 864000;
      Object.assign(world.node.state.stamps[0], { depth: 17, utilization: 0 });
      const full = await settle(readiness.inspect(BATCH, 1_000_000));
      Object.assign(world.node.state.stamps[0], { depth: 22, utilization: 16 });
      world.node.state.chain = { block: '100', chainTip: 100, totalAmount: '5000', currentPrice: '24000' };
      // Thrown where bee-js's schema throws, its text zod's on js.
      const { error } = await settle(readiness.inspect(BATCH, 10));
      const unread = { threw: Boolean(error), permanent: error?.permanent };
      return { genuine, expired, full, unread };
    },
    check(record) {
      expect(record.genuine.value).toMatchObject({ ready: true, firstConfirmedBlock: 80 });
      expect(record.expired.error).toMatchObject({ code: 'POSTAGE_UNAVAILABLE', permanent: true });
      expect(record.full.error).toMatchObject({ code: 'POSTAGE_CAPACITY_INSUFFICIENT', permanent: true });
      expect(record.unread).toEqual({ threw: true, permanent: undefined });
    },
  },
  {
    name: 'readiness: the card’s batch, time left, cost and room; no usable batch, and none with room',
    core: ['swarm.stamps'],
    async run(world) {
      const readiness = world.readiness();
      const preview = await settle(readiness.preview('owner', 10_000, { files: 2 }));
      world.node.state.stamps = [stamp(BATCH, { depth: 17 })];
      const tight = await settle(readiness.select('owner', 1_000_000));
      world.node.state.stamps = [stamp(BATCH, { usable: false, propagating: false })];
      const none = await settle(readiness.select('owner', 10));
      return { preview, tight, none };
    },
    check(record) {
      expect(record.preview.value).toMatchObject({
        status: 'ready',
        batchId: BATCH,
        usable: true,
        ttlSeconds: 864000,
        estimatedChunks: 6,
        estimatedCostPlur: String(100_000_000_000n * 6n),
        expiry: 'ok',
      });
      // The room left, not the batch's size.
      expect(record.preview.value.remainingBytes).toBeGreaterThan(0);
      expect(record.preview.value.remainingBytes).toBeLessThan(7_070_000_000);
      expect(record.tight.error.code).toBe('POSTAGE_CAPACITY_INSUFFICIENT');
      expect(record.none.error.code).toBe('POSTAGE_UNAVAILABLE');
    },
  },
  {
    name: 'publishes text: the row before the upload, the batch on the card, the tag confirmed, retrieval verified',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    run: (world) => world.publish([{ input: TEXT }]),
    check(record) {
      expect(record.outcomes[0].value.publication).toMatchObject({
        state: 'completed',
        kind: 'text',
        batchId: BATCH,
        verified: true,
        progress: 100,
      });
      expect(record.cards[0].publication.postage).toMatchObject({ status: 'ready', batchId: BATCH });
      expect(record.history).toEqual([
        expect.objectContaining({ status: 'completed', origin: 'freedom://agent', type: 'data', tagUid: 41 }),
      ]);
      expect(record.uploads).toHaveLength(1);
    },
  },
  {
    name: 'publishes one attached file with its name and type',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    run: (world) => world.publish([{ input: { resourceId: 'file_aaaaaaaaaaaaaaaaaaaa' }, source: NOTES }]),
    check(record) {
      expect(record.outcomes[0].value.publication).toMatchObject({ state: 'completed', kind: 'file', name: 'notes.md' });
      expect(record.uploads[0]).toMatchObject({ name: 'notes.md', headers: { 'content-type': 'text/markdown' } });
    },
  },
  {
    name: 'publishes a folder with nested files and a nested index document',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    run: (world) =>
      // Not index.html, which a node is told by default when one is at the top.
      world.publish([{ input: { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa', indexDocument: 'about/index.html' }, source: SITE }]),
    check(record) {
      expect(record.outcomes[0].value.publication).toMatchObject({ state: 'completed', kind: 'folder', indexDocument: 'about/index.html' });
      expect(record.uploads[0].entries.map((e) => e.name)).toEqual(['index.html', 'assets/app.js', 'about/index.html']);
      expect(record.uploads[0].headers['swarm-index-document']).toBe('about/index.html');
    },
  },
  {
    name: 'a private draft link: encrypted, confirmed by its root’s tag',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    run: (world) =>
      world.publish([{ input: { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa', target: 'draft' }, source: SITE }]),
    check(record) {
      const { publication } = record.outcomes[0].value;
      expect(publication).toMatchObject({ state: 'completed', target: 'draft', encrypted: true, verified: true });
      expect(publication.reference).toMatch(/^[0-9a-f]{128}$/);
      expect(record.uploads[0].headers['swarm-encrypt']).toBe('true');
    },
  },
  {
    name: 'a draft the node didn’t encrypt fails with its public reference',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps'],
    async run(world) {
      world.node.state.ignoreEncrypt = true;
      return world.publish([{ input: { ...TEXT, target: 'draft' } }]);
    },
    check(record) {
      expect(record.outcomes[0].error.message).toContain('did not encrypt');
      expect(record.history[0]).toMatchObject({ status: 'failed', reference: expect.stringMatching(/^[0-9a-f]{64}$/) });
    },
  },
  {
    name: 'a stable address: created at index 0, then moved to the next version from another conversation',
    core: ['swarm.feed', 'swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    feeds: true,
    run: (world) =>
      world.publish([
        { input: { ...TEXT, stableAddress: 'my-site' }, conversationId: 'conversation_one' },
        { input: { text: '<h1>second</h1>', contentType: 'text/html', stableAddress: 'my-site' }, conversationId: 'conversation_two' },
      ]),
    check(record) {
      const [first, second] = record.outcomes.map((o) => o.value.publication);
      expect(first.stableAddress).toMatchObject({ name: 'my-site', index: 0, updated: true });
      expect(second.stableAddress).toMatchObject({ name: 'my-site', index: 1, updated: true, reference: first.stableAddress.reference });
      expect(record.cards[0].publication.stableAddress).toMatchObject({ existing: 'no' });
      expect(record.cards[1].publication.stableAddress).toMatchObject({ existing: 'yes' });
    },
  },
  {
    name: 'a stable address the network already has: the card reads its version, the update goes above it',
    core: ['swarm.feed', 'swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    feeds: true,
    async run(world) {
      await world.publish([{ input: { ...TEXT, stableAddress: 'kept' } }]);
      // A fresh controller has no record of it.
      return world.publish([{ input: { text: 'again', contentType: 'text/plain', stableAddress: 'kept' } }], { publicationId: 'c' });
    },
    check(record) {
      expect(record.cards[0].publication.stableAddress).toMatchObject({ existing: 'yes', latestIndex: 0 });
      expect(record.outcomes[0].value.publication.stableAddress).toMatchObject({ index: 1, updated: true });
    },
  },
  {
    name: 'peers that don’t know the batch yet: the same upload again with the same batch',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    async run(world) {
      world.node.state.failUploads = [
        { status: 500, body: { code: 500, message: `pushsync: postage batch 0x${BATCH} rejected by 2 peer(s) as not found on-chain` } },
      ];
      return world.publish([{ input: TEXT }]);
    },
    check(record) {
      expect(record.outcomes[0].value.publication).toMatchObject({ state: 'completed' });
      expect(record.uploads).toHaveLength(2);
      expect(record.uploads[0]).toEqual(record.uploads[1]);
      expect(record.states).toContain('waiting_postage');
    },
  },
  {
    name: 'a refused upload is a known failure, the batch kept',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps'],
    async run(world) {
      world.node.state.failUploads = [{ status: 400, body: { code: 400, message: 'invalid content type' } }];
      return world.publish([{ input: TEXT }]);
    },
    check(record) {
      expect(record.outcomes[0].error).toMatchObject({ message: expect.stringContaining('invalid content type') });
      expect(record.history[0]).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('invalid content type') });
    },
  },
  {
    name: 'retrieval that fails: completed, unverified, with bee-js’s text',
    core: ['swarm.history', 'swarm.publish', 'swarm.stamps', 'swarm.upload_status'],
    async run(world) {
      world.node.state.serveBytes = false;
      return world.publish([{ input: TEXT }]);
    },
    check(record) {
      expect(record.outcomes[0].value.publication).toMatchObject({
        state: 'completed',
        verified: false,
        error: 'Not Found: {"code":404,"message":"Not Found"}',
      });
    },
  },
  {
    name: 'no batch with room: refused before any upload, with the capacity',
    core: ['swarm.history', 'swarm.stamps'],
    async run(world) {
      world.node.state.stamps = [stamp(BATCH, { depth: 17 })];
      return world.publish([{ input: { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa' }, source: { ...SITE, files: [{ path: 'big.bin', bytes: Buffer.alloc(100_000, 1) }] } }]);
    },
    check(record) {
      expect(record.outcomes[0].error).toMatchObject({ code: 'POSTAGE_CAPACITY_INSUFFICIENT' });
      expect(record.outcomes[0].error.message).toContain('largest usable batch remaining: 40890 bytes');
      expect(record.uploads).toEqual([]);
      expect(record.history[0]).toMatchObject({ status: 'failed' });
    },
  },
];

// ---- The worlds ---------------------------------------------------------------

/** Main's boundaries for a fresh registry, everything Swarm main's own. */
function mockBoundaries(world) {
  const mock = (rel, factory) => jest.doMock(SRC_PATH(rel), factory);
  jest.doMock('electron', () => ({
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    app: { getPath: () => world.dir, getVersion: () => '0.0.0-jest', isPackaged: false, on() {}, whenReady: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null },
    session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
    webContents: { fromId: () => null, getAllWebContents: () => [] },
    nativeTheme: {},
    shell: {},
  }), { virtual: true });
  jest.doMock('electron-log', () => SILENT);
  // Each load of bee-js, from where it came: on the core's backend the
  // agent's modules load none of it.
  jest.doMock('@ethersphere/bee-js', () => {
    world.beeLoaded.push(new Error('bee-js loaded').stack);
    return jest.requireActual('@ethersphere/bee-js');
  });
  mock('logger.js', () => ({
    ...SILENT,
    warn: (...args) => world.warnings.push(args.map(String).join(' ')),
    error: (...args) => world.warnings.push(args.map(String).join(' ')),
  }));
  mock('service-registry.js', () => ({
    ...jest.requireActual(SRC_PATH('service-registry.js')),
    getAntApiUrl: () => world.node.origin,
    getService: (name) => (name === 'ant' ? { mode: 'bundled' } : null),
    onServiceChange: () => () => {},
  }));
  mock('freedom-root.js', () => ({
    ...jest.requireActual(SRC_PATH('freedom-root.js')),
    getFreedomDataDir: () => world.dir,
    getFreedomDataPath: (name) => path.join(world.dir, name),
  }));
  mock('private/private-windows.js', () => ({ isPrivateWebContents: () => false, getPartitionForWebContents: () => null }));
  mock('ant-manager.js', () => ({ restartingUrl: () => null }));
  mock('core/dweb-verify.js', () => ({ dwebVerifier: () => null }));
  mock('core/naming.js', () => ({ namingDriver: () => null }));
  mock('fs-offload.js', () => ({}));
  mock('profile-paths.js', () => ({
    getIdentityDataDir: () => path.join(world.dir, 'identity'),
    getAntDataDir: () => path.join(world.dir, 'ant'),
    getIpfsDataDir: () => path.join(world.dir, 'ipfs'),
    getRadicleDataDir: () => path.join(world.dir, 'radicle'),
    prepareRadicleDataDir: async () => {},
  }));
  mock('profile-resolver.js', () => ({ getActiveProfile: () => ({ id: 'default' }) }));
  mock('core/node-identity-guard.js', () => ({
    blockNode() {},
    unblockNode() {},
    nodeWriteStatus: () => null,
    restoreNodeWrite() {},
    setStartupRecovery() {},
    setRecoveryUnknown() {},
  }));
  mock('private-files.js', () => ({ withPrivateDir() {} }));
  mock('swarm/ant-keystore-password.js', () => ({}));
  // The core's process is the test's (core-process.js would spawn its own).
  mock('core/core-process.js', () => ({
    getCoreClient: () => world.client,
    getSwarmShell: () => world.swarmShell,
    isCoreRunning: () => Boolean(world.client),
  }));
}

/** A backend's world: its core (vault imported), its node, main's modules in a registry of their own. */
async function startWorld(world, backend) {
  world.dir = fs.mkdtempSync(path.join(os.tmpdir(), `swarm-agent-${backend}-`));
  fs.writeFileSync(path.join(world.dir, 'settings.json'), JSON.stringify({ enableIdentityWallet: true }));
  world.node = await startAgentNode(freshState());
  world.warnings = [];
  world.exits = [];
  world.sent = [];
  world.beeLoaded = [];
  world.backend = backend;
  world.saved = process.env.FREEDOM_SWARM_BACKEND;
  // A development build's switch, read once, as main reads it.
  process.env.FREEDOM_SWARM_BACKEND = backend;
  jest.resetModules();
  mockBoundaries(world);
  const { CoreClient } = require(SRC_PATH('core/core-client.js'));
  world.client = new CoreClient({
    spawn,
    command: BINARY,
    args: [
      'serve',
      '--data-dir',
      path.join(world.dir, 'identity'),
      '--lock-dir',
      path.join(world.dir, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: SILENT,
    shellVersion: 'jest',
    grantRoot: world.dir,
    userDataDir: world.dir,
  });
  // Each request main sends the core, by its method.
  const request = world.client.request.bind(world.client);
  world.client.request = (method, ...rest) => {
    world.sent.push(method);
    return request(method, ...rest);
  };
  // As index.js registers it, on either backend.
  world.swarmShell = require(SRC_PATH('core/swarm-shell.js')).registerSwarmShell(world.client);
  await world.client.start();
  world.pid = world.client.current.child.pid;
  world.client.current.child.on('exit', (code, signal) => world.exits.push(code ?? signal));
  await world.client.request(
    'vault.import',
    { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), overwrite: false, user_knows_password: true },
    { caller: 'shell' }
  );
  const { SwarmPublicationController } = require(SRC_PATH('agent/swarm-publication-controller.js'));
  const { SwarmPostageReadiness } = require(SRC_PATH('agent/swarm-postage-readiness.js'));
  const { preparePublication } = require(SRC_PATH('agent/publication-scan.js'));
  const history = require(SRC_PATH('swarm/publish-history.js'));
  world.backendKind = require(SRC_PATH('swarm/swarm-backend-kind.js')).swarmBackendKind;
  world.storesNamed = require(SRC_PATH('core/core-client.js')).swarmStoresNamed;
  world.pool = require(SRC_PATH('core/swarm-io-pool.js')).swarmIoPool;
  const onCore = backend === 'core';
  world.rows = async () => (onCore ? await history.coreOps.getEntries() : history.getEntries());
  world.clearRows = async () => (onCore ? await history.coreOps.clearEntries() : history.clearEntries());
  world.readiness = () => new SwarmPostageReadiness();

  /**
   * Publishes each of `steps` in turn with one controller (its default
   * Swarm calls, its readiness the backend's), approving each card:
   * `{ input, source?, conversationId? }`, `source` the attachment an
   * input's `resourceId` names. Records what the two backends must share.
   */
  world.publish = async (steps, { publicationId = 'd' } = {}) => {
    const cards = [];
    const states = [];
    let source = null;
    let ids = 0;
    const controller = new SwarmPublicationController({
      attachmentStore: { resolvePublicationSource: async () => source },
      readAttachmentSource: async (descriptor) => descriptor,
      preparePublication: async (descriptor) => preparePublication(descriptor),
      postageReadiness: world.readiness(),
      publicationIdFactory: () => `swarm_pub_${publicationId.repeat(23)}${(ids++).toString(16)}`,
      // A case that never gets its postage ends at the job's deadline.
      interactiveTimeoutMs: 30_000,
      jobTimeoutMs: 15_000,
      readinessPollMs: 10,
      retryDelayMs: 10,
      progressPollMs: 10,
    });
    const outcomes = [];
    for (const step of steps) {
      source = step.source ?? null;
      outcomes.push(
        await settle(
          controller.publish(step.input, {
            conversationId: step.conversationId || 'conversation_test',
            requestApproval: async (card) => {
              cards.push(JSON.parse(JSON.stringify(card)));
              return 'approved';
            },
            onProgress: (progress) => {
              if (states.at(-1) !== progress.state) states.push(progress.state);
            },
          })
        )
      );
    }
    return { outcomes, cards, states };
  };
}

async function stopWorld(world) {
  await world.client?.stop();
  await world.node?.close();
  if (world.saved === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
  else process.env.FREEDOM_SWARM_BACKEND = world.saved;
  if (world.dir) fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Waits, bounded, for `predicate`. */
async function until(predicate, ms = 5000) {
  for (let waited = 0; waited < ms && !predicate(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const records = { js: new Map(), core: new Map() };

for (const backend of ['js', 'core']) {
  describeIfCore(`the agent's Swarm modules on ${backend} (real freedom-cored)`, () => {
    const world = {};
    beforeAll(() => startWorld(world, backend));
    afterAll(() => stopWorld(world));

    beforeEach(async () => {
      Object.assign(world.node.state, freshState());
      world.node.calls.length = 0;
      world.node.uploads.length = 0;
      world.node.content.clear();
      world.node.chunks.clear();
      world.warnings.length = 0;
      await world.clearRows();
      world.sent.length = 0;
    });

    test(`the switch reads ${backend}; the hello names swarm_stores only on core`, () => {
      expect(world.backendKind()).toBe(backend);
      expect(world.storesNamed()).toBe(backend === 'core');
    });

    for (const { name, run, check, core, feeds = false } of CASES) {
      test(name, async () => {
        const answered = await run(world);
        // Main's Swarm requests to the core: on core the agent's own; on js
        // none but the vault's signatures of a feed update (swarm-signer.js).
        const swarmMethods = [...new Set(world.sent.filter((m) => m.startsWith('swarm.')))].sort();
        expect(swarmMethods).toEqual(backend === 'core' ? core : feeds ? ['swarm.sign_soc'] : []);
        const record = {
          ...answered,
          history: (await world.rows()).map(rowOf),
          uploads: world.node.uploads.map((u) => ({ ...u })),
          // Each call once: bee-js's choice reads /stamps again for a
          // batch that isn't usable, and tags are polled until done.
          calls: [...new Set(world.node.calls)].sort(),
        };
        records[backend].set(name, record);
        check(record);
        if (backend === 'core') {
          expect(record).toEqual(records.js.get(name));
          // The same core throughout, nothing refused, nothing held.
          await until(() => world.pool.held === 0 && world.swarmShell.stats().parents === 0);
          expect(world.exits).toEqual([]);
          expect(world.client.current?.child?.pid).toBe(world.pid);
          expect(world.pool.held).toBe(0);
          expect(world.swarmShell.stats()).toEqual({ parents: 0, calls: 0, walks: 0, uploads: 0, parts: 0 });
          expect(world.warnings).toEqual([]);
          expect(world.beeLoaded).toEqual([]);
        }
      });
    }

    test(`bee-js ${backend === 'core' ? 'was never loaded' : 'did the work'}`, () => {
      if (backend === 'core') expect(world.beeLoaded).toEqual([]);
      else expect(world.beeLoaded.length).toBeGreaterThan(0);
    });
  });
}
