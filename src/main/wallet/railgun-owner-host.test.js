const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'railgun-owner-host.js'), 'utf8');
const shape = {
  '../networks/privacy-context': ['getPrivacyContext', 'createPrivacyScope'],
  './privacy-artifacts': ['createPrivacyArtifactLoader'],
  '../profile-resolver': ['getActiveProfile'],
  './privacy-session': ['openPrivacySession'],
  './privacy-storage': ['createPrivacyStorage', 'getPrivacyStoragePath'],
  '../networks/private-rpc': [
    'assertPrivateRpcDestination',
    'createPrivateRpc',
    'createPrivateRpcDestinationConstraint',
    'createPrivateRpcReadBudget',
    'getPrivateRpcDestination',
    'getPrivateRpcDestinationDetails',
    'getPrivateRpcReadBudgetOutcome',
  ],
  '../networks/wallet-tor-transport': ['createWalletTorTransport'],
  '../settings-store': ['isWalletTorExperimentAvailable'],
  '../tor-manager': ['getWalletSocksEndpoint'],
  './signers': ['getSigner'],
  './private-transaction-intent': ['transactionIntent', 'validIntent'],
  './private-transaction-network': [
    'assertPrivateTransactionNetworkDestination',
    'getPrivateTransactionNetwork',
    'getPrivateTransactionNetworkDestination',
  ],
  './private-submission-journal': ['getPrivateSubmissionJournal'],
  './privacy-journal-retention': ['validArchive'],
  './transaction-service': ['signAndSendTransaction'],
};
const refused = expect.objectContaining({ code: 'RAILGUN_OWNER_COMPOSITION_REFUSED' });
function load(options = {}) {
  const imports = [],
    modules = {};
  for (const [name, fields] of Object.entries(shape)) {
    const module = {};
    for (const field of fields)
      module[field] = jest.fn(function (...args) {
        return { receiver: this, args };
      });
    Object.defineProperty(module, 'unrelatedSecret', {
      get() {
        throw new Error('Must not inspect');
      },
    });
    modules[name] = module;
  }
  const platform = Object.freeze({ applicationLifetime: jest.fn() }),
    credentials = Object.freeze({ currentSession: jest.fn(), withMaterial: jest.fn() }),
    submitter = Object.freeze({ readMetadata: jest.fn() });
  const factories = {
    './railgun-platform-host': { createRailgunPlatformHost: jest.fn(() => platform) },
    '../identity/railgun-credential-host': {
      createRailgunCredentialHost: jest.fn(() => credentials),
    },
    '../identity/railgun-submitter-host': { createRailgunSubmitterHost: jest.fn(() => submitter) },
  };
  const initialize = options.initialize || jest.fn(),
    module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    process: { type: options.realm },
    require(name) {
      imports.push(name);
      if (name === 'worker_threads') return { isMainThread: options.mainThread !== false };
      if (name === 'util') return require('util');
      if (name === '@freedom/railgun-kohaku-adapter/host/owner')
        return { initializeRailgunOwnerHost: initialize };
      if (factories[name]) return factories[name];
      if (modules[name]) return modules[name];
      throw new Error('Unexpected import');
    },
  });
  return {
    start: module.exports.initializeRailgunOwner,
    imports,
    modules,
    initialize,
    factories,
    platform,
    credentials,
    submitter,
  };
}
test('captures fixed host families once with platform startup first and no returned authority', () => {
  const m = load();
  expect(m.imports).toEqual(['worker_threads', 'util']);
  expect(m.start()).toBeUndefined();
  expect(m.imports[2]).toBe('./railgun-platform-host');
  expect(m.imports.at(-1)).toBe('@freedom/railgun-kohaku-adapter/host/owner');
  expect(m.initialize).toHaveBeenCalledTimes(1);
  const binding = m.initialize.mock.calls[0][0];
  expect(Object.keys(binding)).toEqual([
    'context',
    'artifacts',
    'credentials',
    'platform',
    'submitter',
    'profiles',
    'sessions',
    'storage',
    'rpc',
    'transport',
    'settings',
    'tor',
    'signers',
    'transactionIntent',
    'transactionNetwork',
    'submissionJournal',
    'journalRetention',
    'transactions',
  ]);
  expect(Object.isFrozen(binding)).toBe(true);
  for (const family of Object.values(binding)) expect(Object.isFrozen(family)).toBe(true);
  expect(binding.platform).toBe(m.platform);
  expect(binding.credentials).toBe(m.credentials);
  expect(binding.submitter).toBe(m.submitter);
  for (const entry of Object.values(m.factories))
    expect(Object.values(entry)[0].mock.calls).toEqual([[]]);
  expect(() => m.start()).toThrow(refused);
  expect(m.initialize).toHaveBeenCalledTimes(1);
});
test('host calls retain original receiver, arguments, native promise and thrown error', () => {
  const m = load(),
    original = m.modules['../networks/private-rpc'].createPrivateRpc;
  const promise = Promise.resolve('public synthetic');
  original.mockReturnValue(promise);
  m.start();
  const port = m.initialize.mock.calls[0][0].rpc;
  m.modules['../networks/private-rpc'].createPrivateRpc = () => {
    throw new Error('replacement');
  };
  const handle = {},
    options = {};
  expect(port.createPrivateRpc(handle, options)).toBe(promise);
  expect(original.mock.calls).toEqual([[handle, options]]);
  expect(original.mock.contexts).toEqual([m.modules['../networks/private-rpc']]);
  const error = new Error('original');
  original.mockImplementation(() => {
    throw error;
  });
  expect(() => port.createPrivateRpc()).toThrow(error);
});
test.each([{ realm: 'renderer' }, { realm: 'utility' }, { mainThread: false }])(
  'wrong realm cannot capture host services: %p',
  (options) => {
    const m = load(options);
    expect(() => m.start()).toThrow(refused);
    expect(m.imports).toEqual(['worker_threads', 'util']);
  }
);
test('an injected binding is rejected before host or package access', () => {
  const m = load();
  expect(() => m.start({ credentials: {} })).toThrow(refused);
  expect(m.imports).toEqual(['worker_threads', 'util']);
});
test('failed package initialization cannot be retried through this composition', () => {
  const error = new Error('preempted'),
    initialize = jest.fn(() => {
      throw error;
    }),
    m = load({ initialize });
  expect(() => m.start()).toThrow(error);
  expect(() => m.start()).toThrow(refused);
  expect(initialize).toHaveBeenCalledTimes(1);
});
test('missing or accessor host methods refuse without invoking the accessor', () => {
  const m = load(),
    getter = jest.fn();
  Object.defineProperty(m.modules['./signers'], 'getSigner', { get: getter });
  expect(() => m.start()).toThrow(refused);
  expect(getter).not.toHaveBeenCalled();
  expect(m.initialize).not.toHaveBeenCalled();
  expect(() => m.start()).toThrow(refused);
});
function nodes(tree, visit) {
  if (!tree || typeof tree !== 'object') return;
  if (typeof tree.type === 'string') visit(tree);
  for (const value of Object.values(tree)) {
    if (Array.isArray(value)) value.forEach((child) => nodes(child, visit));
    else if (value && typeof value === 'object') nodes(value, visit);
  }
}
function syntax(filename) {
  return require('acorn').parse(fs.readFileSync(filename, 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
  });
}
test('fixed host method names resolve to real plain function exports without loading services', () => {
  for (const [name, names] of Object.entries(shape)) {
    const tree = syntax(path.resolve(__dirname, name + '.js'));
    const functions = new Set(),
      exports = [];
    nodes(tree, (node) => {
      if (node.type === 'FunctionDeclaration') functions.add(node.id.name);
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.init?.type)
      )
        functions.add(node.id.name);
      if (
        node.type === 'AssignmentExpression' &&
        node.left.type === 'MemberExpression' &&
        !node.left.computed &&
        node.left.object.name === 'module' &&
        node.left.property.name === 'exports'
      )
        exports.push(node.right);
    });
    expect(exports).toHaveLength(1);
    expect(exports[0].type).toBe('ObjectExpression');
    for (const method of names) {
      const property = exports[0].properties.find(
        (entry) => !entry.computed && entry.key.name === method
      );
      expect(property).toBeDefined();
      expect(property.kind).toBe('init');
      expect(
        property.value.type === 'FunctionExpression' ||
          property.value.type === 'ArrowFunctionExpression' ||
          (property.value.type === 'Identifier' && functions.has(property.value.name))
      ).toBe(true);
    }
  }
});
test('the staged composition and its authority hosts remain unreachable from production callers', () => {
  const root = path.resolve(__dirname, '..');
  const targets = new Set([
    path.join(__dirname, 'railgun-owner-host.js'),
    path.join(__dirname, 'railgun-platform-host.js'),
    path.resolve(__dirname, '../identity/railgun-credential-host.js'),
    path.resolve(__dirname, '../identity/railgun-submitter-host.js'),
  ]);
  const allowed = path.join(__dirname, 'railgun-owner-host.js');
  const violations = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(filename);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.js') &&
        !entry.name.endsWith('.test.js') &&
        !entry.name.endsWith('.fixture.js')
      ) {
        nodes(syntax(filename), (node) => {
          if (
            node.type !== 'CallExpression' ||
            node.callee.name !== 'require' ||
            node.arguments.length !== 1 ||
            typeof node.arguments[0].value !== 'string'
          )
            return;
          const specifier = node.arguments[0].value;
          if (!specifier.startsWith('.')) return;
          const target = path.resolve(
            path.dirname(filename),
            specifier + (specifier.endsWith('.js') ? '' : '.js')
          );
          if (targets.has(target) && filename !== allowed)
            violations.push(path.relative(root, filename));
        });
      }
    }
  }
  scan(root);
  expect(violations).toEqual([]);
});
