jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { assertHandoff, recordBinding } = require('./railgun-public-cold-handoff');
const { digest } = require('./railgun-public-cold-data');
function fixture() {
  const value = {
    schema: 'railgun-public-cold-credit-v1',
    phase: 'setup',
    mode: 'acknowledged',
    pid: 111,
    inputs: { source: 'a', archive: 'b', bytecodes: 'c' },
    sourceHashes: { code: 'd' },
    profileFiles: { vault: 'e' },
    chainSha256: 'f'.repeat(64),
    owner: '0x' + '12'.repeat(20),
    baseline: { notesSha256: '1'.repeat(64), balanceSha256: '2'.repeat(64), checkpoint: {} },
    creditSha256: null,
    record: {
      hash: '0x' + '33'.repeat(32),
      nonce: 0,
      intentSha256: '4'.repeat(64),
      attemptedAt: 1,
    },
  };
  return {
    value,
    options: {
      phase: 'resolve',
      mode: 'acknowledged',
      inputs: JSON.parse(JSON.stringify(value.inputs)),
      sourceHashes: JSON.parse(JSON.stringify(value.sourceHashes)),
      pid: 222,
      isAlive: () => false,
    },
  };
}
test('exact predecessor seal and closed metadata shape', () => {
  const { value, options } = fixture();
  expect(assertHandoff(value, options)).toBe(value);
});
test.each(['pid', 'alive', 'phase', 'mode', 'runtime', 'source', 'extra', 'owner', 'private'])(
  'rejects %s',
  (mode) => {
    const { value, options } = fixture();
    if (mode === 'pid') value.pid = options.pid;
    if (mode === 'alive') options.isAlive = () => true;
    if (mode === 'phase') value.phase = 'resolve';
    if (mode === 'mode') value.mode = 'lost-response';
    if (mode === 'runtime') value.inputs.archive = 'wrong';
    if (mode === 'source') value.sourceHashes.code = 'wrong';
    if (mode === 'extra') value.receipt = {};
    if (mode === 'owner') value.owner = '0x0';
    if (mode === 'private') value.baseline.ownedPoi = [];
    expect(() => assertHandoff(value, options)).toThrow();
  }
);
test('record seal ignores legitimate observation revisions but binds immutable sender intent', () => {
  const record = {
    hash: '0x' + '33'.repeat(32),
    nonce: 1,
    attemptedAt: 5,
    intent: { digest: 'a' },
    revision: 2,
    observation: { status: 'pending' },
  };
  const sealed = recordBinding(record);
  expect(recordBinding({ ...record, revision: 3, observation: { status: 'included' } })).toEqual(
    sealed
  );
  expect(recordBinding({ ...record, intent: { digest: 'b' } })).not.toEqual(sealed);
  expect(sealed.intentSha256).toBe(digest(record.intent));
});
test('encrypted scope includes vault metadata, nested wallet files, journal and authenticated inventory', () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-cold-seal-unit-'));
  for (const name of ['identity', 'wallet-railgun-accounts', 'wallet-private-submissions'])
    fs.mkdirSync(path.join(directory, name));
  for (const name of [
    'identity/identity-vault.json',
    'identity/vault-meta.json',
    'wallet-railgun-accounts/wallet.sqlite',
    'wallet-private-submissions/attempt.json',
    'wallet-privacy-inventory.json',
  ])
    fs.writeFileSync(path.join(directory, name), 'unit-only encrypted-byte standin');
  const { profileFiles } = require('./railgun-public-cold-handoff');
  const before = profileFiles(directory);
  expect(Object.keys(before).sort()).toEqual(
    [
      'identity/identity-vault.json',
      'identity/vault-meta.json',
      'wallet-privacy-inventory.json',
      'wallet-private-submissions/attempt.json',
      'wallet-railgun-accounts/wallet.sqlite',
    ].sort()
  );
  fs.writeFileSync(path.join(directory, 'wallet-private-submissions/attempt.json'), 'changed');
  expect(profileFiles(directory)).not.toEqual(before);
  fs.writeFileSync(path.join(directory, 'Preferences'), 'unrelated browser cache');
  expect(Object.keys(profileFiles(directory))).not.toContain('Preferences');
});

test('qualifier hashes external ASAR bytes through original-fs, not Electron virtual fs', () => {
  const fs = require('fs'),
    path = require('path'),
    vm = require('vm');
  const source = fs.readFileSync(
    path.join(__dirname, '../qualify-railgun-public-facade-cold-credit.js'),
    'utf8'
  );
  const start = source.indexOf('  const inputs = Object.fromEntries('),
    end = source.indexOf('  let previous, chain;', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const declaration = source.slice(start, end);
  const files = {
    '/fixture/source.json': Buffer.from('public source'),
    '/fixture/engine.asar': Buffer.from('actual archive container bytes'),
    '/fixture/bytecodes.json': Buffer.from('public bytecodes'),
  };
  const originalFs = { readFileSync: jest.fn((file) => files[file]) };
  const virtualFs = {
    readFileSync: jest.fn((file) => {
      if (file.endsWith('.asar'))
        throw Object.assign(Error('ASAR virtual directory is not a file'), { code: 'ENOENT' });
      return files[file];
    }),
  };
  const globals = {
    sourceFile: '/fixture/source.json',
    archive: '/fixture/engine.asar',
    bytecodes: '/fixture/bytecodes.json',
    data: { digest },
    originalFs,
    fs: virtualFs,
  };
  const inputs = vm.runInNewContext(declaration + '\ninputs;', globals);
  expect(JSON.parse(JSON.stringify(inputs))).toEqual({
    source: digest(files[globals.sourceFile]),
    archive: digest(files[globals.archive]),
    bytecodes: digest(files[globals.bytecodes]),
  });
  expect(originalFs.readFileSync.mock.calls).toEqual(
    [globals.sourceFile, globals.archive, globals.bytecodes].map((file) => [file])
  );
  expect(virtualFs.readFileSync).not.toHaveBeenCalled();
  // Detached regression control executes the exact qualifier segment with only
  // the reviewed filesystem choice reverted. It must hit the ASAR failure.
  expect(() =>
    vm.runInNewContext(
      declaration.replace('originalFs.readFileSync(file)', 'fs.readFileSync(file)') + '\ninputs;',
      { ...globals }
    )
  ).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

function inventoryCacheCheck(
  cache,
  sources = { 'src/main/owned.js': 'pinned' },
  root = process.cwd()
) {
  const fs = require('fs'),
    path = require('path'),
    vm = require('vm');
  const source = fs.readFileSync(
    path.join(__dirname, '../qualify-railgun-public-facade-cold-credit.js'),
    'utf8'
  );
  const start = source.indexOf('  for (const file of Object.keys(require.cache)) {');
  const end = source.indexOf("  if (phase === 'setup') handoff.write", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const electron = { app: {} };
  const load = (name) => {
    expect(name).toBe('electron');
    return electron;
  };
  load.cache = Object.fromEntries(
    Object.entries(cache).map(([name, entry]) => [
      name,
      {
        ...entry,
        exports: entry.exports === 'runtime' ? electron : entry.exports,
      },
    ])
  );
  vm.runInNewContext(source.slice(start, end), {
    require: load,
    path,
    root,
    fs,
    sources,
    assert: require('assert/strict'),
  });
}
function electronCache() {
  return Object.fromEntries(
    ['electron', 'electron/common', 'electron/main'].map((name) => [
      name,
      { id: 'electron', filename: name, loaded: true, exports: 'runtime' },
    ])
  );
}
test('exact observed Electron main virtual aliases pass alongside inventoried project imports', () => {
  inventoryCacheCheck({
    ...electronCache(),
    [require('path').join(process.cwd(), 'src/main/owned.js')]: {},
    [require('path').join(process.cwd(), 'node_modules/dependency/index.js')]: {},
  });
});
test.each(['original-fs', 'electron/renderer', 'electron/utility', 'src/main/owned.js', 'unknown'])(
  'unknown relative cache key %s is never silently skipped',
  (key) => {
    expect(() => inventoryCacheCheck({ ...electronCache(), [key]: {} })).toThrow();
  }
);
test.each(['id', 'filename', 'loaded', 'exports'])(
  'known runtime alias with wrong %s is refused',
  (field) => {
    const cache = electronCache();
    cache['electron/main'][field] = field === 'loaded' ? false : 'wrong';
    expect(() => inventoryCacheCheck(cache)).toThrow();
  }
);
test.each(['electron', 'src/main/missing.js', 'scripts/other.js'])(
  'real uncovered project file %s remains refused',
  (file) => {
    expect(() =>
      inventoryCacheCheck({ ...electronCache(), [require('path').resolve(file)]: {} })
    ).toThrow();
  }
);

test('real repository shadow file cannot be exempted as an Electron virtual alias', () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-cold-runtime-shadow-'));
  fs.writeFileSync(path.join(root, 'electron'), 'real source file must not be skipped');
  expect(() => inventoryCacheCheck(electronCache(), {}, root)).toThrow();
});
