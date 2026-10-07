const fs = require('fs');
const vm = require('vm');
const filename = require.resolve('./railgun-kernel-entry');
const source = fs.readFileSync(filename, 'utf8');
test('fixed entry installs actual package guards before host imports and initializes synchronously', () => {
  const order = [],
    context = { getPrivacyContext() {}, createPrivacyScope() {} },
    artifacts = { createPrivacyArtifactLoader() {} };
  let initialized = false;
  const initialize = jest.fn((bindings) => {
    order.push('initialize');
    expect(bindings.context.getPrivacyContext).toBe(context.getPrivacyContext);
    expect(bindings.context.createPrivacyScope).toBe(context.createPrivacyScope);
    expect(bindings.artifacts.createPrivacyArtifactLoader).toBe(
      artifacts.createPrivacyArtifactLoader
    );
    expect(Object.keys(bindings).sort()).toEqual(['artifacts', 'context']);
    initialized = true;
  });
  const install = jest.fn((...args) => {
    expect(args).toEqual([]);
    order.push('guards');
    return { initialize };
  });
  const requireFixed = jest.fn((name) => {
    order.push(name);
    if (name === '@freedom/railgun-kohaku-adapter/host/bootstrap')
      return { installRailgunExecutionBootstrap: install };
    expect(order).toContain('guards');
    if (name === '../networks/privacy-context') return context;
    if (name === './privacy-artifacts') return artifacts;
    throw Error('unexpected host import');
  });
  vm.runInNewContext(source, { require: requireFixed }, { filename });
  expect(initialized).toBe(true);
  expect(install).toHaveBeenCalledTimes(1);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(order).toEqual([
    '@freedom/railgun-kohaku-adapter/host/bootstrap',
    'guards',
    '../networks/privacy-context',
    './privacy-artifacts',
    'initialize',
  ]);
});
test('bootstrap preemption is fatal before any host module loads', () => {
  const error = Error('preempted'),
    read = jest.fn((name) => {
      expect(name).toBe('@freedom/railgun-kohaku-adapter/host/bootstrap');
      return {
        installRailgunExecutionBootstrap() {
          throw error;
        },
      };
    });
  expect(() => vm.runInNewContext(source, { require: read }, { filename })).toThrow(error);
  expect(read).toHaveBeenCalledTimes(1);
});
