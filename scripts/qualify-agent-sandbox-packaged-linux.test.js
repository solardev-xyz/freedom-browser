'use strict';

const { qualificationModeEnvironment } = require('./qualify-agent-sandbox-packaged-linux');

describe('packaged Linux qualification mode', () => {
  test('keeps ordinary qualification non-destructive', () => {
    expect(qualificationModeEnvironment({})).toEqual({});
  });

  test('forwards the doubly gated destructive mode', () => {
    expect(
      qualificationModeEnvironment({
        FREEDOM_SANDBOX_DESTRUCTIVE: '1',
        FREEDOM_SANDBOX_VM_ONLY: '1',
      })
    ).toEqual({
      FREEDOM_SANDBOX_DESTRUCTIVE: '1',
      FREEDOM_SANDBOX_VM_ONLY: '1',
    });
  });

  test.each([[{ FREEDOM_SANDBOX_DESTRUCTIVE: '1' }], [{ FREEDOM_SANDBOX_VM_ONLY: '1' }]])(
    'rejects a partially enabled destructive mode',
    (environment) => {
      expect(() => qualificationModeEnvironment(environment)).toThrow(
        'requires both FREEDOM_SANDBOX_DESTRUCTIVE=1 and FREEDOM_SANDBOX_VM_ONLY=1'
      );
    }
  );
});
