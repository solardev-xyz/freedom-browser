/**
 * The network policy freedom-radicled is spawned under (freedom-core design
 * 0008, "Modes" and "The setting"; plan B18): `direct` unless the profile
 * routes Radicle through Tor; then `socks5` through the endpoint
 * tor-manager offers Radicle, or none until it offers one.
 */

const {
  RadicleNetwork,
  routesRadicleThroughTor,
  policySource,
  networkArg,
  reportsPolicy,
} = require('./radicle-network');
const { fakeTorEndpoint: fakeTor } = require('../../../test/helpers/fake-tor-endpoint');

/** tor-manager's Radicle API alone, recording what is asked of it. */
function radicleOnly(tor, asked = []) {
  return {
    getRadicleSocksEndpoint: () => {
      asked.push('endpoint');
      return tor.getRadicleSocksEndpoint();
    },
    onRadicleSocksEndpointChange: (listener) => {
      asked.push('watch');
      return tor.onRadicleSocksEndpointChange(listener);
    },
  };
}

describe('the setting', () => {
  test("only routeRadicleThroughTor, exactly true, routes Radicle through Tor; IPFS's is apart", () => {
    expect(routesRadicleThroughTor({ routeRadicleThroughTor: true })).toBe(true);
    for (const settings of [
      {},
      null,
      undefined,
      { routeRadicleThroughTor: false },
      { routeRadicleThroughTor: 'true' },
      { routeRadicleThroughTor: 1 },
      { routeIpfsThroughTor: true },
    ]) {
      expect(routesRadicleThroughTor(settings)).toBe(false);
    }
  });
});

describe('RadicleNetwork', () => {
  test('is direct unless the profile routes Radicle through Tor, by default too', () => {
    const tor = fakeTor();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    expect(new RadicleNetwork().current()).toEqual({ mode: 'direct' });
    expect(new RadicleNetwork({ tor: radicleOnly(tor) }).current()).toEqual({ mode: 'direct' });
    expect(
      new RadicleNetwork({ routesThroughTor: () => false, tor: radicleOnly(tor) }).current()
    ).toEqual({ mode: 'direct' });
  });

  test('through Tor, it is socks5 to the endpoint offered Radicle, and none while Tor offers none', () => {
    const tor = fakeTor();
    const network = new RadicleNetwork({ routesThroughTor: () => true, tor: radicleOnly(tor) });
    expect(network.current()).toBeNull();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    expect(network.current()).toEqual({ mode: 'socks5', ip: '127.0.0.1', port: 9150 });
    tor.offer({ ip: '::1', port: 9050 });
    expect(network.current()).toEqual({ mode: 'socks5', ip: '::1', port: 9050 });
    tor.offer(null);
    expect(network.current()).toBeNull();
  });

  test("subscribers hear Tor's changes and the setting's, each on its own, until they stop", () => {
    const tor = fakeTor();
    let routes = false;
    const log = { error: jest.fn() };
    const network = new RadicleNetwork({
      routesThroughTor: () => routes,
      tor: radicleOnly(tor),
      log,
    });
    const heard = [];
    const stop = network.subscribe((policy) => heard.push(policy));
    network.subscribe(() => {
      throw new Error('a failing subscriber');
    });

    // Direct: Tor's change is no change of policy, and unheard.
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    expect(heard).toEqual([]);
    routes = true;
    network.changed();
    expect(tor.listeners.size).toBe(1);
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    expect(heard).toEqual([
      { mode: 'socks5', ip: '127.0.0.1', port: 9150 },
      { mode: 'socks5', ip: '127.0.0.1', port: 9151 },
    ]);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      '[Radicle] network policy listener failed:',
      expect.any(Error)
    );

    stop();
    tor.offer(null);
    expect(heard).toHaveLength(2);
  });

  test('Tor is watched only while someone listens and the profile routes Radicle through Tor', () => {
    let routes = false;
    const asked = [];
    const tor = fakeTor();
    const network = new RadicleNetwork({
      routesThroughTor: () => routes,
      tor: radicleOnly(tor, asked),
    });
    // Nobody listens: nothing is watched, even through Tor.
    routes = true;
    network.changed();
    expect(tor.listeners.size).toBe(0);
    routes = false;
    asked.length = 0;

    const heard = [];
    const stop = network.subscribe((policy) => heard.push(policy));
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    network.changed();
    // A direct profile never asks tor-manager anything.
    expect(asked).toEqual([]);
    expect(heard).toEqual([{ mode: 'direct' }]);

    routes = true;
    network.changed();
    expect(tor.listeners.size).toBe(1);
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    expect(heard.map((policy) => policy.port ?? policy.mode)).toEqual(['direct', 9150, 9151]);

    routes = false;
    network.changed();
    expect(tor.listeners.size).toBe(0);
    tor.offer({ ip: '127.0.0.1', port: 9152 });
    expect(heard.at(-1)).toEqual({ mode: 'direct' });
    stop();
    expect(tor.listeners.size).toBe(0);
  });
});

describe('policySource', () => {
  test('a source is itself; a fixed policy, or none, is one that never changes', () => {
    const network = new RadicleNetwork();
    expect(policySource(network)).toBe(network);
    const socks = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
    const fixed = policySource(socks);
    expect(fixed.current()).toEqual(socks);
    // A copy, frozen: the caller's object changing later changes nothing.
    socks.port = 1;
    expect(fixed.current().port).toBe(9150);
    expect(Object.isFrozen(fixed.current())).toBe(true);
    const listener = jest.fn();
    expect(typeof fixed.subscribe(listener)).toBe('function');
    expect(listener).not.toHaveBeenCalled();
    expect(policySource(undefined).current()).toEqual({ mode: 'direct' });
    expect(policySource(null).current()).toEqual({ mode: 'direct' });
  });
});

describe('the argument and the report', () => {
  test('the policy is `--network` as the service takes it, and hello must report it', () => {
    expect(networkArg({ mode: 'direct' })).toBe('direct');
    expect(networkArg({ mode: 'socks5', ip: '127.0.0.1', port: 9150 })).toBe(
      'socks5:127.0.0.1:9150'
    );
    expect(networkArg({ mode: 'socks5', ip: '::1', port: 9150 })).toBe('socks5:[::1]:9150');
    expect(() => networkArg(null)).toThrow('no network policy');
    const socks = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
    expect(reportsPolicy({ ...socks }, socks)).toBe(true);
    expect(reportsPolicy({ mode: 'direct' }, socks)).toBe(false);
    expect(reportsPolicy({ ...socks, port: 9151 }, socks)).toBe(false);
  });
});
