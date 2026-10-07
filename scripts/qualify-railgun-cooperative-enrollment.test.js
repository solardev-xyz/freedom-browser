jest.mock(
  'original-fs',
  () => ({ realpathSync: jest.fn(), lstatSync: jest.fn(), readFileSync: jest.fn() }),
  { virtual: true }
);
jest.mock('./qualify-railgun-account-fence', () => ({
  SOURCES: ['src/main/wallet/railgun-account-fence.js'],
  verifyInputs: jest.fn(),
}));
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scenario,
  installIdentityObserver,
  verifyInputs,
} = require('./qualify-railgun-cooperative-enrollment');
const { SOURCES } = require('./fixtures/railgun-kohaku-adapter-sources');
const generation = 'a'.repeat(64);
const policy = '2'.repeat(64);
const refused = () =>
  Object.assign(Error('refused'), { code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED' });
function fakeApi({
  genericBypass = false,
  reopenGeneration = generation,
  staticBrand = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cooperative-enrollment-unit-'));
  const branded = new WeakSet();
  let marked = false,
    retained = false;
  const create = (fenced) => {
    const controller = new AbortController();
    const entry = {
      directory,
      signal: controller.signal,
      close: () => {
        controller.abort();
        if (fenced) retained = true;
      },
      catalog: {
        begin: jest.fn(async (p) => ({ id: generation, policy: p })),
        resume: jest.fn(async () => ({ id: reopenGeneration, policy })),
      },
    };
    if (fenced) branded.add(entry);
    return entry;
  };
  return {
    openRailgunCooperativeAccountEnrollment: jest.fn(async ({ create: fresh }) => {
      if (retained) throw refused();
      if (fresh) {
        marked = true;
        fs.writeFileSync(path.join(directory, 'writer-fence.sqlite'), 'unit-only');
      }
      return create(true);
    }),
    openRailgunAccountEnrollment: jest.fn(async () => {
      if (retained && !genericBypass) throw refused();
      return create(marked);
    }),
    assertRailgunFencedAccountEnrollment: (entry) => {
      if (!branded.has(entry) || (!staticBrand && entry.signal.aborted)) throw refused();
    },
    makeCold() {
      marked = true;
      fs.writeFileSync(path.join(directory, 'writer-fence.sqlite'), 'unit-only');
    },
  };
}
test('cooperative create proves both same-process reopen refusals after close', async () => {
  const api = fakeApi();
  const report = await scenario('create', api, {});
  expect(report.bothSameProcessReopensRefused).toBe(true);
  expect(api.openRailgunAccountEnrollment).toHaveBeenCalledTimes(1);
  expect(api.openRailgunCooperativeAccountEnrollment).toHaveBeenCalledTimes(2);
});
test('cold generic opener retains the exact generation join', async () => {
  const api = fakeApi();
  api.makeCold();
  expect((await scenario('cold', api, {}, generation)).genericColdReopen).toBe(true);
});
test('legacy path really reopens without a cooperative fence', async () => {
  const api = fakeApi();
  const report = await scenario('legacy', api, {});
  expect(report.legacySameProcessReopen).toBe(true);
  expect(api.openRailgunAccountEnrollment).toHaveBeenCalledTimes(2);
  expect(api.openRailgunCooperativeAccountEnrollment).not.toHaveBeenCalled();
});
test.each([
  ['generic bypass', { genericBypass: true }, 'create'],
  ['static brand', { staticBrand: true }, 'create'],
  ['wrong cold generation', { reopenGeneration: 'b'.repeat(64) }, 'cold'],
])('distinguishes %s', async (_label, options, mode) => {
  const api = fakeApi(options);
  if (mode === 'cold') api.makeCold();
  await expect(scenario(mode, api, {}, generation)).rejects.toThrow();
});
const guards = { hooks: ['unit-only'], canaries: 1, attempts: 0 };
function job(purpose, closed) {
  const reply = Promise.resolve('original');
  const dispatch = jest.fn(() => reply);
  return {
    options: {
      filename: require.resolve('../src/main/wallet/railgun-identity-job'),
      input: JSON.stringify({ purpose }),
      binaryKey: true,
      broker: { dispatch },
    },
    task: { closed },
    dispatch,
    reply,
  };
}
const closure = {
  code: 'RAILGUN_PROCESS_CLOSED',
  exitCode: 15,
  escalated: false,
  peerDisconnected: false,
};
async function emit(row) {
  const first = row.options.broker.dispatch(
    JSON.stringify({ id: 1, method: 'key', purpose: JSON.parse(row.options.input).purpose })
  );
  expect(first).toBe(row.reply);
  const second = row.options.broker.dispatch(
    JSON.stringify({ id: 2, method: 'result', value: {}, guards })
  );
  expect(second).toBe(row.reply);
  await first;
}
test('observer returns exact task and broker promises and restores only owned wrappers', async () => {
  const rows = ['spending-public', 'viewing-identity'].map((p) => job(p, Promise.resolve(closure)));
  const original = jest.fn(() => rows[original.mock.calls.length - 1].task);
  const runtime = { startRailgunProcess: original },
    violations = [];
  const observer = installIdentityObserver(runtime, guards, violations);
  for (const row of rows) {
    expect(runtime.startRailgunProcess(row.options)).toBe(row.task);
    await emit(row);
  }
  expect(observer.finish()).toHaveLength(2);
  observer.restore();
  expect(runtime.startRailgunProcess).toBe(original);
  for (const row of rows) expect(row.options.broker.dispatch).toBe(row.dispatch);
});
test('next utility cannot start before previous original closure', () => {
  const first = job('spending-public', new Promise(() => {}));
  const runtime = { startRailgunProcess: () => first.task };
  const observer = installIdentityObserver(runtime, guards, []);
  runtime.startRailgunProcess(first.options);
  expect(() =>
    runtime.startRailgunProcess(job('viewing-identity', Promise.resolve(closure)).options)
  ).toThrow();
  observer.restore();
});
test.each([0, 1])('wrong original utility exit %s fails sticky qualification', async (exitCode) => {
  const row = job('spending-public', Promise.resolve({ ...closure, exitCode }));
  const runtime = { startRailgunProcess: () => row.task },
    violations = [];
  const observer = installIdentityObserver(runtime, guards, violations);
  runtime.startRailgunProcess(row.options);
  await emit(row);
  expect(violations).toHaveLength(1);
  expect(() => observer.finish()).toThrow();
  observer.restore();
});
test('swallowed malformed broker message still fails final observation without replacing original reply', async () => {
  const row = job('spending-public', Promise.resolve(closure));
  const runtime = { startRailgunProcess: () => row.task },
    violations = [];
  const observer = installIdentityObserver(runtime, guards, violations);
  runtime.startRailgunProcess(row.options);
  expect(row.options.broker.dispatch('{}')).toBe(row.reply);
  await row.reply;
  expect(() => observer.finish()).toThrow();
  observer.restore();
});

function inputFixture({ linked = false } = {}) {
  const { createHash } = require('crypto');
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const sourceRoot = path.resolve(__dirname, '..'),
    output = '/private/tmp/unit-cooperative';
  const data = Buffer.from('public source-only dummy');
  const names = [
    ...SOURCES,
    'scripts/qualify-railgun-cooperative-enrollment.js',
    'src/main/wallet/railgun-account-enrollment.js',
    'src/main/wallet/railgun-account-fence.js',
    'src/main/wallet/railgun-identity.js',
  ];
  const link = 'scripts/fixtures/unit/node_modules/.bin/tool';
  if (linked) names.push(link);
  const sources = Object.fromEntries(names.map((p) => [p, hash(data)]));
  const archive = sourceRoot + '/tmp/unit-engine.asar';
  const electron = sourceRoot + '/node_modules/unit-electron';
  const runtimeInputs = Object.fromEntries(
    [
      archive,
      electron,
      sourceRoot + '/node_modules/unit-framework',
      ...Array.from({ length: 17 }, (_, i) => sourceRoot + '/node_modules/better-sqlite3/unit' + i),
    ].map((p) => [p, { bytes: data.length, sha256: hash(data) }])
  );
  const config = {
    schema: 'railgun-cooperative-enrollment-native-v1',
    approvedForNative: true,
    sourceRoot,
    output,
    sources,
    sourceLinks: linked ? { [link]: '../tool/bin.js' } : {},
    runtimeInputs,
    archive,
    electron,
  };
  const linkPath = path.join(sourceRoot, link);
  jest
    .spyOn(fs, 'realpathSync')
    .mockImplementation((p) =>
      linked && p === linkPath ? path.resolve(path.dirname(p), '../tool/bin.js') : p
    );
  // Deliberately model Electron's archive virtualization: using patched fs for
  // any archive stat/read fails even though the original raw file is regular.
  const originalRead = fs.readFileSync;
  const fixedFiles = new Set([
    ...Object.keys(runtimeInputs),
    ...names.map((p) => path.join(sourceRoot, p)),
  ]);
  jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
    if (p === archive) throw Error('ASAR virtual directory');
    return fixedFiles.has(p) ? data : Reflect.apply(originalRead, fs, [p, ...args]);
  });
  jest.spyOn(fs, 'lstatSync').mockImplementation((p) => ({
    isFile: () => p !== archive,
    isSymbolicLink: () => linked && p === linkPath,
  }));
  jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true });
  jest.spyOn(fs, 'readlinkSync').mockReturnValue('../tool/bin.js');
  jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  const raw = require('original-fs');
  raw.realpathSync.mockImplementation((p) => p);
  raw.lstatSync.mockReturnValue({ isFile: () => true });
  raw.readFileSync.mockReturnValue(data);
  return { config, raw, link, linkPath, data };
}
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
test('child pin checks use raw archive fs despite patched virtual-directory behavior', () => {
  const { config, raw } = inputFixture();
  verifyInputs(config);
  expect(raw.readFileSync).toHaveBeenCalledWith(config.archive);
  expect(raw.lstatSync).toHaveBeenCalledWith(config.archive);
  expect(require('./qualify-railgun-account-fence').verifyInputs).toHaveBeenCalledTimes(1);
  raw.readFileSync.mockReturnValue(Buffer.from('changed archive'));
  expect(() => verifyInputs(config)).toThrow();
});
test('child accepts exact reviewed dependency symlink with pinned target bytes', () => {
  const { config } = inputFixture({ linked: true });
  expect(() => verifyInputs(config)).not.toThrow();
});
test.each([
  'changed text',
  'added link',
  'missing link',
  'escaping target',
  'changed target bytes',
])('child refuses %s', (kind) => {
  const { config, link, linkPath, data } = inputFixture({ linked: true });
  if (kind === 'changed text') fs.readlinkSync.mockReturnValue('../other/bin.js');
  if (kind === 'added link') config.sourceLinks = {};
  if (kind === 'missing link') config.sourceLinks['scripts/absent-link'] = '../other.js';
  if (kind === 'escaping target')
    fs.realpathSync.mockImplementation((p) => (p === linkPath ? '/private/tmp/escaped.js' : p));
  if (kind === 'changed target bytes')
    fs.readFileSync.mockImplementation((p) => (p === linkPath ? Buffer.from('changed') : data));
  expect(() => verifyInputs(config)).toThrow();
  expect(config.sources[link]).toMatch(/^[a-f0-9]{64}$/);
});
test('child refuses source drift and profile inventory injection', () => {
  const { config } = inputFixture();
  expect(() =>
    verifyInputs({
      ...config,
      sources: { ...config.sources, 'src/main/wallet/railgun-identity.js': '0'.repeat(64) },
    })
  ).toThrow();
  expect(() =>
    verifyInputs({
      ...config,
      runtimeInputs: {
        ...config.runtimeInputs,
        [config.output + '/writer-fence.sqlite']: { bytes: 1, sha256: '0'.repeat(64) },
      },
    })
  ).toThrow();
});

test.each(SOURCES)('child requires the shared source pin %s', (name) => {
  const { config } = inputFixture();
  const sources = { ...config.sources };
  delete sources[name];
  expect(() => verifyInputs({ ...config, sources })).toThrow();
  expect(() =>
    verifyInputs({ ...config, sources: { ...config.sources, [name]: '0'.repeat(64) } })
  ).toThrow();
});
test('shared package allowance does not admit unrelated installed dependencies', () => {
  const { config } = inputFixture();
  expect(() =>
    verifyInputs({
      ...config,
      sources: {
        ...config.sources,
        'node_modules/unrelated/index.js': '0'.repeat(64),
      },
    })
  ).toThrow();
});
