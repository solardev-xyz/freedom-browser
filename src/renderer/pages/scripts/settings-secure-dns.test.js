/**
 * Settings → Privacy and security → Secure DNS page script (#472). The script
 * exports its helpers when `module` exists (Jest) and only wires the DOM in
 * the page.
 */

const {
  SECURE_DNS_MODE_HELP,
  isValidDohTemplate,
  secureDnsView,
  renderSecureDns,
  secureDnsWaitingMessage,
  secureDnsInvalidMessage,
} = require('./settings-secure-dns.js');
const {
  createAppMock,
  loadMainModule,
} = require('../../../../test/helpers/main-process-test-utils');

const el = () => {
  const classes = new Set();
  return {
    value: '',
    hidden: false,
    disabled: false,
    textContent: '',
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
};

const makeEls = () => ({
  mode: el(),
  modeHelp: el(),
  provider: el(),
  providerRow: el(),
  customRow: el(),
  custom: el(),
});

const CUSTOM = 'https://doh.example.org/dns-query';

describe('Settings → Privacy and security → Secure DNS', () => {
  test('the defaults: Automatic with Quad9, no address row', () => {
    const view = secureDnsView({ secureDnsMode: 'automatic', secureDnsProvider: 'quad9' });
    expect(view).toMatchObject({
      mode: 'automatic',
      provider: 'quad9',
      inUse: 'Quad9',
      providerDisabled: false,
      customVisible: false,
    });
    expect(view.modeHelp).toBe(SECURE_DNS_MODE_HELP.automatic);
    // Missing or unknown values read as the defaults main falls back to.
    expect(secureDnsView(null)).toMatchObject({ mode: 'automatic', provider: 'quad9' });
    expect(secureDnsView({ secureDnsMode: 'x', secureDnsProvider: 'y' })).toMatchObject({
      mode: 'automatic',
      provider: 'quad9',
    });
  });

  test('every mode has its own line, and Strict says what it costs', () => {
    expect(Object.keys(SECURE_DNS_MODE_HELP)).toEqual(['automatic', 'secure', 'off']);
    expect(SECURE_DNS_MODE_HELP.secure).toMatch(/won't load/);
    expect(SECURE_DNS_MODE_HELP.automatic).toMatch(/network's DNS/);
  });

  test('Off greys out the provider rows but keeps them in view', () => {
    const els = makeEls();
    renderSecureDns(
      els,
      secureDnsView({
        secureDnsMode: 'off',
        secureDnsProvider: 'custom',
        secureDnsCustomTemplate: CUSTOM,
      })
    );
    expect(els.mode.value).toBe('off');
    expect(els.provider.disabled).toBe(true);
    expect(els.providerRow.classList.contains('disabled')).toBe(true);
    expect(els.customRow.hidden).toBe(false);
    expect(els.custom.disabled).toBe(true);
    expect(els.custom.value).toBe(CUSTOM);
  });

  test('choosing Custom without a saved address shows the field and keeps the provider in use', () => {
    const stored = {
      secureDnsMode: 'secure',
      secureDnsProvider: 'mullvad',
      secureDnsCustomTemplate: '',
    };
    const view = secureDnsView(stored, { draftCustom: true });
    expect(view).toMatchObject({ provider: 'custom', customVisible: true, inUse: 'Mullvad' });
    expect(secureDnsWaitingMessage(view)).toBe(
      "Enter the provider's address to switch to it. Mullvad stays in use until then."
    );
    expect(secureDnsInvalidMessage(view)).toBe(
      "That isn't an https:// address Freedom can use. Mullvad stays in use."
    );
    // A custom provider already in use names its saved address instead.
    expect(
      secureDnsInvalidMessage(
        secureDnsView({ secureDnsProvider: 'custom', secureDnsCustomTemplate: CUSTOM })
      )
    ).toBe("That isn't an https:// address Freedom can use. The saved address stays in use.");
  });

  test('a repaint leaves an address being typed alone', () => {
    const els = makeEls();
    els.custom.value = 'https://half-typed';
    renderSecureDns(
      els,
      secureDnsView({ secureDnsProvider: 'custom', secureDnsCustomTemplate: CUSTOM }),
      { keepCustomInput: true }
    );
    expect(els.custom.value).toBe('https://half-typed');
    renderSecureDns(
      els,
      secureDnsView({ secureDnsProvider: 'custom', secureDnsCustomTemplate: CUSTOM })
    );
    expect(els.custom.value).toBe(CUSTOM);
  });
});

// The page decides what to say inline; main decides what is stored. The two
// checks have to agree, or the page would call an address fine that main
// then silently keeps out (or the other way round).
describe('isValidDohTemplate parity (renderer vs main)', () => {
  const app = { ...createAppMock(), configureHostResolver: jest.fn() };
  const { mod: main } = loadMainModule(require.resolve('../../../main/secure-dns'), {
    app,
    extraMocks: {
      [require.resolve('../../../main/logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  });

  test.each([
    CUSTOM,
    `  ${CUSTOM}  `,
    `${CUSTOM}{?dns}`,
    'https://192.168.1.2:8443/dns-query',
    'https://[2620:fe::fe]/dns-query',
    'http://doh.example.org/dns-query',
    'doh.example.org/dns-query',
    'https://',
    'https://user:pass@doh.example.org/dns-query',
    'https://doh.example.org/dns-query#x',
    'https://doh.example.org/dns query',
    'https://doh.example.org/{name}',
    `https://doh.example.org/${'a'.repeat(2048)}`,
    '',
    null,
  ])('%j', (input) => {
    expect(isValidDohTemplate(input)).toBe(main.normalizeDohTemplate(input) !== null);
  });
});
