'use strict';

const fs = require('fs');
const path = require('path');
const { webMcpBlinkFeatures } = require('./webmcp-launch');

describe('webMcpBlinkFeatures', () => {
  test('enables WebMCP only for a launch with AI explicitly on, without the testing API', () => {
    expect(webMcpBlinkFeatures({ enableAi: true })).toBe('WebMCP');
    for (const settings of [{ enableAi: false }, { enableAi: 'true' }, { enableAi: 1 }, {}, null, undefined]) {
      expect(webMcpBlinkFeatures(settings)).toBeNull();
    }
  });

  test('main/index.js decides the switch from the stored settings instead of enabling it for every launch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const switches = [...source.matchAll(/appendSwitch\(\s*'enable-blink-features'\s*,\s*([^)]*)\)/g)];
    expect(switches.map((m) => m[1].trim())).toEqual(['webMcpFeatures']);
    expect(source).toMatch(/const webMcpFeatures = webMcpBlinkFeatures\(loadSettings\(\)\);\nif \(webMcpFeatures\) app\.commandLine\.appendSwitch/);
    expect(source).not.toMatch(/WebMCPTesting/);
    // Set before the app is ready, i.e. before any renderer exists.
    expect(source.indexOf('webMcpBlinkFeatures(loadSettings())')).toBeLessThan(source.indexOf('app.whenReady().then(bootstrap)'));
  });
});
