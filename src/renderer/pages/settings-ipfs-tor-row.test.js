/**
 * Settings → Advanced → "Route IPFS through Tor" (freedom-core design 0007,
 * "Where the proxy comes from"; step 8, B1).
 *
 * As settings-tor-rows.test.js does, the row's helper is lifted out of the
 * shipped page script and evaluated with its collaborators injected, so
 * the assertions are on the real code.
 */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');

const START = 'const applyRouteIpfsRowState = () => {';
const END = '\n};\n';

function loadApply({ fields, help }) {
  const start = SCRIPT.indexOf(START);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SCRIPT.indexOf(END, start);
  const body = SCRIPT.slice(start, end + END.length);
  const factory = new Function(
    'fields',
    'routeIpfsHelp',
    'defaultRouteIpfsHelp',
    `${body}\nreturn applyRouteIpfsRowState;`
  );
  return factory(fields, help, 'DEFAULT HELP');
}

function row({ torOn, routed }) {
  const classes = new Set();
  const fields = {
    enableTor: { checked: torOn },
    routeIpfs: { checked: routed, disabled: false },
    routeIpfsRow: {
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    },
  };
  const help = { textContent: '' };
  loadApply({ fields, help })();
  return { disabled: fields.routeIpfs.disabled, rowDisabled: classes.has('disabled'), help };
}

describe('Route IPFS through Tor', () => {
  test('the row sits under Advanced with the Tor rows, a toggle of its own, with no restart', () => {
    const advanced = HTML.slice(HTML.indexOf('id="experimental"'), HTML.indexOf('id="about"'));
    const start = advanced.indexOf('id="route-ipfs-through-tor-row"');
    expect(start).toBeGreaterThan(advanced.indexOf('id="enable-tor-integration"'));
    const markup = advanced.slice(start, advanced.indexOf('</div>\n          </div>', start));
    expect(markup).toContain('data-tor');
    expect(markup).toContain('Route IPFS through Tor');
    expect(markup).toContain('<input type="checkbox" id="route-ipfs-through-tor" />');
    expect(markup).not.toMatch(/restart/i);
  });

  test('its copy says what it costs, and that it fails closed', () => {
    const start = HTML.indexOf('id="route-ipfs-through-tor-help"');
    const help = HTML.slice(start, HTML.indexOf('</p>', start)).replace(/\s+/g, ' ');
    expect(help).toContain('Content loads more slowly');
    expect(help).toContain('only through delegated routing, without QUIC');
    expect(help).toContain("If Tor isn't running, IPFS doesn't connect rather than going direct.");
  });

  test('with Tor on, it can be switched either way, under its default help', () => {
    for (const routed of [false, true]) {
      expect(row({ torOn: true, routed })).toEqual({
        disabled: false,
        rowDisabled: false,
        help: { textContent: 'DEFAULT HELP' },
      });
    }
  });

  test('with Tor off, it cannot be switched on, and says where to turn Tor on', () => {
    expect(row({ torOn: false, routed: false })).toEqual({
      disabled: true,
      rowDisabled: true,
      help: { textContent: 'Turn on Enable Tor (.onion access) above first.' },
    });
  });

  test('with Tor off and the routing on, it stays switchable, and says IPFS does not connect', () => {
    expect(row({ torOn: false, routed: true })).toEqual({
      disabled: false,
      rowDisabled: false,
      help: {
        textContent:
          "Tor is off, so IPFS doesn't connect. Turn this off to connect directly, or turn on Enable Tor (.onion access) above.",
      },
    });
  });

  test('the form saves and restores it as routeIpfsThroughTor, and repaints the row', () => {
    expect(SCRIPT).toContain("routeIpfs: $('route-ipfs-through-tor'),");
    expect(SCRIPT).toContain('routeIpfsThroughTor: fields.routeIpfs.checked,');
    expect(SCRIPT).toContain('fields.routeIpfs.checked = settings.routeIpfsThroughTor === true;');
    const apply = SCRIPT.slice(SCRIPT.indexOf('const applyFormState = (settings) => {'));
    expect(apply.slice(0, apply.indexOf('\n};\n'))).toContain('applyRouteIpfsRowState();');
  });
});
