const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBeeConfig } = require('./injection');

describe('createBeeConfig', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-config-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('allows no browser origin to read the node API (security audit O-1)', () => {
    const configPath = createBeeConfig(dir, 'pw', 1633, 1634);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('api-addr: 127.0.0.1:1633');
    expect(content).not.toMatch(/cors-allowed-origins/);
  });
});
