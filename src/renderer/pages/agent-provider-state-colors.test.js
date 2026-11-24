/**
 * "Connected" must read in one colour across the two Settings → AI provider
 * pages: the provider list's ✓ and the method page's "Connected" one click
 * later. Both live only in settings.html, which loads ai.css and never the
 * chrome's agent.css — so a rule for them in agent.css is dead and a restyle
 * made there would silently do nothing.
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Every `color` value declared by a top-level rule whose selector list
// contains `selector` exactly.
function colorsFor(css, selector) {
  const out = [];
  for (const [, prelude, body] of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const [, value] of body.matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) out.push(value.trim());
  }
  return out;
}

describe('provider connected-state colour', () => {
  const aiCss = read('styles/ai.css');

  test('the list ✓ and the method-row "Connected" share the status green', () => {
    expect(colorsFor(aiCss, '#providers .agent-provider-indicator.active')).toEqual(['var(--success)']);
    expect(colorsFor(aiCss, '#providers .agent-provider-method-state.active')).toEqual(['var(--success)']);
  });

  test('settings.html does not load agent.css, and agent.css keeps no dead rules for these rows', () => {
    const html = read('settings.html');
    expect(html).toMatch(/href="styles\/ai\.css"/);
    expect(html).not.toMatch(/agent\.css|styles\.css"/);
    expect(read('../index.html')).not.toMatch(/agent-provider-(indicator|method-state)/);
    expect(read('../styles/agent.css')).not.toMatch(/\.agent-provider-(indicator|method-state)\b/);
  });
});
