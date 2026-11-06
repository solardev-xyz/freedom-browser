/**
 * Settings → Nodes → "Load only verified content from external nodes"
 * (freedom-core design 0009, "Strict mode"; decision 2): one switch for the
 * profile, beside the nodes' own "Verify content from this node", off by
 * default, saved as `loadOnlyVerifiedContent` with no restart. Main reads it
 * when a request's backend is captured (src/main/dweb/strict-mode.js).
 */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');

const nodesSection = () => {
  const start = HTML.indexOf('<section class="section panel" id="nodes"');
  expect(start).toBeGreaterThanOrEqual(0);
  return HTML.slice(start, HTML.indexOf('</section>', start));
};

describe('Load only verified content from external nodes', () => {
  test('the switch sits in Nodes, right under the nodes and their verification switches', () => {
    const nodes = nodesSection();
    const row = nodes.indexOf('id="load-only-verified-row"');
    expect(row).toBeGreaterThan(nodes.indexOf('id="profile-nodes-card"'));
    expect(row).toBeGreaterThan(nodes.indexOf('id="profile-nodes-status"'));
    expect(row).toBeLessThan(nodes.indexOf('id="swarm-publishing-row"'));
    const markup = nodes.slice(row, nodes.indexOf('id="swarm-publishing-row"'));
    expect(markup).toContain(
      '<label for="load-only-verified">Load only verified content from external nodes</label>'
    );
    expect(markup).toMatch(/<input\s+type="checkbox"\s+id="load-only-verified"\s/);
    // No `checked`: off by default, until the profile's settings say so.
    expect(markup).not.toMatch(/id="load-only-verified"[^>]*checked/);
    expect(markup).not.toMatch(/restart/i);
  });

  test('its help says what stops loading, and that the bundled nodes are untouched', () => {
    const start = HTML.indexOf('id="load-only-verified-help"');
    const help = HTML.slice(start, HTML.indexOf('</p>', start)).replace(/\s+/g, ' ');
    for (const words of [
      "that Freedom can't verify doesn't load, and the page says why",
      "a node whose verification is off or a gateway that can't be verified",
      'a DNSLink name',
      "an IPNS name whose key type can't be checked",
      'an encrypted Swarm reference',
      "Freedom's own nodes aren't affected",
    ]) {
      expect(help).toContain(words);
    }
  });

  test('the form saves and restores it as loadOnlyVerifiedContent, on only for true', () => {
    expect(SCRIPT).toContain("loadOnlyVerified: $('load-only-verified'),");
    expect(SCRIPT).toContain('loadOnlyVerifiedContent: fields.loadOnlyVerified.checked,');
    expect(SCRIPT).toContain(
      'fields.loadOnlyVerified.checked = settings.loadOnlyVerifiedContent === true;'
    );
    // Saved the moment it changes, as the other switches are.
    expect(SCRIPT).toContain("fields.loadOnlyVerified.addEventListener('change', save);");
  });
});
