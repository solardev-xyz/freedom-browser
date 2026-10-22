/**
 * Private windows' instances against the real freedom-ipfsd (freedom-core
 * design 0007, "Private windows"), serving the loopback fixture
 * (`test/helpers/ipfs-fixture.js`) only. Skipped unless FREEDOM_IPFSD_PATH
 * points at a build, e.g.
 *   FREEDOM_IPFSD_PATH=freedom-ipfsd-bin/linux-x64/freedom-ipfsd npx jest src/main/ipfs/freedom-ipfsd-private
 *
 * What the backend contract suite can't see from the handler:
 * - each partition's instance in the one ephemeral process, under its own
 *   ID;
 * - a ninth partition's start against the service's own room count, which
 *   holds an evicted instance until its teardown is proven: the start waits
 *   for it rather than meeting `busy`;
 * - the process exits once its last instance has stopped, and comes back
 *   on the next private load;
 * - a start under `socks5` (design 0007, step 8, B2), which the service
 *   takes only with delegated routing, and with no proxy listening, a load
 *   that fails closed: nothing reaches the router directly.
 */

const net = require('net');
const { PrivateInstances, MAX_INSTANCES } = require('./freedom-ipfsd-private');
const { IpfsNetwork } = require('./ipfs-network');
const { IpfsContent, startIpfsFixture } = require('../../../test/helpers/ipfs-fixture');

const binary = process.env.FREEDOM_IPFSD_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

describeIfBinary('private instances on the real freedom-ipfsd', () => {
  let content;
  let fixture;
  let file;
  let instances;
  let starts;

  beforeAll(async () => {
    content = new IpfsContent();
    file = content.file(Buffer.from('private content\n'));
    fixture = await startIpfsFixture(content);
  });

  afterAll(async () => {
    await fixture?.close();
  });

  beforeEach(() => {
    starts = [];
    instances = new PrivateInstances({ command: binary, log: quietLog, shellVersion: 'jest' });
    // The fixture is the only router, in delegated-only routing: nothing
    // leaves the loopback interface.
    const { client } = instances;
    const startInstance = client.startInstance.bind(client);
    client.startInstance = (gen, params, options) => {
      starts.push(params.instance);
      return startInstance(
        gen,
        {
          ...params,
          routing: { ...params.routing, mode: 'delegated', delegated_routers: [fixture.router] },
        },
        options
      );
    };
  });

  afterEach(async () => {
    await instances.stop();
  });

  /** One load on `lease`. */
  async function load(lease) {
    const res = await lease.request({
      path: `/ipfs/${file.cid}`,
      method: 'GET',
      headers: new Headers(),
      headersTimeoutMs: 30_000,
    });
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer()).toString();
  }

  test('each partition gets an instance of its own in one process; the ninth evicts, after its teardown', async () => {
    const leases = [];
    for (let i = 0; i < MAX_INSTANCES; i++) {
      const lease = instances.lease(`private-${i}`);
      leases.push(lease);
      expect(await load(lease)).toBe('private content\n');
    }
    expect(starts).toEqual(['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7', 'e-8']);
    const pid = instances.client.current.child.pid;

    expect(() => instances.lease('private-ninth')).toThrow(
      'Too many private windows are loading IPFS content'
    );
    leases[0].release();
    const ninth = instances.lease('private-ninth');
    // The service still counts e-1 until its teardown is proven: the start
    // waits for it.
    expect(await load(ninth)).toBe('private content\n');
    expect(starts.at(-1)).toBe('e-9');
    expect(instances.client.current.child.pid).toBe(pid);

    ninth.release();
    for (const lease of leases.slice(1)) lease.release();
  }, 60_000);

  test('the process exits after its last instance, and comes back for the next private load', async () => {
    const lease = instances.lease('private-a');
    expect(await load(lease)).toBe('private content\n');
    lease.release();
    const child = instances.client.current.child;
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

    instances.close('private-a');
    expect(await exited).toBe(0);

    const next = instances.lease('private-b');
    expect(await load(next)).toBe('private content\n');
    expect(instances.client.current.child.pid).not.toBe(child.pid);
    expect(starts).toEqual(['e-1', 'e-1']);
    next.release();
  }, 60_000);

  test('under socks5 the service takes the start, and with no proxy a load fails closed', async () => {
    await instances.stop();
    // A loopback port nothing listens on: Tor's endpoint, down.
    const port = await new Promise((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = server.address();
        server.close(() => resolve(free));
      });
    });
    const tor = {
      getIpfsSocksEndpoint: () => ({ endpoint: { ip: '127.0.0.1', port }, refused: null }),
      onIpfsSocksEndpointChange: () => () => {},
    };
    instances = new PrivateInstances({
      command: binary,
      log: quietLog,
      shellVersion: 'jest',
      network: new IpfsNetwork({ routesThroughTor: () => true, tor }),
    });
    // As sent, but with the fixture as the only router, routing untouched.
    const sentStarts = [];
    const { client } = instances;
    const startInstance = client.startInstance.bind(client);
    client.startInstance = (gen, params, options) => {
      sentStarts.push(params);
      return startInstance(
        gen,
        { ...params, routing: { ...params.routing, delegated_routers: [fixture.router] } },
        options
      );
    };
    const seen = fixture.requests.length;
    const lease = instances.lease('private-tor');
    const res = await lease.request({
      path: `/ipfs/${file.cid}`,
      method: 'GET',
      headers: new Headers(),
      headersTimeoutMs: 30_000,
    });
    // The service took the start: socks5, delegated routing.
    expect(sentStarts).toHaveLength(1);
    expect(sentStarts[0].network).toEqual({ mode: 'socks5', ip: '127.0.0.1', port });
    expect(sentStarts[0].routing.mode).toBe('delegated');
    // Its load failed closed, and nothing reached the router directly.
    expect([502, 504]).toContain(res.status);
    await res.arrayBuffer();
    expect(fixture.requests.slice(seen)).toEqual([]);
    lease.release();
  }, 60_000);
});
