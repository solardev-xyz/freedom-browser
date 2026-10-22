/**
 * The IPFS fixture's providers as configured targets (ipfs-fixture.js):
 * the router is the default provider, at its own host and port, and a pool
 * of providers is listed with it, which `isolate()` hands out, retiring one
 * that failed a block for good.
 */

const { IpfsContent, startIpfsFixture } = require('./ipfs-fixture');

const providersOf = async (router, cid) => {
  const res = await fetch(`${router}/providers/${cid}`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

/** The provider's base URL, from its record's one address. */
const baseOf = (record) => {
  const [, , ip, , port] = record.Addrs[0].split('/');
  return `http://${ip}:${port}`;
};

const block = async (base, cid) => {
  const res = await fetch(`${base}/ipfs/${cid}?format=raw`);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
};

describe('the IPFS fixture', () => {
  let fixture;
  afterEach(async () => {
    await fixture?.close();
    fixture = null;
  });

  test('the router is the default provider, at its own host and port', async () => {
    const content = new IpfsContent();
    const file = content.file('hello');
    fixture = await startIpfsFixture(content);
    expect(fixture.routers).toEqual([fixture.router]);
    const { status, body } = await providersOf(fixture.router, file.cid);
    expect(status).toBe(200);
    const base = baseOf(body.Providers[0]);
    expect(fixture.router.startsWith(base)).toBe(true);
    expect(await block(base, file.cid)).toEqual({ status: 200, bytes: Buffer.from('hello') });
    // An unknown CID is the router's 404, as before.
    expect((await providersOf(fixture.router, content.raw('elsewhere').cid + 'x')).status).toBe(
      404
    );
    expect(fixture.requests.map((request) => request.kind)).toEqual([
      'providers',
      'block',
      'providers',
    ]);
  });

  test("a pool's providers are listed as routers that find nothing, unrecorded, and serve what is isolated to them", async () => {
    const content = new IpfsContent();
    const file = content.file('isolated');
    fixture = await startIpfsFixture(content, { pool: 3 });
    expect(fixture.routers).toHaveLength(4);
    expect(fixture.routers[0]).toBe(fixture.router);
    for (const router of fixture.routers.slice(1)) {
      expect((await providersOf(router, file.cid)).status).toBe(404);
    }
    expect(fixture.requests).toEqual([]);

    const provider = await fixture.isolate(file);
    const { body } = await providersOf(fixture.router, file.cid);
    expect(body.Providers).toEqual([provider.record]);
    const base = baseOf(provider.record);
    expect(fixture.routers).toContain(`${base}/routing/v1`);
    expect(await block(base, file.cid)).toEqual({ status: 200, bytes: Buffer.from('isolated') });
  });

  test('a pool provider that failed a block is retired at reset, and never handed out again', async () => {
    const content = new IpfsContent();
    const files = Array.from({ length: 6 }, (_, i) => content.file(`file ${i}`));
    fixture = await startIpfsFixture(content, { pool: 3 });

    const failing = await fixture.isolate(files[0]);
    failing.fail(files[0].cid);
    const stalling = await fixture.isolate(files[1]);
    stalling.stall(files[1].cid);
    expect(fixture.poolState()).toEqual({ free: [3], inUse: [1, 2], retired: [] });

    fixture.reset();
    expect(fixture.poolState()).toEqual({ free: [3, 2], inUse: [], retired: [1] });

    // Every later isolate, through more resets, gets the others only.
    const handed = [];
    for (const file of files.slice(2)) {
      const provider = await fixture.isolate(file);
      handed.push(provider.index);
      fixture.reset();
    }
    expect(handed).toEqual([3, 2, 3, 2]);
    expect(fixture.poolState().retired).toEqual([1]);
  });

  test('an isolate with the pool used up throws, naming its size', async () => {
    const content = new IpfsContent();
    const files = Array.from({ length: 3 }, (_, i) => content.file(`file ${i}`));
    fixture = await startIpfsFixture(content, { pool: 2 });
    (await fixture.isolate(files[0])).fail(files[0].cid);
    await fixture.isolate(files[1]);
    await expect(fixture.isolate(files[2])).rejects.toThrow(
      "the IPFS fixture's pool of 2 providers is used up (0 retired after a fail(), 2 in use until reset())"
    );
    fixture.reset();
    // The failed one is retired; the other is free again.
    expect(fixture.poolState()).toEqual({ free: [2], inUse: [], retired: [1] });
  });

  test('without a pool, isolate starts a server of its own, listed nowhere', async () => {
    const content = new IpfsContent();
    const file = content.file('alone');
    fixture = await startIpfsFixture(content);
    const provider = await fixture.isolate(file);
    expect(fixture.routers).toEqual([fixture.router]);
    expect(fixture.router.startsWith(baseOf(provider.record))).toBe(false);
    expect(await block(baseOf(provider.record), file.cid)).toEqual({
      status: 200,
      bytes: Buffer.from('alone'),
    });
  });
});
