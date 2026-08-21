/**
 * Tests for http-fetch dweb-scheme support.
 *
 * bzz:// / ipfs:// / ipns:// URLs can't go through Node's http stack —
 * they must be dispatched to the custom protocol handlers registered on
 * the default session via session.fetch. The http/https paths hit real
 * sockets and are not covered here.
 */

const { session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchBuffer, fetchToFile } = require('./http-fetch');

const bodyStream = (chunks, { intervalMs = 0, close = true } = {}) =>
  new ReadableStream({
    async pull(controller) {
      if (!chunks.length) {
        if (close) {
          controller.close();
          return;
        }
        // close: false → stall forever with the stream open, like a dead
        // gateway; the pending read only settles when the timeout cancels it.
        return new Promise(() => {});
      }
      if (intervalMs) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      controller.enqueue(Uint8Array.from(Buffer.from(chunks.shift())));
    },
  });

const okResponse = (body, streamOpts) => ({
  ok: true,
  status: 200,
  body: bodyStream([body], streamOpts),
});

describe('http-fetch dweb schemes', () => {
  beforeEach(() => {
    session.defaultSession.fetch = jest.fn();
  });

  test('rejects unsupported schemes', async () => {
    await expect(fetchBuffer('file:///etc/passwd')).rejects.toThrow('Unsupported URL scheme: file');
    await expect(fetchToFile('javascript:alert(1)', '/tmp/x')).rejects.toThrow(
      'Unsupported URL scheme: javascript'
    );
    expect(session.defaultSession.fetch).not.toHaveBeenCalled();
  });

  test.each(['bzz', 'ipfs', 'ipns'])(
    'fetchBuffer routes %s:// through session.defaultSession.fetch',
    async (scheme) => {
      const url = `${scheme}://example.eth/images/pic.png`;
      session.defaultSession.fetch.mockResolvedValue(okResponse('image-bytes'));

      const result = await fetchBuffer(url);

      expect(session.defaultSession.fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual(Buffer.from('image-bytes'));
    }
  );

  test('fetchBuffer rejects on non-OK dweb response', async () => {
    session.defaultSession.fetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(fetchBuffer('bzz://example.eth/missing.png')).rejects.toThrow(
      'Failed to download: HTTP 404'
    );
  });

  test('fetchBuffer concatenates a chunked dweb body', async () => {
    session.defaultSession.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: bodyStream(['chunk-one|', 'chunk-two|', 'chunk-three']),
    });

    const result = await fetchBuffer('bzz://example.eth/big.png');

    expect(result).toEqual(Buffer.from('chunk-one|chunk-two|chunk-three'));
  });

  test('timeout is inactivity-based: steady slow transfers exceeding the timeout succeed', async () => {
    // 8 chunks arriving every 50ms with a 300ms timeout: total transfer time
    // (~400ms) exceeds the timeout, but no single gap comes close — a 250ms
    // event-loop stall would be needed to flake this on a loaded runner.
    session.defaultSession.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: bodyStream(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { intervalMs: 50 }),
    });

    const result = await fetchBuffer('bzz://example.eth/slow-but-steady.png', { timeout: 300 });

    expect(result).toEqual(Buffer.from('abcdefgh'));
  });

  test('a stalled dweb stream rejects with a timeout error', async () => {
    session.defaultSession.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: bodyStream(['first-chunk'], { close: false }),
    });

    await expect(fetchBuffer('bzz://example.eth/stalled.png', { timeout: 50 })).rejects.toThrow(
      'Request timed out'
    );
  });

  test('fetchBuffer maps AbortError to a timeout error', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    session.defaultSession.fetch.mockRejectedValue(abortError);

    await expect(fetchBuffer('bzz://example.eth/slow.png')).rejects.toThrow('Request timed out');
  });

  test('fetchToFile writes dweb response body to the destination path', async () => {
    session.defaultSession.fetch.mockResolvedValue(okResponse('png-data'));
    const destPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'http-fetch-')), 'pic.png');

    try {
      await fetchToFile('bzz://freedombrowser.eth/images/pic.png', destPath);
      expect(fs.readFileSync(destPath, 'utf8')).toBe('png-data');
    } finally {
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
    }
  });

  test('fetchToFile propagates dweb fetch failures without creating the file', async () => {
    session.defaultSession.fetch.mockResolvedValue({ ok: false, status: 503 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-fetch-'));
    const destPath = path.join(dir, 'pic.png');

    try {
      await expect(fetchToFile('ipfs://bafy123/pic.png', destPath)).rejects.toThrow(
        'Failed to download: HTTP 503'
      );
      expect(fs.existsSync(destPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
