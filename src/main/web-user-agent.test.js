const { applyWebUserAgent, chromeUserAgent } = require('./web-user-agent');

// Electron 44's defaults, as `app.userAgentFallback` reports them.
const ELECTRON_UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Freedom/0.8.6 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) FreedomDev/0.8.6 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) freedom/0.8.6 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36',
};

// Stock Chrome 152's (reduced) UA on the same platforms.
const CHROME_UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
};

describe('chromeUserAgent', () => {
  test.each(Object.keys(ELECTRON_UA))('%s: identical to stock Chrome', (platform) => {
    const ua = chromeUserAgent(ELECTRON_UA[platform], '152.0.7977.130');
    expect(ua).toBe(CHROME_UA[platform]);
    expect(ua).not.toMatch(/Freedom|Electron\//i);
  });

  test.each([
    ['X11; Linux aarch64', 'X11; Linux x86_64'],
    ['X11; Linux i686', 'X11; Linux x86_64'],
    ['X11; Linux armv7l', 'X11; Linux x86_64'],
    ['Windows NT 10.0; ARM64', 'Windows NT 10.0; Win64; x64'],
    ['Windows NT 6.1; WOW64', 'Windows NT 10.0; Win64; x64'],
    ['Macintosh; Intel Mac OS X 14_5', 'Macintosh; Intel Mac OS X 10_15_7'],
  ])("platform %s is frozen to Chrome's unified %s", (electron, chrome) => {
    const ua = chromeUserAgent(
      ELECTRON_UA.linux.replace('X11; Linux x86_64', electron),
      '152.0.7977.130'
    );
    expect(ua).toBe(
      `Mozilla/5.0 (${chrome}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`
    );
  });

  test('the Chrome major comes from the running Chromium, not the old string', () => {
    expect(chromeUserAgent(ELECTRON_UA.linux, '153.0.1.2')).toContain(' Chrome/153.0.0.0 ');
  });

  test('is idempotent', () => {
    expect(chromeUserAgent(CHROME_UA.mac, '152.0.7977.130')).toBe(CHROME_UA.mac);
  });

  test('an unrecognised shape still loses every non-Chrome product token', () => {
    const odd =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Freedom/0.8.6 Electron/44.7.0 Safari/537.36 Extra/1';
    const ua = chromeUserAgent(odd.replace('(KHTML, like Gecko)', '(KHTML)'), '152.0.7977.130');
    expect(ua).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML) Chrome/152.0.7977.130 Safari/537.36'
    );
    expect(chromeUserAgent(odd, 'not-a-version')).not.toMatch(/Freedom|Electron|Extra/);
  });
});

describe('applyWebUserAgent', () => {
  test('replaces app.userAgentFallback, which every session inherits', () => {
    const app = { userAgentFallback: ELECTRON_UA.mac };
    expect(applyWebUserAgent(app, '152.0.7977.130')).toBe(CHROME_UA.mac);
    expect(app.userAgentFallback).toBe(CHROME_UA.mac);
  });

  test('index.js applies it before any window can exist', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('./index.js'), 'utf8');
    const applied = src.indexOf("require('./web-user-agent').applyWebUserAgent(app)");
    expect(applied).toBeGreaterThan(-1);
    for (const marker of ['new BrowserWindow', 'createMainWindow(', 'app.whenReady()']) {
      const at = src.indexOf(marker);
      if (at !== -1) expect(applied).toBeLessThan(at);
    }
  });
});
