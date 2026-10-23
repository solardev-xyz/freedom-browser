/**
 * The network policy IPFS starts under (freedom-core design 0007, step 8,
 * B2): `direct` unless the profile routes IPFS through Tor; then `socks5`
 * through the endpoint tor-manager offers, or none until it offers one.
 */

const {
  IpfsNetwork,
  samePolicy,
  supersedes,
  networkArg,
  canonicalIp,
  reportsPolicy,
  DIRECT,
} = require('./ipfs-network');
const { fakeTorEndpoint: fakeTor } = require('../../../test/helpers/fake-tor-endpoint');

describe('IpfsNetwork', () => {
  test('is direct unless the profile routes IPFS through Tor', () => {
    const tor = fakeTor();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    expect(new IpfsNetwork({ tor }).current()).toEqual({ mode: 'direct' });
    expect(new IpfsNetwork({ routesThroughTor: () => false, tor }).current()).toEqual({
      mode: 'direct',
    });
    expect(DIRECT.current()).toEqual({ mode: 'direct' });
  });

  test("through Tor, it is socks5 to Tor's endpoint, and none while Tor offers none", () => {
    const tor = fakeTor();
    const network = new IpfsNetwork({ routesThroughTor: () => true, tor });
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
    const network = new IpfsNetwork({ routesThroughTor: () => routes, tor, log });
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

    stop();
    tor.offer(null);
    expect(heard).toHaveLength(2);
  });

  test("the last subscriber's stop stops watching Tor", () => {
    const tor = fakeTor();
    const network = new IpfsNetwork({ routesThroughTor: () => true, tor });
    const one = network.subscribe(() => {});
    const two = network.subscribe(() => {});
    expect(tor.listeners.size).toBe(1);
    one();
    expect(tor.listeners.size).toBe(1);
    two();
    expect(tor.listeners.size).toBe(0);
    // Watching again on the next subscriber.
    network.subscribe(() => {});
    expect(tor.listeners.size).toBe(1);
  });

  test('Tor is watched only while the profile routes IPFS through Tor, so a direct one never asks it', () => {
    let routes = false;
    const asked = [];
    const tor = fakeTor();
    const counted = {
      getIpfsSocksEndpoint: () => {
        asked.push('endpoint');
        return tor.getIpfsSocksEndpoint();
      },
      onIpfsSocksEndpointChange: (listener) => {
        asked.push('watch');
        return tor.onIpfsSocksEndpointChange(listener);
      },
    };
    const network = new IpfsNetwork({ routesThroughTor: () => routes, tor: counted });
    const heard = [];
    const stop = network.subscribe((policy) => heard.push(policy));
    expect(network.current()).toEqual({ mode: 'direct' });
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    network.changed();
    expect(asked).toEqual([]);
    expect(tor.listeners.size).toBe(0);
    expect(heard).toEqual([{ mode: 'direct' }]);

    // The setting turns on: watched, and Tor's next change is heard.
    routes = true;
    network.changed();
    expect(tor.listeners.size).toBe(1);
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    expect(heard.map((policy) => policy.port ?? policy.mode)).toEqual(['direct', 9150, 9151]);

    // And off: unwatched, and Tor's changes go unheard.
    routes = false;
    network.changed();
    expect(tor.listeners.size).toBe(0);
    tor.offer({ ip: '127.0.0.1', port: 9152 });
    expect(heard).toHaveLength(4);
    expect(heard.at(-1)).toEqual({ mode: 'direct' });
    stop();
  });

  test('two policies are the same by mode and endpoint', () => {
    const socks = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
    expect(samePolicy({ mode: 'direct' }, { mode: 'direct' })).toBe(true);
    expect(samePolicy(socks, { ...socks })).toBe(true);
    expect(samePolicy(socks, { ...socks, port: 9151 })).toBe(false);
    expect(samePolicy(socks, { ...socks, ip: '::1' })).toBe(false);
    expect(samePolicy(socks, { mode: 'direct' })).toBe(false);
    expect(samePolicy(null, null)).toBe(true);
    expect(samePolicy(null, { mode: 'direct' })).toBe(false);
  });
});

describe('the policy at spawn and in hello (freedom-core design 0010)', () => {
  test('`--network` takes it as `direct` or `socks5:<ip>:<port>`, IPv6 in brackets', () => {
    expect(networkArg({ mode: 'direct' })).toBe('direct');
    expect(networkArg({ mode: 'socks5', ip: '127.0.0.1', port: 9150 })).toBe(
      'socks5:127.0.0.1:9150'
    );
    expect(networkArg({ mode: 'socks5', ip: 'fd00::5', port: 9050 })).toBe('socks5:[fd00::5]:9050');
    expect(() => networkArg(null)).toThrow('no network policy');
  });

  test('an address is compared as the service writes it back', () => {
    expect(canonicalIp('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalIp('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(canonicalIp('FD00:0::5')).toBe('fd00::5');
    // RFC 5952: the first of two equal runs is compressed.
    expect(canonicalIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    // An IPv4-mapped address is the IPv4 address it maps.
    expect(canonicalIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalIp('::ffff:7f00:1')).toBe('127.0.0.1');
    for (const refused of ['localhost', '127.1', '', null, 7]) {
      expect(canonicalIp(refused)).toBeNull();
    }
  });

  test("hello's network must be the policy main passed", () => {
    const socks = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
    expect(reportsPolicy({ mode: 'direct' }, { mode: 'direct' })).toBe(true);
    expect(reportsPolicy(socks, { ...socks, ip: '::ffff:127.0.0.1' })).toBe(true);
    for (const [reported, policy] of [
      [{ mode: 'direct', ip: '127.0.0.1' }, { mode: 'direct' }],
      [socks, { mode: 'direct' }],
      [{ mode: 'direct' }, socks],
      [{ ...socks, port: 9050 }, socks],
      [{ ...socks, ip: '127.0.0.2' }, socks],
      [null, socks],
      [socks, null],
    ]) {
      expect(reportsPolicy(reported, policy)).toBe(false);
    }
  });

  test('a process makes way for another policy, or for none while it runs direct', () => {
    const direct = { mode: 'direct' };
    const socks = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
    expect(supersedes(direct, direct)).toBe(false);
    expect(supersedes({ ...socks }, socks)).toBe(false);
    expect(supersedes(socks, direct)).toBe(true);
    expect(supersedes(direct, socks)).toBe(true);
    expect(supersedes({ ...socks, port: 9151 }, socks)).toBe(true);
    // The setting on, no endpoint yet: a direct process goes...
    expect(supersedes(null, direct)).toBe(true);
    // ...and Tor going down leaves a socks5 one, failing closed.
    expect(supersedes(null, socks)).toBe(false);
  });
});
