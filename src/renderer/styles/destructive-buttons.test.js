/**
 * Destructive buttons are outlined, never filled (#259).
 *
 * `docs/agent-playbooks/ui-consistency.md` (lands with #247): "Primary action
 * filled `--accent`, secondary outlined, destructive outlined `--danger`".
 * Every destructive control followed that — "Revoke auto-pay", "Clear All",
 * "Restore defaults", "Remove all" — except `.wallet-settings-delete-btn`,
 * which shipped a solid `--danger` fill. So the most destructive action in the
 * app (deleting a wallet) was the one styled as the screen's primary call to
 * action.
 *
 * The regression this guards is a *new* sibling arriving with a fill, not just
 * that one button: it sweeps every chrome stylesheet for a button whose
 * resting state paints itself in the danger colour.
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

// `--danger` in both palettes (variables.css), plus the two literal fallbacks
// still written inline in sidebar.css.
const DANGER = /var\(--danger\b|#f28b82|#d93025|#ef4444|#f85149/i;

// A resting state is anything that is not a user-driven state selector.
const STATEFUL = /:(hover|active|focus|focus-visible|checked|target)\b/;

const isButton = (selector) => /(^|[\s.#>+~])[^\s,]*(btn|button)/i.test(selector);

describe('destructive controls', () => {
  test('no button fills itself with the danger colour at rest', () => {
    const offenders = [];
    for (const sheet of sheets) {
      for (const rule of rulesOf(read(sheet))) {
        const fill = background(rule.body);
        if (!fill || !DANGER.test(fill)) continue;
        for (const selector of rule.selector.split(',').map((part) => part.trim())) {
          if (!isButton(selector) || STATEFUL.test(selector)) continue;
          offenders.push(`${sheet}: ${selector} { background: ${fill} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('Delete Wallet is outlined, like the Revoke auto-pay sibling it copies', () => {
    const sidebar = rulesOf(read('sidebar.css'));
    const ruleFor = (selector) => sidebar.find((rule) => rule.selector === selector);

    const remove = ruleFor('.wallet-settings-delete-btn');
    expect(remove).toBeDefined();
    expect(background(remove.body)).toBe('transparent');
    expect(declaration(remove.body, 'border')).toMatch(/1px solid var\(--danger/);
    expect(declaration(remove.body, 'color')).toMatch(/var\(--danger/);

    // Same shape as the destructive button that already followed the rule.
    const revoke = ruleFor('.perms-disconnect-btn');
    expect(background(revoke.body)).toBe('transparent');
    expect(declaration(revoke.body, 'border')).toMatch(/1px solid var\(--danger/);

    // Both invert on hover rather than dimming a fill. Delete Wallet carries
    // the sheet's `:not(:disabled)` guard because it is disabled for the main
    // wallet; `.perms-disconnect-btn` is never disabled and has no `:disabled`
    // rule, so it keeps the bare `:hover`.
    for (const selector of [
      '.wallet-settings-delete-btn:hover:not(:disabled)',
      '.perms-disconnect-btn:hover',
    ]) {
      const hover = ruleFor(selector);
      expect(hover).toBeDefined();
      expect(background(hover.body)).toMatch(DANGER);
      expect(declaration(hover.body, 'color')).toBe('#fff');
    }

    // The disabled main-wallet button must not pick up the inverted fill.
    expect(ruleFor('.wallet-settings-delete-btn:hover')).toBeUndefined();
  });

  test('the sweep can tell a filled button from an outlined one', () => {
    // Mutation check for the guard above: the shapes it must catch and the
    // ones it must leave alone.
    const probe = (css) =>
      rulesOf(css)
        .filter((rule) => {
          const fill = background(rule.body);
          return (
            fill && DANGER.test(fill) && isButton(rule.selector) && !STATEFUL.test(rule.selector)
          );
        })
        .map((rule) => rule.selector);

    expect(probe('.delete-btn { background: var(--danger); }')).toEqual(['.delete-btn']);
    expect(probe('.delete-button { background-color: #f85149; }')).toEqual(['.delete-button']);
    expect(probe('.delete-btn:hover { background: var(--danger); }')).toEqual([]);
    expect(probe('.delete-btn { background: transparent; }')).toEqual([]);
    expect(probe('.strength-fill.weak { background: var(--danger); }')).toEqual([]);
  });
});
