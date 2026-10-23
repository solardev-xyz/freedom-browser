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

function loadApply({ fields, help, torRunning, ipfsMode, note }) {
  const start = SCRIPT.indexOf(START);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SCRIPT.indexOf(END, start);
  const body = SCRIPT.slice(start, end + END.length);
  const builtInNode = () => ipfsMode !== 'external' && ipfsMode !== 'disabled';
  const factory = new Function(
    'fields',
    'routeIpfsHelp',
    'defaultRouteIpfsHelp',
    'torRunning',
    'ipfsMode',
    'routeIpfsExternalNote',
    'builtInNode',
    `${body}\nreturn applyRouteIpfsRowState;`
  );
  return factory(fields, help, 'DEFAULT HELP', torRunning, ipfsMode, note, builtInNode);
}

function row({ torOn, routed, torRunning = null, ipfsMode = 'managed' }) {
  const classes = new Set();
  const fields = {
    enableTor: { checked: torOn },
    routeIpfs: {
      checked: routed,
      disabled: false,
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
    },
    routeIpfsRow: {
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    },
  };
  const help = { textContent: '' };
  const note = { hidden: true };
  loadApply({ fields, help, torRunning, ipfsMode, note })();
  return {
    disabled: fields.routeIpfs.disabled,
    rowDisabled: classes.has('disabled'),
    help,
    noteShown: !note.hidden,
    describedBy: fields.routeIpfs.attributes['aria-describedby'],
  };
}

describe('Route IPFS through Tor', () => {
  test('the row sits under Advanced with the Tor rows, a toggle of its own, with no restart', () => {
    const advanced = HTML.slice(HTML.indexOf('id="experimental"'), HTML.indexOf('id="about"'));
    const start = advanced.indexOf('id="route-ipfs-through-tor-row"');
    expect(start).toBeGreaterThan(advanced.indexOf('id="enable-tor-integration"'));
    const markup = advanced.slice(start, advanced.indexOf('</div>\n          </div>', start));
    expect(markup).toContain('data-tor');
    expect(markup).toContain('Route IPFS through Tor');
    expect(markup).toMatch(/<input\s+type="checkbox"\s+id="route-ipfs-through-tor"\s/);
    expect(markup).not.toMatch(/restart/i);
  });

  test("its copy is the built-in node's: what it costs, and that it fails closed", () => {
    const start = HTML.indexOf('id="route-ipfs-through-tor-help"');
    const help = HTML.slice(start, HTML.indexOf('</p>', start)).replace(/\s+/g, ' ');
    expect(help).toContain("Sends the built-in IPFS node's traffic through Tor");
    expect(help).toContain('Content loads more slowly');
    expect(help).toContain('only through delegated routing, without QUIC');
    expect(help).toContain(
      "If Tor isn't running, the node doesn't connect rather than going direct."
    );
  });

  test('an external gateway is said not to be covered, and nothing more', () => {
    const start = HTML.indexOf('id="route-ipfs-external-note"');
    const markup = HTML.slice(start, HTML.indexOf('</p>', start));
    expect(markup).toContain('hidden');
    expect(markup.replace(/\s+/g, ' ')).toContain(
      "This profile uses an external IPFS gateway, which this setting doesn't cover."
    );
    expect(row({ torOn: true, routed: true, ipfsMode: 'external' }).noteShown).toBe(true);
    expect(row({ torOn: true, routed: false, ipfsMode: 'external' }).noteShown).toBe(true);
    for (const ipfsMode of ['managed', 'disabled', null]) {
      expect(row({ torOn: true, routed: true, ipfsMode }).noteShown).toBe(false);
    }
    // The built-in node isn't what serves it, so nothing is said to wait.
    for (const ipfsMode of ['external', 'disabled']) {
      expect(row({ torOn: true, routed: true, torRunning: false, ipfsMode }).help.textContent).toBe(
        'DEFAULT HELP'
      );
    }
    expect(SCRIPT).toContain(
      "const builtInNode = () => ipfsMode !== 'external' && ipfsMode !== 'disabled';"
    );
  });

  test('the toggle is named by the row label and described by its help', () => {
    const input = HTML.match(/<input\s[^>]*id="route-ipfs-through-tor"[^>]*\/>/)[0];
    const attr = (name) => input.match(new RegExp(`${name}="([^"]*)"`))[1];
    const textOf = (id) => {
      const start = HTML.indexOf(`id="${id}"`);
      const open = HTML.indexOf('>', start) + 1;
      const close = HTML.indexOf('</', open);
      return HTML.slice(open, close).replace(/\s+/g, ' ').trim();
    };
    // Its accessible name: the label's text, and nothing else.
    expect(attr('aria-labelledby').split(' ').map(textOf).join(' ')).toBe('Route IPFS through Tor');
    // Its accessible description, as the row sets it for each backend:
    // the external note is part of it only with an external gateway, since
    // hidden text a description names is still read out.
    const description = (ids) => ids.split(' ').map(textOf).join(' ');
    const help = textOf('route-ipfs-through-tor-help');
    const note = textOf('route-ipfs-external-note');
    expect(description(attr('aria-describedby'))).toBe(help);
    for (const ipfsMode of ['managed', 'disabled', null]) {
      expect(description(row({ torOn: true, routed: true, ipfsMode }).describedBy)).toBe(help);
    }
    expect(description(row({ torOn: true, routed: true, ipfsMode: 'external' }).describedBy)).toBe(
      `${help} ${note}`
    );
    expect(note).toBe(
      "This profile uses an external IPFS gateway, which this setting doesn't cover."
    );
  });

  test('with Tor on, it can be switched either way, under its default help', () => {
    for (const routed of [false, true]) {
      expect(row({ torOn: true, routed })).toEqual({
        disabled: false,
        rowDisabled: false,
        help: { textContent: 'DEFAULT HELP' },
        noteShown: false,
        describedBy: 'route-ipfs-through-tor-help',
      });
    }
  });

  test('with Tor on but not running, the routing on says IPFS is waiting for it; otherwise the default help', () => {
    expect(row({ torOn: true, routed: true, torRunning: false }).help.textContent).toBe(
      "The built-in IPFS node is waiting for Tor, and connects once it's running. Start Tor from the Nodes menu, or turn this off to connect directly."
    );
    for (const [routed, torRunning] of [
      [true, true],
      [true, null],
      [false, false],
    ]) {
      expect(row({ torOn: true, routed, torRunning }).help.textContent).toBe('DEFAULT HELP');
    }
  });

  test("Tor's state is read while Advanced is shown, and repaints the row", () => {
    expect(SCRIPT).toContain("setTorStateRefreshActive(section === 'advanced');");
    expect(SCRIPT).toContain('torRunning = registry ? Boolean(registry.tor?.socks) : null;');
    expect(SCRIPT).toContain('ipfsMode = profile?.nodes?.ipfs?.mode ?? null;');
    const refresh = SCRIPT.slice(SCRIPT.indexOf('const refreshTorState = async () => {'));
    expect(refresh.slice(0, refresh.indexOf('\n};\n'))).toContain('applyRouteIpfsRowState();');
  });

  test('with Tor off, it cannot be switched on, and says where to turn Tor on', () => {
    expect(row({ torOn: false, routed: false })).toEqual({
      disabled: true,
      rowDisabled: true,
      help: { textContent: 'Turn on Enable Tor (.onion access) above first.' },
      noteShown: false,
      describedBy: 'route-ipfs-through-tor-help',
    });
  });

  test('with Tor off and the routing on, it stays switchable, and says IPFS does not connect', () => {
    expect(row({ torOn: false, routed: true })).toEqual({
      disabled: false,
      rowDisabled: false,
      help: {
        textContent:
          "Tor is off, so the built-in IPFS node doesn't connect. Turn this off to connect directly, or turn on Enable Tor (.onion access) above.",
      },
      noteShown: false,
      describedBy: 'route-ipfs-through-tor-help',
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
