const { ENV_VAR, insideAsar, providerIdentityOverrides } = require('./e2e-provider-identities');
const { endpointIdentity, distinctEndpoints } = require('./endpoint-identity');

// The Safe E2E's anvil fork and the forwarder in front of it: two loopback
// URLs, so one provider unless the seam names them apart.
const ANVIL = 'http://127.0.0.1:18847';
const FORWARDER = 'http://127.0.0.1:18849';
const LABELS = JSON.stringify({ [ANVIL]: 'e2e-anvil', [FORWARDER]: 'e2e-anvil-forwarder' });

const launch = (overrides) =>
  providerIdentityOverrides({
    isPackaged: false,
    fromAsar: false,
    env: { [ENV_VAR]: LABELS },
    ...overrides,
  });

describe('the E2E provider-identity seam (test-only)', () => {
  test('an unpackaged launch with the variable names two loopback URLs as two providers', () => {
    const overrides = launch();
    expect(endpointIdentity(ANVIL, undefined, overrides)).toBe('e2e:e2e-anvil');
    expect(endpointIdentity(`${FORWARDER}/`, undefined, overrides)).toBe('e2e:e2e-anvil-forwarder');
    expect(distinctEndpoints([ANVIL, FORWARDER], undefined, overrides)).toEqual([ANVIL, FORWARDER]);
    // A URL it doesn't name keeps its own identity.
    expect(endpointIdentity('http://localhost:18847', undefined, overrides)).toBe('loopback');
  });

  test.each([[true], [undefined], [null], ['false'], [0]])(
    'a packaged build (isPackaged %p) ignores it',
    (isPackaged) => {
      expect(launch({ isPackaged })).toBeNull();
    }
  );

  test.each([[true], [undefined]])(
    'source inside an asar archive (%p) ignores it, even if Electron says unpackaged',
    (fromAsar) => {
      expect(launch({ fromAsar })).toBeNull();
    }
  );

  test("a packaged build's source is inside an asar archive; the source tree isn't", () => {
    expect(insideAsar('/opt/Freedom/resources/app.asar/src/main/networks')).toBe(true);
    expect(insideAsar('C:\\Freedom\\resources\\app.asar\\src\\main\\networks')).toBe(true);
    expect(insideAsar('/Applications/Freedom.app/Contents/Resources/app.asar')).toBe(true);
    expect(insideAsar(__dirname)).toBe(false);
    expect(insideAsar('/home/dev/freedom-browser/src/main/networks')).toBe(false);
    expect(insideAsar('/home/dev/my.asar.notes/src')).toBe(false);
  });

  test.each([
    ['absent', {}],
    ['empty', { [ENV_VAR]: '' }],
    ['blank', { [ENV_VAR]: '  ' }],
  ])('without the variable (%s) it is off', (_name, env) => {
    expect(launch({ env })).toBeNull();
    expect(launch({ env: undefined })).toBeNull();
  });

  test.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"label"'],
    ['no string labels', JSON.stringify({ [ANVIL]: 7, [FORWARDER]: '' })],
  ])('a malformed value (%s) is ignored', (_name, value) => {
    expect(launch({ env: { [ENV_VAR]: value } })).toBeNull();
  });

  describe('as the router and chain-config read it: the launch itself', () => {
    const saved = process.env[ENV_VAR];
    afterEach(() => {
      if (saved === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = saved;
    });

    // distinctEndpoints([ANVIL, FORWARDER]) from a fresh endpoint-identity
    // under an Electron whose app is `app`, or under no Electron app at all
    // (Jest's own `require('electron')`). The seam reads Electron and the
    // logger on its first call, so that call runs inside isolateModules too:
    // outside it, Jest would cache the first test's mocks for the rest.
    function freshDistinct(app, value) {
      if (value === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = value;
      let distinct;
      let warn;
      jest.isolateModules(() => {
        // doMock outlives isolateModules, so the no-app case undoes it.
        if (app) jest.doMock('electron', () => ({ app }));
        else jest.dontMock('electron');
        warn = jest.fn();
        jest.doMock('../logger', () => ({ warn }));
        distinct = require('./endpoint-identity').distinctEndpoints([ANVIL, FORWARDER]);
      });
      return { distinct, warn };
    }

    test('unpackaged, with the variable: two providers, and the launch logs it', () => {
      const { distinct, warn } = freshDistinct({ isPackaged: false }, LABELS);
      expect(distinct).toEqual([ANVIL, FORWARDER]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(ENV_VAR));
    });

    test.each([
      ['packaged, with the variable', { isPackaged: true }, LABELS],
      ['unpackaged, without the variable', { isPackaged: false }, undefined],
      ['no Electron app, with the variable', null, LABELS],
    ])('%s: one provider', (_name, app, value) => {
      const { distinct, warn } = freshDistinct(app, value);
      expect(distinct).toEqual([ANVIL]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
