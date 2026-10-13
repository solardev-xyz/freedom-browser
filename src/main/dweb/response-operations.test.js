/**
 * The response operations (freedom-core design 0006). `dweb-vectors.test.js`
 * runs fc-dweb's `operations`, `locations` and `exchanges` against them when
 * the vectors are found; these cases run everywhere.
 */

const {
  canonicalizeRedirect,
  respond,
  smallTextLength,
  sniffSmallText,
} = require('./response-operations');

const HASH = 'ab'.repeat(32);
const ANT_URL = `http://127.0.0.1:1633/bzz/${HASH}/blog`;
const GATEWAY_URL = 'http://127.0.0.1:8080/ipfs/bafy/docs';

const head = (status, headers) => ({ status, headers: new Headers(headers) });

function streamOf(chunks) {
  let reads = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (reads < chunks.length) controller.enqueue(Buffer.from(chunks[reads]));
        else controller.close();
        reads += 1;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, reads: () => reads };
}

describe('canonicalize_redirect', () => {
  test('Ant: a 308 in gateway space becomes a relative Location, its body dropped', () => {
    const answer = head(308, {
      location: `/bzz/${HASH}/blog/`,
      'content-length': '9',
      'content-encoding': 'gzip',
      etag: '"e"',
    });
    expect(canonicalizeRedirect(answer, ANT_URL, 'ant')).toBe('drop');
    expect([...answer.headers]).toEqual([
      ['etag', '"e"'],
      ['location', './blog/'],
    ]);
  });

  test('Ant: a 300, a cross-origin Location and one that climbs are left alone', () => {
    for (const [status, location] of [
      [300, `/bzz/${HASH}/blog/`],
      [302, 'http://127.0.0.1:9/elsewhere'],
      [301, '/stamps/'],
    ]) {
      const answer = head(status, { location });
      expect(canonicalizeRedirect(answer, ANT_URL, 'ant')).toBe('keep');
      expect(answer.headers.get('location')).toBe(location);
    }
  });

  test('the gateway: any 3xx is rewritten in place, its body kept', () => {
    const answer = head(399, { location: '/ipfs/bafy/docs/', 'content-type': 'text/html' });
    expect(canonicalizeRedirect(answer, GATEWAY_URL, 'ipfs')).toBe('keep');
    expect(answer.headers.get('location')).toBe('./docs/');
  });
});

describe('small_text', () => {
  const octets = (length, extra = {}) =>
    head(200, { 'content-type': 'application/octet-stream', 'content-length': length, ...extra });

  test('reads the declared length as Number() does', () => {
    for (const length of ['0x2', '2.0', '2e0', ' 2 ']) {
      expect([length, smallTextLength(octets(length), true)]).toEqual([length, 2]);
    }
    for (const length of ['0', '-2', '4097', '2.5', 'NaN', '']) {
      expect([length, smallTextLength(octets(length), true)]).toEqual([length, null]);
    }
    expect(smallTextLength(octets('2', { 'content-range': 'bytes 0-1/2' }), true)).toBeNull();
    expect(smallTextLength(octets('2'), false)).toBeNull();
  });

  test('relabels text whose length matches, replaying every byte', async () => {
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    const { stream } = streamOf(['hel', 'lo']);
    const body = await sniffSmallText(headers, stream, 5);
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await new Response(body).arrayBuffer()).toString()).toBe('hello');
  });

  test('a lying length or an oversized chunk is replayed intact, holding at most one chunk past 4 KiB', async () => {
    const short = new Headers({ 'content-type': 'application/octet-stream' });
    const lied = await sniffSmallText(short, streamOf(['hello']).stream, 4);
    expect(short.get('x-content-type-options')).toBeNull();
    expect(Buffer.from(await new Response(lied).arrayBuffer()).toString()).toBe('hello');

    const big = new Headers({ 'content-type': 'application/octet-stream' });
    const oversized = streamOf(['a'.repeat(65_536), 'rest']);
    const body = await sniffSmallText(big, oversized.stream, 4);
    // One read held it all: the sniff stopped there.
    expect(oversized.reads()).toBe(1);
    expect(big.get('content-type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    expect(bytes.length).toBe(65_540);
  });
});

describe('respond', () => {
  const fetch = (response, node = 'ipfs') => ({ node, response });

  test('strips page state from every backend, whatever the plan names', () => {
    for (const kind of ['ant', 'native', 'gateway']) {
      const answer = head(200, { 'set-cookie': 'a=1', 'service-worker-allowed': '/' });
      respond(fetch([], kind === 'ant' ? 'ant' : 'ipfs'), kind, answer, ANT_URL, true);
      expect([kind, [...answer.headers]]).toEqual([kind, []]);
    }
  });

  test('small text never fires on the gateway: its length is gone first', () => {
    const answer = head(200, { 'content-type': 'application/octet-stream', 'content-length': '5' });
    const ops = ['strip_decoded_encoding', 'strip_page_state', 'small_text'];
    expect(respond(fetch(ops), 'gateway', answer, GATEWAY_URL, true).smallText).toBeNull();
  });
});
