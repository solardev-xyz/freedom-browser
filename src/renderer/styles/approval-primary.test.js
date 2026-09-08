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
