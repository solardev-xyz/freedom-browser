const originalWindow = global.window;
const originalFetch = global.fetch;

describe('fetchAntJson (chrome reads the node over IPC, security audit O-1)', () => {
  let fetchAntJson;
  beforeEach(async () => {
    jest.resetModules();
    global.fetch = jest.fn();
    ({ fetchAntJson } = await import('./ant-api.js'));
  });
  afterEach(() => {
    global.window = originalWindow;
    global.fetch = originalFetch;
  });

  test('goes through window.ant.apiGet, never fetch()', async () => {
    const apiGet = jest.fn().mockResolvedValue({ ok: true, status: 200, data: { a: 1 } });
    global.window = { ant: { apiGet } };
    await expect(fetchAntJson('/wallet')).resolves.toEqual({
      ok: true,
      status: 200,
      data: { a: 1 },
    });
    expect(apiGet).toHaveBeenCalledWith('/wallet');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects when no response was received, like the fetch() it replaced', async () => {
    global.window = {
      ant: {
        apiGet: jest
          .fn()
          .mockResolvedValue({ ok: false, status: 0, data: null, error: 'Ant API unreachable' }),
      },
    };
    await expect(fetchAntJson('/wallet')).rejects.toThrow('Ant API unreachable');
  });

  test('resolves non-OK responses', async () => {
    global.window = {
      ant: { apiGet: jest.fn().mockResolvedValue({ ok: false, status: 500, data: null }) },
    };
    await expect(fetchAntJson('/node')).resolves.toEqual({ ok: false, status: 500, data: null });
  });
});
