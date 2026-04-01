jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation((url) => ({ _testUrl: url })),
}));

jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn(),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { getBee, resetBeeClient } = require('./swarm-service');
const { getBeeApiUrl } = require('../service-registry');

describe('swarm-service', () => {
  beforeEach(() => {
    resetBeeClient();
  });

  test('creates a Bee client from the service registry URL', () => {
    getBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee = getBee();
    expect(bee._testUrl).toBe('http://127.0.0.1:1633');
  });

  test('returns the same client on subsequent calls with the same URL', () => {
    getBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();
    const bee2 = getBee();
    expect(bee1).toBe(bee2);
  });

  test('recreates the client when the URL changes', () => {
    getBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();

    getBeeApiUrl.mockReturnValue('http://127.0.0.1:1634');
    const bee2 = getBee();

    expect(bee1).not.toBe(bee2);
    expect(bee2._testUrl).toBe('http://127.0.0.1:1634');
  });

  test('resetBeeClient forces a new client on next call', () => {
    getBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();

    resetBeeClient();
    const bee2 = getBee();

    expect(bee1).not.toBe(bee2);
  });
});
