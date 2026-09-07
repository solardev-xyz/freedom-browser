/**
 * Where a settings text field is allowed to live (#234).
 *
 * `.rpc-input` is the settings page's one text-field class, and it sizes
 * itself with `flex: 1`. That does nothing outside a flex container: an input
 * dropped straight into a `.rpc-block` falls back to the intrinsic ~190px of
 * a default `<input>` and truncates its value. That is exactly what happened
 * to the Colibri prover-endpoint field, which rendered wide on Settings >
 * Name Resolution (inside `.resolver-config-line`, a flex row) and narrow on
 * the chain-detail page — the same field, the same class, two sizes.
 *
 * The bug is invisible in the stylesheet and invisible in the markup unless
 * you know what `.rpc-block`'s display is, so it is guarded here instead: for
 * every `.rpc-input` the page ships, resolve the element that actually
 * contains it and check it against the small set of wrappers that are known
 * to give it a width. Most of the markup is built in template literals inside
 * `<script>`, so this works on the source text rather than a parsed DOM —
 * jsdom would not see the chain-detail page at all.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

// Containers a `.rpc-input` may sit in. Each establishes a flex or grid
// formatting context, so the input's `flex: 1` (or the track it is placed in)
// gives it a width. `row-control` is the deliberate exception: those fields
// (the ad-block allow-list entry, the profile name) share their row with a
// button and are meant to stay at their natural width.
const SIZING_WRAPPERS = [
  'rpc-row',
  'resolver-config-line',
  'search-provider-fields',
  'shortcut-toolbar',
  'profile-node-field',
];
const INTRINSIC_WRAPPERS = ['row-control'];

/**
 * The class attribute of the element that directly contains `index`.
 *
 * Walks the `<div>` tags backwards counting closes, so a preceding *sibling*
 * block — `<div class="row-body">…</div><input …>`, which is exactly how the
 * Name Resolution prover field is written — is skipped rather than mistaken
 * for the parent.
 */
function parentClassOf(html, index) {
  const tags = [...html.slice(0, index).matchAll(/<(\/?)div\b([^>]*)>/g)];
  let depth = 0;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const [, slash, attrs] = tags[i];
    if (slash) {
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
    } else {
      return (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    }
  }
  return null;
}

const rpcInputWrappers = (html) =>
  [...html.matchAll(/class="[^"]*\brpc-input\b[^"]*"/g)].map((match) => ({
    line: html.slice(0, match.index).split('\n').length,
    wrapper: parentClassOf(html, match.index),
  }));

// Which selectors the stylesheet actually declares `display: flex` or
// `display: grid` on, so the allow-list above cannot quietly outlive the
// rules it names.
function sizingSelectors(html) {
  const css = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)[1];
  const found = new Set();
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*(?:flex|grid)/.test(body)) continue;
    for (const selector of prelude.replace(/\/\*[\s\S]*?\*\//g, '').split(',')) {
      const trimmed = selector.trim();
      if (trimmed) found.add(trimmed);
    }
  }
  return found;
}

describe('settings.html text-field layout', () => {
  const inputs = rpcInputWrappers(SOURCE);

  test('the page ships the fields this guard is about', () => {
    expect(inputs.length).toBeGreaterThan(10);
    // Both Colibri prover-endpoint fields — the pair the issue is about.
    expect(SOURCE).toContain('data-chain-prover=');
    expect(SOURCE).toContain('id="ens-prover-url"');
  });

  test('every .rpc-input sits in a container that sizes it', () => {
    const allowed = [...SIZING_WRAPPERS, ...INTRINSIC_WRAPPERS];
    const stray = inputs.filter(
      ({ wrapper }) =>
        wrapper === null || !allowed.some((name) => String(wrapper).split(/\s+/).includes(name))
    );
    expect(stray).toEqual([]);
  });

  test('both Colibri prover-endpoint fields sit in a flex row, so they match', () => {
    const proverWrappers = ['data-chain-prover=', 'id="ens-prover-url"'].map((needle) => {
      const at = SOURCE.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      return parentClassOf(SOURCE, at);
    });
    expect(proverWrappers).toEqual(['rpc-row', 'resolver-config-line']);

    const sizing = sizingSelectors(SOURCE);
    for (const wrapper of proverWrappers) {
      expect(sizing).toContain(`.${wrapper}`);
    }
  });

  test('every wrapper this guard allows really does size its children', () => {
    const sizing = sizingSelectors(SOURCE);
    for (const name of SIZING_WRAPPERS) {
      expect(sizing).toContain(`.${name}`);
    }
    // …and the exception genuinely does not, or it would not need naming.
    for (const name of INTRINSIC_WRAPPERS) {
      expect(sizing).not.toContain(`.${name}`);
    }
  });

  test('the parent resolver skips preceding siblings and catches a bare block', () => {
    // The shape the fix changed: an input dropped straight into a .rpc-block.
    const bare = '<div class="rpc-block"><input class="rpc-input" /></div>';
    expect(rpcInputWrappers(bare)).toEqual([{ line: 1, wrapper: 'rpc-block' }]);

    // The shape that made a naive "last <div> before the input" scan wrong.
    const sibling =
      '<div class="resolver-config-line"><div class="row-body"><p>x</p></div>' +
      '<input class="rpc-input" /></div>';
    expect(rpcInputWrappers(sibling)).toEqual([{ line: 1, wrapper: 'resolver-config-line' }]);
  });
});
