const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cases = [
  [
    'railgun-kernel-entry.js',
    '@freedom/railgun-kohaku-adapter/host/bootstrap',
    'installRailgunExecutionBootstrap',
    true,
  ],
  [
    'railgun-owner-storage-entry.js',
    '@freedom/railgun-kohaku-adapter/host/owner-worker-bootstrap',
    'installRailgunStorageWorkerBootstrap',
    false,
  ],
];
test.each(cases)(
  '%s initializes the fixed realm before host imports and never accepts worker data',
  (filename, packagePath, installName, artifacts) => {
    const calls = [],
      initialize = jest.fn((value) => calls.push(['initialize', value]));
    const context = { getPrivacyContext() {}, createPrivacyScope() {} },
      loader = () => {};
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    vm.runInNewContext(source, {
      require(name) {
        calls.push(['require', name]);
        if (name === packagePath)
          return {
            [installName]() {
              calls.push(['install']);
              return { initialize };
            },
          };
        if (name === '../networks/privacy-context') return context;
        if (artifacts && name === './privacy-artifacts')
          return { createPrivacyArtifactLoader: loader };
        throw new Error('Unexpected import');
      },
    });
    expect(calls.slice(0, 3)).toEqual([
      ['require', packagePath],
      ['install'],
      ['require', '../networks/privacy-context'],
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize.mock.calls[0]).toEqual([
      artifacts ? { context, artifacts: { createPrivacyArtifactLoader: loader } } : { context },
    ]);
  }
);
test.each(cases)(
  '%s stops before host access if guard/realm installation fails',
  (filename, packagePath, installName) => {
    const calls = [],
      error = new Error('realm or guard refusal');
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    expect(() =>
      vm.runInNewContext(source, {
        require(name) {
          calls.push(name);
          if (name === packagePath)
            return {
              [installName]() {
                throw error;
              },
            };
          throw new Error('Unexpected host access');
        },
      })
    ).toThrow(error);
    expect(calls).toEqual([packagePath]);
  }
);
