const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, 'services.css'), 'utf8');
const menuCss = fs.readFileSync(path.join(__dirname, 'menus.css'), 'utf8');

describe('TON service disabled state', () => {
  test('keeps the label opaque and dims only the unavailable switch', () => {
    const rowRule = css.match(/\.ton-toggle\.disabled\s*{([^}]*)}/)?.[1] || '';
    const switchRules = [
      ...css.matchAll(/\.ton-toggle\.disabled \.ton-toggle-switch\s*{([^}]*)}/g),
    ].map((match) => match[1]);

    expect(rowRule).not.toMatch(/opacity\s*:/);
    expect(rowRule).toMatch(/pointer-events\s*:\s*none/);
    expect(switchRules.some((rule) => /opacity\s*:\s*0\.4/.test(rule))).toBe(true);
  });

  test('overrides the generic disabled menu treatment', () => {
    const genericRule = menuCss.match(/\.menu-item:disabled\s*{([^}]*)}/)?.[1] || '';
    const tonRule = css.match(/\.ton-toggle\.menu-item:disabled\s*{([^}]*)}/)?.[1] || '';

    expect(genericRule).toMatch(/color\s*:\s*var\(--muted\)/);
    expect(genericRule).toMatch(/opacity\s*:\s*0\.62/);
    expect(tonRule).toMatch(/color\s*:\s*var\(--text\)/);
    expect(tonRule).toMatch(/opacity\s*:\s*1/);
  });
});
