jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@synonymdev/pubky', () => {
  const fetch = jest.fn();
  return {
    Pubky: jest.fn(() => ({ client: { fetch } })),
    resolvePubky: (address) => `https://resolved/${address}`,
    fetch,
  };
});

const { fetch } = require('@synonymdev/pubky');
const { handlePubkyRequest, toPubkyAddress } = require('./pubky-protocol');

const KEY = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';

beforeEach(() => fetch.mockReset());

describe('toPubkyAddress', () => {
  test.each([
    [`pubky://${KEY}/pub/app/index.html`, `pubky${KEY}/pub/app/index.html`],
    [`pubky://${KEY}/pub/a/../b.txt?x=1`, `pubky${KEY}/pub/b.txt?x=1`],
  ])('accepts %s', (input, address) => {
    expect(toPubkyAddress(input)).toBe(address);
  });

  test.each([
    [`pubky://${KEY}/`, 'outside /pub/'],
    [`pubky://${KEY}/session`, 'outside /pub/'],
    [`pubky://${KEY}/pub/../session`, 'climbs out of /pub/'],
    [`pubky://${KEY.slice(0, -1)}a/pub/x`, 'non-zero trailing bits'],
    [`pubky://${KEY.slice(1)}/pub/x`, 'short key'],
    [`pubky://www.${KEY}/pub/x`, 'label before the key'],
    [`pubky://${KEY}:8080/pub/x`, 'port'],
    [`https://${KEY}/pub/x`, 'other scheme'],
  ])('rejects %s (%s)', (input) => {
    expect(toPubkyAddress(input)).toBeNull();
  });
});

describe('handlePubkyRequest', () => {
  test('returns the homeserver response unchanged', async () => {
    const upstream = new Response('hi', { status: 404 });
    fetch.mockResolvedValue(upstream);
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'HEAD' });
    expect(res).toBe(upstream);
    expect(fetch).toHaveBeenCalledWith(`https://resolved/pubky${KEY}/pub/x`, { method: 'HEAD' });
  });

  test('refuses writes without calling the SDK', async () => {
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'PUT' });
    expect(res.status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects an invalid address', async () => {
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/session`, method: 'GET' });
    expect(res.status).toBe(400);
  });

  test('maps a resolution failure to 502', async () => {
    fetch.mockRejectedValue(new Error('No HTTPS endpoints found'));
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
    expect(res.status).toBe(502);
  });
});
