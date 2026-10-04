// Wrapper delegation tests use a controlled registry. Genuine plugin issuance,
// controller lifetimes, signing and transport are qualified by their own suites.
let mockInstances;
const mockAssert = jest.fn(),
  mockSubmit = jest.fn();
jest.mock('./railgun-kohaku-plugin', () => ({
  assertRailgunKohakuPublicPlugin: (...args) => mockAssert(...args),
  submitRailgunKohakuPublicOperation: (...args) => mockSubmit(...args),
}));
const { createRailgunKohakuPublicSubmitter } = require('./railgun-kohaku-public-submitter');
const unavailable = () => Error('Railgun Kohaku operation unavailable');
function registered(mode = 'public', submit = jest.fn()) {
  const plugin = Object.freeze({ prepareShield() {} });
  mockInstances.set(plugin, { mode, submit, live: true });
  return plugin;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockInstances = new WeakMap();
  mockAssert.mockImplementation((plugin) => {
    const entry = mockInstances.get(plugin);
    if (!entry || entry.mode !== 'public' || !entry.live) throw unavailable();
  });
  mockSubmit.mockImplementation((plugin, operation) => {
    mockAssert(plugin);
    return mockInstances.get(plugin).submit(operation);
  });
});
test('frozen submit-only interface authenticates construction without submitting', () => {
  const plugin = registered(),
    submitter = createRailgunKohakuPublicSubmitter(plugin);
  expect(mockAssert.mock.calls).toEqual([[plugin]]);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(Reflect.ownKeys(submitter)).toEqual(['submit']);
  expect(Object.isFrozen(submitter)).toBe(true);
  expect(Reflect.set(submitter, 'submit', () => {})).toBe(false);
  expect(submitter.broadcast).toBeUndefined();
});
test.each([null, undefined, {}, { prepareShield() {} }])(
  'unregistered plugin refuses at construction: %#',
  (plugin) => {
    expect(() => createRailgunKohakuPublicSubmitter(plugin)).toThrow(
      'Railgun Kohaku operation unavailable'
    );
    expect(mockSubmit).not.toHaveBeenCalled();
  }
);
test.each(['private', 'read'])('registered %s mode cannot construct a public submitter', (mode) => {
  expect(() => createRailgunKohakuPublicSubmitter(registered(mode))).toThrow(
    'Railgun Kohaku operation unavailable'
  );
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('copying the public plugin shape cannot borrow registered identity', () => {
  const plugin = registered();
  for (const foreign of [{ ...plugin }, Object.create(plugin)])
    expect(() => createRailgunKohakuPublicSubmitter(foreign)).toThrow(
      'Railgun Kohaku operation unavailable'
    );
  expect(mockSubmit).not.toHaveBeenCalled();
});
test.each(['submitted', 'unknown', 'recovery-required'])(
  'preserves the exact %s outcome and original promise from the owning plugin',
  async (status) => {
    const result = Object.freeze({ status }),
      pending = Promise.resolve(result),
      operation = Object.freeze({ __type: 'publicOperation' }),
      submit = jest.fn(() => pending),
      plugin = registered('public', submit),
      submitter = createRailgunKohakuPublicSubmitter(plugin);
    const actual = submitter.submit(operation);
    expect(actual).toBe(pending);
    expect(await actual).toBe(result);
    expect(mockSubmit.mock.calls).toEqual([[plugin, operation]]);
    expect(submit.mock.calls).toEqual([[operation]]);
  }
);
test('cannot substitute the bound plugin through this or inject extra transport options', async () => {
  const operation = Object.freeze({ __type: 'publicOperation' }),
    result = Object.freeze({ status: 'submitted' }),
    submit = jest.fn(async () => result),
    plugin = registered('public', submit),
    foreign = registered(),
    transport = jest.fn();
  const options = Object.defineProperty({}, 'transport', { get: transport });
  const submitter = createRailgunKohakuPublicSubmitter(plugin, options);
  expect(await submitter.submit.call(foreign, operation, options)).toBe(result);
  expect(mockSubmit.mock.calls).toEqual([[plugin, operation]]);
  expect(transport).not.toHaveBeenCalled();
  expect(mockInstances.get(foreign).submit).not.toHaveBeenCalled();
});
test('a rejected operation preserves the exact error rather than manufacturing success', async () => {
  const error = Object.assign(Error('bounded refusal'), { code: 'RAILGUN_KOHAKU_REFUSED' }),
    operation = Object.freeze({ __type: 'publicOperation' }),
    plugin = registered(
      'public',
      jest.fn(() => Promise.reject(error))
    ),
    submitter = createRailgunKohakuPublicSubmitter(plugin);
  await expect(submitter.submit(operation)).rejects.toBe(error);
  expect(mockSubmit.mock.calls).toEqual([[plugin, operation]]);
});
test('foreign operation refusal remains the owning plugin controller decision', async () => {
  const own = Object.freeze({ __type: 'publicOperation' }),
    foreign = Object.freeze({ __type: 'publicOperation' }),
    error = unavailable(),
    plugin = registered('public', async (operation) => {
      if (operation !== own) throw error;
      return 'acknowledged';
    }),
    submitter = createRailgunKohakuPublicSubmitter(plugin);
  await expect(submitter.submit(foreign)).rejects.toBe(error);
  expect(mockSubmit.mock.calls[0]).toEqual([plugin, foreign]);
  expect(await submitter.submit(own)).toBe('acknowledged');
});
test('construction does not cache authority after the plugin registry revokes its owner', () => {
  const plugin = registered(),
    submitter = createRailgunKohakuPublicSubmitter(plugin),
    operation = Object.freeze({ __type: 'publicOperation' });
  mockInstances.get(plugin).live = false;
  expect(() => submitter.submit(operation)).toThrow('Railgun Kohaku operation unavailable');
  expect(mockSubmit.mock.calls).toEqual([[plugin, operation]]);
  expect(mockInstances.get(plugin).submit).not.toHaveBeenCalled();
});
test('synchronous controller refusal is preserved unchanged', () => {
  const error = unavailable(),
    plugin = registered('public', () => {
      throw error;
    });
  const submitter = createRailgunKohakuPublicSubmitter(plugin);
  try {
    submitter.submit({});
    throw Error('unexpected success');
  } catch (actual) {
    expect(actual).toBe(error);
  }
});
