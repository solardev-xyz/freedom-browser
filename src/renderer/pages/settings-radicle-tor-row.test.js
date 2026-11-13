/**
 * Settings → Advanced → "Route Radicle through Tor" (freedom-core design
 * 0008, "The setting"; the radicled step-5 plan's B18).
 *
 * As settings-ipfs-tor-row.test.js does, the row's helper is lifted out of
 * the shipped page script and evaluated with its collaborators injected, so
 * the assertions are on the real code.
 */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');

const START = 'const applyRouteRadicleRowState = () => {';
const END = '\n};\n';

const WAITING =
  "Tor isn't running, so the built-in Radicle node doesn't connect. Start Tor from the Nodes menu, or turn this off to connect directly.";

function loadApply({ fields, help, torRunning, radicleMode }) {
  const start = SCRIPT.indexOf(START);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SCRIPT.indexOf(END, start);
  const body = SCRIPT.slice(start, end + END.length);
  const factory = new Function(
    'fields',
    'routeRadicleHelp',
    'defaultRouteRadicleHelp',
    'torRunning',
    'radicleMode',
    `${body}\nreturn applyRouteRadicleRowState;`
  );
  return factory(fields, help, 'DEFAULT HELP', torRunning, radicleMode);
}

function row({ torOn, routed, torRunning = null, radicleMode = 'managed' }) {
  const classes = new Set();
  const fields = {
    enableTor: { checked: torOn },
    routeRadicle: { checked: routed, disabled: false },
    routeRadicleRow: {
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    },
  };
  const help = { textContent: '' };
  loadApply({ fields, help, torRunning, radicleMode })();
  return {
    disabled: fields.routeRadicle.disabled,
    rowDisabled: classes.has('disabled'),
    help: help.textContent,
  };
}

/** The text of the element with `id`, its whitespace collapsed. */
function textOf(id) {
  const start = HTML.indexOf(`id="${id}"`);
  const open = HTML.indexOf('>', start) + 1;
  const close = HTML.indexOf('</', open);
  return HTML.slice(open, close).replace(/\s+/g, ' ').trim();
}

describe('Route Radicle through Tor', () => {
  test('the row sits under Advanced after the IPFS row, a Tor row and a toggle of its own, with no restart', () => {
    const advanced = HTML.slice(HTML.indexOf('id="experimental"'), HTML.indexOf('id="about"'));
    const start = advanced.indexOf('id="route-radicle-through-tor-row"');
    expect(start).toBeGreaterThan(advanced.indexOf('id="route-ipfs-through-tor-row"'));
    const markup = advanced.slice(start, advanced.indexOf('</div>\n          </div>', start));
    expect(markup).toContain('data-tor');
    expect(markup).toContain('Route Radicle through Tor');
    expect(markup).toMatch(/<input\s+type="checkbox"\s+id="route-radicle-through-tor"\s/);
    expect(markup).not.toMatch(/restart/i);
  });

  test("its copy is the built-in node's: what it costs, and that it fails closed", () => {
    expect(textOf('route-radicle-through-tor-help')).toBe(
      "Sends the built-in Radicle node's traffic through Tor instead of connecting directly. " +
        "Cloning and syncing are slower. If Tor isn't running, the node doesn't connect rather " +
        'than going direct.'
    );
  });

  test('the toggle is named by the row label and described by its help', () => {
    const input = HTML.match(/<input\s[^>]*id="route-radicle-through-tor"[^>]*\/>/)[0];
    const attr = (name) => input.match(new RegExp(`${name}="([^"]*)"`))[1];
    expect(attr('aria-labelledby').split(' ').map(textOf).join(' ')).toBe(
      'Route Radicle through Tor'
    );
    expect(attr('aria-describedby')).toBe('route-radicle-through-tor-help');
  });

  test('with Tor on, it can be switched either way, under its default help', () => {
    for (const routed of [false, true]) {
      expect(row({ torOn: true, routed })).toEqual({
        disabled: false,
        rowDisabled: false,
        help: 'DEFAULT HELP',
      });
    }
  });

  test("with Tor on but not running, the routing on says Radicle doesn't connect; otherwise the default help", () => {
    expect(row({ torOn: true, routed: true, torRunning: false }).help).toBe(WAITING);
    for (const radicleMode of ['managed', null]) {
      expect(row({ torOn: true, routed: true, torRunning: false, radicleMode }).help).toBe(WAITING);
    }
    // A profile whose Radicle node is disabled has nothing to say it waits.
    expect(
      row({ torOn: true, routed: true, torRunning: false, radicleMode: 'disabled' }).help
    ).toBe('DEFAULT HELP');
    for (const [routed, torRunning] of [
      [true, true],
      [true, null],
      [false, false],
    ]) {
      expect(row({ torOn: true, routed, torRunning }).help).toBe('DEFAULT HELP');
    }
  });

  test('with Tor off, it cannot be switched on, and says where to turn Tor on', () => {
    expect(row({ torOn: false, routed: false })).toEqual({
      disabled: true,
      rowDisabled: true,
      help: 'Turn on Enable Tor (.onion access) above first.',
    });
  });

  test("with Tor off and the routing on, it stays switchable, and says Radicle doesn't connect", () => {
    expect(row({ torOn: false, routed: true })).toEqual({
      disabled: false,
      rowDisabled: false,
      help: "Tor is off, so the built-in Radicle node doesn't connect. Turn this off to connect directly, or turn on Enable Tor (.onion access) above.",
    });
  });

  test("Tor's state and the profile's Radicle backend are read while Advanced is shown, and repaint the row", () => {
    expect(SCRIPT).toContain('radicleMode = profile?.nodes?.radicle?.mode ?? null;');
    const refresh = SCRIPT.slice(SCRIPT.indexOf('const refreshTorState = async () => {'));
    expect(refresh.slice(0, refresh.indexOf('\n};\n'))).toContain('applyRouteRadicleRowState();');
  });

  test('the form saves and restores it as routeRadicleThroughTor, apart from IPFS, and repaints the row', () => {
    expect(SCRIPT).toContain("routeRadicle: $('route-radicle-through-tor'),");
    expect(SCRIPT).toContain('routeRadicleThroughTor: fields.routeRadicle.checked,');
    expect(SCRIPT).toContain(
      'fields.routeRadicle.checked = settings.routeRadicleThroughTor === true;'
    );
    const apply = SCRIPT.slice(SCRIPT.indexOf('const applyFormState = (settings) => {'));
    expect(apply.slice(0, apply.indexOf('\n};\n'))).toContain('applyRouteRadicleRowState();');
    // Enable Tor repaints it, and its own toggle saves at once.
    const enableTor = SCRIPT.slice(SCRIPT.indexOf("fields.enableTor.addEventListener('change'"));
    expect(enableTor.slice(0, enableTor.indexOf('\n});\n'))).toContain(
      'applyRouteRadicleRowState();'
    );
    const own = SCRIPT.slice(SCRIPT.indexOf("fields.routeRadicle.addEventListener('change'"));
    expect(own.slice(0, own.indexOf('\n});\n'))).toMatch(
      /applyRouteRadicleRowState\(\);\s+save\(\);/
    );
  });
});
