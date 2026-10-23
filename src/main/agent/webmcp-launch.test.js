'use strict';

const fs = require('fs');
const path = require('path');
const IPC = require('../../shared/ipc-channels');
const { WEBVIEW_CHANNEL_TIERS, TIER } = require('../ipc-sender-policy');
const {
  webMcpBlinkFeatures,
  recordWebMcpLaunch,
  webMcpEnabledAtLaunch,
  registerWebMcpLaunchIpc,
} = require('./webmcp-launch');

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
    // The same decision is recorded for page-tool discovery's restart hint.
    expect(source).toMatch(/appendSwitch\('enable-blink-features', webMcpFeatures\);\nrecordWebMcpLaunch\(webMcpFeatures\);/);
    expect(source).not.toMatch(/WebMCPTesting/);
    // Set before the app is ready, i.e. before any renderer exists.
    expect(source.indexOf('webMcpBlinkFeatures(loadSettings())')).toBeLessThan(source.indexOf('app.whenReady().then(bootstrap)'));
  });

  test('records whether this launch enabled WebMCP', () => {
    expect(webMcpEnabledAtLaunch()).toBeNull();
    recordWebMcpLaunch(webMcpBlinkFeatures({ enableAi: false }));
    expect(webMcpEnabledAtLaunch()).toBe(false);
    recordWebMcpLaunch(webMcpBlinkFeatures({ enableAi: true }));
    expect(webMcpEnabledAtLaunch()).toBe(true);
  });

  test('Settings reads this launch\'s decision, not the stored setting', async () => {
    const handlers = new Map();
    registerWebMcpLaunchIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
    const read = handlers.get(IPC.AGENT_WEBMCP_LAUNCH_STATE);
    recordWebMcpLaunch(null);
    expect(await read()).toEqual({ enabledAtLaunch: false });
    recordWebMcpLaunch('WebMCP');
    expect(await read()).toEqual({ enabledAtLaunch: true });
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(source).toMatch(/registerWebMcpLaunchIpc\(ipcMain\);/);
  });

  test('only the Settings page may ask', () => {
    expect(WEBVIEW_CHANNEL_TIERS.get(IPC.AGENT_WEBMCP_LAUNCH_STATE)).toBe(TIER.SETTINGS);
  });
});
