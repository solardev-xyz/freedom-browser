/**
 * `applyTorRowVisibility` (src/renderer/pages/settings.html).
 *
 * The Experimental section's two `[data-tor]` rows used to be hidden on
 * Windows, because Windows shipped no Arti binary. Since #337 every platform
 * the release workflow builds compiles one, so the rows follow the binary the
 * build actually bundles instead of the platform it runs on.
 *
 * Same extraction approach as settings-radicle-launch.test.js: the settings
 * page is an inline classic script, so the helper is lifted out of the shipped
 * source and evaluated with its collaborators injected, keeping the assertion
 * on the real code rather than on a copy.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

const START = 'const applyTorRowVisibility = (settings = cachedSettings) => {';
const END = '\n      };\n';

function loadApply({ torBundled, cachedSettings, document }) {
  const start = SOURCE.indexOf(START);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(END, start);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start, end + END.length);
  const factory = new Function(
    'torBundled',
    'cachedSettings',
    'document',
    `${body}\nreturn applyTorRowVisibility;`
  );
  return factory(torBundled, cachedSettings, document);
}

const fakeRows = (count = 2) => {
  const rows = Array.from({ length: count }, () => ({ style: { display: '' } }));
  return {
    rows,
    document: {
      querySelectorAll: (selector) => {
        expect(selector).toBe('[data-tor]');
        return rows;
      },
    },
  };
};

const displays = ({ rows }) => rows.map((row) => row.style.display);

describe('applyTorRowVisibility', () => {
  test('shows the rows on a build that bundles Arti', () => {
    const dom = fakeRows();
    loadApply({ torBundled: true, cachedSettings: { enableTorIntegration: false }, ...dom })();

    expect(displays(dom)).toEqual(['', '']);
  });

  // What hides them now: a source build made without `npm run tor:download`,
  // or a Windows release cut before Windows Arti bundling landed. Every
  // artifact the release workflow builds from here on bundles Arti.
  test('hides the rows on a build that bundles none', () => {
    const dom = fakeRows();
    loadApply({ torBundled: false, cachedSettings: { enableTorIntegration: false }, ...dom })();

    expect(displays(dom)).toEqual(['none', 'none']);
  });

  test('hides the rows before any settings payload has arrived', () => {
    const dom = fakeRows();
    loadApply({ torBundled: false, cachedSettings: null, ...dom })();

    expect(displays(dom)).toEqual(['none', 'none']);
  });

  // An external Tor SOCKS proxy needs no bundled binary, so a profile that
  // already has the integration on keeps the rows it was switched on from —
  // otherwise the setting could never be switched off again.
  test('keeps the rows when the integration is already enabled without a binary', () => {
    const dom = fakeRows();
    loadApply({ torBundled: false, cachedSettings: { enableTorIntegration: true }, ...dom })();

    expect(displays(dom)).toEqual(['', '']);
  });

  test('the argument wins over the cached settings', () => {
    const dom = fakeRows();
    loadApply({ torBundled: false, cachedSettings: { enableTorIntegration: true }, ...dom })({
      enableTorIntegration: false,
    });

    expect(displays(dom)).toEqual(['none', 'none']);
  });

  test('restores a row a previous hidden pass had switched off', () => {
    const dom = fakeRows();
    loadApply({ torBundled: false, cachedSettings: {}, ...dom })();
    expect(displays(dom)).toEqual(['none', 'none']);

    loadApply({ torBundled: true, cachedSettings: {}, ...dom })();
    expect(displays(dom)).toEqual(['', '']);
  });
});

describe('the settings page no longer gates Tor on the platform', () => {
  test('carries no Windows flag or per-service Windows opt-out', () => {
    expect(SOURCE).not.toContain('isWindows');
    expect(SOURCE).not.toContain('hideOnWindows');
  });

  test('the Nodes-section Tor row is gated on the setting alone', () => {
    const start = SOURCE.indexOf('const isProfileServiceVisible = ');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = SOURCE.slice(start, SOURCE.indexOf('\n      };\n', start));

    expect(body).toContain('definition.settingKey');
    expect(body).not.toMatch(/platform|win32|Windows/i);
  });
});
