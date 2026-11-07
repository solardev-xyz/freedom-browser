const { endpointIdentity, distinctEndpoints, catalogProviders } = require('./endpoint-identity');
const catalog = require('../../shared/endpoint-sources.json');

const same = (a, b) => expect(endpointIdentity(a)).toBe(endpointIdentity(b));
const differ = (a, b) => expect(endpointIdentity(a)).not.toBe(endpointIdentity(b));

describe('endpoint identity (#1094)', () => {
  test('a trailing slash is the same provider', () => {
    same('https://rpc.example', 'https://rpc.example/');
  });

  test('one host on two paths, or with a query, is one provider', () => {
    same('https://rpc.example/gnosis', 'https://rpc.example/v1/other?x=1');
  });

  test("a host's case and trailing dot don't make another provider", () => {
    same('https://RPC.Example./', 'https://rpc.example');
  });

  test("a public host's ports are one operator's", () => {
    same('https://rpc.example', 'https://rpc.example:8443');
    same('https://rpc.example:443', 'http://rpc.example:8545');
  });

  test('two keys at one keyed provider are one provider', () => {
    same(
      'https://eth-mainnet.g.alchemy.com/v2/first-key',
      'https://eth-mainnet.g.alchemy.com/v2/second-key'
    );
  });

  test("a keyed provider is one provider on any of its catalog's domains", () => {
    // DRPC's keyed endpoint and its public one: two hosts, one provider.
    same('https://lb.drpc.live/gnosis/some-key', 'https://gnosis.drpc.org');
    same('https://mainnet.infura.io/v3/a', 'https://other-name.infura.io/v3/b');
    same('https://eth-mainnet.g.alchemy.com/v2/a', 'https://dashboard.alchemy.com/rpc/b');
  });

  test('a provider domain matches only whole labels', () => {
    differ('https://gnosis.drpc.org', 'https://notdrpc.org');
    differ('https://gnosis.drpc.org', 'https://drpc.org.attacker.example');
  });

  test('localhost, 127.0.0.1 and ::1 are one loopback host', () => {
    const aliases = [
      'http://localhost:8545',
      'http://127.0.0.1:8545/',
      'http://[::1]:8545',
      'http://127.0.0.2:8545/rpc',
      'http://[::ffff:127.0.0.1]:8545',
      'http://node.localhost:8545',
      'https://LOCALHOST.:8545',
    ];
    for (const alias of aliases) same(alias, 'http://localhost:8545');
  });

  test('a loopback port is a process of its own', () => {
    differ('http://127.0.0.1:8545', 'http://127.0.0.1:8546');
    differ('http://localhost:8545', 'http://[::1]:8546');
  });

  test("a loopback URL without a port is on its scheme's default port", () => {
    same('http://localhost', 'https://127.0.0.1:80');
    same('https://localhost', 'http://[::1]:443');
    differ('http://localhost', 'https://localhost');
  });

  test('distinct providers stay distinct', () => {
    differ('https://a.example', 'https://b.example');
    differ('https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com');
    differ('https://gnosis.drpc.org', 'https://eth-mainnet.g.alchemy.com/v2/k');
    differ('http://127.0.0.1:8545', 'https://rpc.example');
    differ('http://10.0.0.1:8545', 'http://127.0.0.1:8545');
  });

  test("a URL that doesn't parse, or has no host, is its own provider, by its exact text", () => {
    expect(endpointIdentity('not a url')).toBe('url:not a url');
    differ('not a url', 'not a url/');
    differ('file:///one', 'file:///two');
  });

  test('distinctEndpoints keeps the first URL of each provider, in order', () => {
    expect(
      distinctEndpoints([
        'https://a.example/',
        'http://localhost:8545',
        'https://a.example',
        'https://b.example/one',
        'http://127.0.0.1:8545',
        'https://b.example/two',
        'http://127.0.0.1:8546',
      ])
    ).toEqual([
      'https://a.example/',
      'http://localhost:8545',
      'https://b.example/one',
      'http://127.0.0.1:8546',
    ]);
    expect(distinctEndpoints([])).toEqual([]);
    expect(distinctEndpoints(undefined)).toEqual([]);
  });

  test('every URL collapsing to one provider leaves one endpoint', () => {
    expect(
      distinctEndpoints(['http://127.0.0.1:8545', 'http://localhost:8545/', 'http://[::1]:8545'])
    ).toEqual(['http://127.0.0.1:8545']);
  });
});

describe('the catalog names each keyed provider', () => {
  const keyed = Object.entries(catalog).filter(([, source]) => source.keyed);
  const providers = catalogProviders(catalog);

  test('there are keyed sources to check', () => {
    expect(keyed.map(([id]) => id).sort()).toEqual(['alchemy', 'drpc', 'infura']);
  });

  test.each(keyed.map(([id]) => [id]))(
    '%s declares providerDomains that cover each of its endpoints',
    (id) => {
      const provider = providers.find((entry) => entry.id === id);
      expect(provider).toBeDefined();
      for (const template of Object.values(catalog[id].coverage)) {
        const url = template.replace('{API_KEY}', 'key');
        expect(endpointIdentity(url)).toBe(`provider:${id}`);
      }
    }
  );

  test('a domain without a dot names no provider', () => {
    expect(
      catalogProviders({
        wide: { providerDomains: ['com', ' Example.ORG. ', 7] },
        none: { providerDomains: [] },
        missing: {},
      })
    ).toEqual([{ id: 'wide', domains: ['example.org'] }]);
  });

  test('only the providers given are merged', () => {
    const url = 'https://lb.drpc.live/gnosis/key';
    expect(endpointIdentity(url, [])).toBe('host:lb.drpc.live');
    expect(distinctEndpoints([url, 'https://gnosis.drpc.org'], [])).toHaveLength(2);
  });
});
