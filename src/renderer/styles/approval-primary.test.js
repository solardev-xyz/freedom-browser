/**
 * Every approval screen in the sidebar shares one primary button (#239).
 *
 * `docs/agent-playbooks/ui-consistency.md`: "Primary action filled `--accent`,
 * secondary outlined". The wallet and dApp approvals followed that — Confirm,
 * Sign, Connect — while the four Swarm approvals (Swarm Access, Confirm
 * Publish, Confirm Message, Feed Access) filled their primary `#f59e0b`. Two
 * prompts for the same class of decision, in the same sidebar, in two
 * different colours, with the orange one reading as the more alarming.
 *
 * The regression this guards is a *new* approval screen arriving with its own
 * fill, not just those four buttons: it sweeps every chrome stylesheet for an
 * approve/confirm button that paints itself amber at rest, the same shape as
 * `destructive-buttons.test.js`'s danger sweep.
 */

const fs = require('fs');
const path = require('path');

const STYLES_DIR = __dirname;

const sheets = fs
  .readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();

const read = (name) => fs.readFileSync(path.join(STYLES_DIR, name), 'utf8');

/** Flat `selector { body }` pairs. The chrome sheets are not nested. */
const rulesOf = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/\s+/g, ' '),
    body: match[2],
  }));

const declaration = (body, property) => {
  const match = body.match(new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`));
  return match ? match[1].trim() : null;
};

const background = (body) =>
  declaration(body, 'background') || declaration(body, 'background-color');

// The amber the Swarm primaries used, plus its hover shade and the `--warning-fg`
// token. A callout keeps painting itself amber; a button must not.
const AMBER = /var\(--warning-fg\b|#f59e0b|#d97706|#d29922/i;

// A resting state is anything that is not a user-driven state selector.
const STATEFUL = /:(hover|active|focus|focus-visible|checked|target)\b/;

const isButton = (selector) => /(^|[\s.#>+~])[^\s,]*(btn|button)/i.test(selector);

describe('approval primaries (#239)', () => {
  test('no button fills itself amber at rest', () => {
    const offenders = [];
    for (const sheet of sheets) {
      for (const rule of rulesOf(read(sheet))) {
        const fill = background(rule.body);
        if (!fill || !AMBER.test(fill)) continue;
        for (const selector of rule.selector.split(',').map((part) => part.trim())) {
          if (!isButton(selector) || STATEFUL.test(selector)) continue;
          offenders.push(`${sheet}: ${selector} { background: ${fill} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the detector still fires on the fill the Swarm screens shipped', () => {
    // Mutation check: the sweep above passes today, so prove it would fail if
    // the orange primary came back.
    const rule = rulesOf('.swarm-connect-approve-btn { background: #f59e0b; color: #fff; }')[0];
    expect(isButton(rule.selector)).toBe(true);
    expect(AMBER.test(background(rule.body))).toBe(true);
  });

  // A fill is not the only way back to orange. The dead Feed Access rules #239
  // deleted tinted a radio (`accent-color`), a checked border and a link-style
  // button's text — none of which the fill sweep above would have seen. These
  // are the remaining amber-carrying properties on an interactive control.
  const TINTS = ['accent-color', 'color', 'border-color', 'border', 'outline-color'];

  test('no control tints itself amber at rest either', () => {
    const offenders = [];
    for (const sheet of sheets) {
      for (const rule of rulesOf(read(sheet))) {
        for (const property of TINTS) {
          const value = declaration(rule.body, property);
          if (!value || !AMBER.test(value)) continue;
          for (const selector of rule.selector.split(',').map((part) => part.trim())) {
            if (STATEFUL.test(selector)) continue;
            // `accent-color` only ever paints a form control, so it needs no
            // button check; the rest are amber on plain text or a callout glyph
            // unless they land on a button.
            if (property !== 'accent-color' && !isButton(selector)) continue;
            offenders.push(`${sheet}: ${selector} { ${property}: ${value} }`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the tint detector fires on the Feed Access rules #239 deleted', () => {
    // Mutation check: these two are verbatim the dead rules, and both trip.
    const cases = [
      [
        '.swarm-feed-identity-option input[type="radio"] { accent-color: #f59e0b; }',
        'accent-color',
      ],
      ['.swarm-feed-manage-btn { color: #f59e0b; }', 'color'],
    ];
    for (const [css, property] of cases) {
      const rule = rulesOf(css)[0];
      expect(AMBER.test(declaration(rule.body, property))).toBe(true);
      expect(property === 'accent-color' || isButton(rule.selector)).toBe(true);
      expect(STATEFUL.test(rule.selector)).toBe(false);
    }

    // The third deleted rule, `.swarm-feed-identity-option:has(input:checked) {
    // border-color: #f59e0b }`, is deliberately *not* covered: it is a state
    // selector on a non-button, and flagging every amber `border-color` in that
    // shape would sweep up legitimate callout borders. It cannot arrive alone —
    // it styles the same radio list as the `accent-color` rule above, which does
    // trip — so the pair is caught through its sibling.
    const checked = rulesOf(
      '.swarm-feed-identity-option:has(input:checked) { border-color: #f59e0b; }'
    )[0];
    expect(STATEFUL.test(checked.selector)).toBe(true);
  });

  test('the Swarm primary fills --accent, like the dApp primaries it sits next to', () => {
    const sidebar = rulesOf(read('sidebar.css'));
    const fillOf = (selector) => {
      const rule = sidebar.find((entry) => entry.selector === selector);
      expect(rule).toBeDefined();
      return background(rule.body);
    };

    const swarm = fillOf('.swarm-connect-approve-btn');
    expect(swarm).toMatch(/var\(--accent\b/);
    expect(fillOf('.dapp-tx-approve-btn')).toBe(swarm);
    expect(fillOf('.dapp-sign-approve-btn')).toBe(swarm);
    expect(fillOf('.dapp-connect-approve-btn')).toBe(swarm);
  });

  test('the Swarm secondary stays outlined, like the dApp secondaries', () => {
    const sidebar = rulesOf(read('sidebar.css'));
    const ruleFor = (selector) => sidebar.find((entry) => entry.selector === selector);

    const reject = ruleFor('.swarm-connect-reject-btn');
    expect(reject).toBeDefined();
    expect(background(reject.body)).toBe('var(--toolbar)');
    expect(declaration(reject.body, 'border-color')).toBe('var(--border)');

    const dappReject = ruleFor('.dapp-tx-reject-btn');
    expect(background(dappReject.body)).toBe('var(--toolbar)');
  });

  test('the two callout kinds match their dApp originals', () => {
    const sidebar = rulesOf(read('sidebar.css'));
    const ruleFor = (selector) => sidebar.find((entry) => entry.selector === selector);

    // Warning: amber, like the dApp transaction screen.
    expect(background(ruleFor('.swarm-connect-warning, .swarm-connect-note').body)).toBe(
      background(ruleFor('.dapp-tx-warning').body)
    );
    expect(
      declaration(ruleFor('.swarm-connect-warning svg, .swarm-connect-note svg').body, 'color')
    ).toBe('#f59e0b');

    // Informational: blue, like the dApp sign screen.
    expect(background(ruleFor('.swarm-connect-note').body)).toBe(
      background(ruleFor('.dapp-sign-warning').body)
    );
    expect(declaration(ruleFor('.swarm-connect-note svg').body, 'color')).toBe(
      declaration(ruleFor('.dapp-sign-warning svg').body, 'stroke')
    );
  });
});
