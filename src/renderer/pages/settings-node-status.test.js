/**
 * Settings → Nodes: each node row reads its own service from the registry
 * (Codex round 1 on #1382). The profile names the Swarm node `bee`, but the
 * service registry names its service `ant` (src/main/service-registry.js
 * `getRegistry`), so the Swarm row has to look under `ant`: under `bee` it
 * found nothing, always said "Not running", and never saw a reused node,
 * whose "Verify content from this node" switch then never showed.
 *
 * As the other Settings tests do, the helpers are lifted out of the shipped
 * page script and evaluated, so the assertions are on the real code.
 */

const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');

function lift(start, end) {
  const from = SCRIPT.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = SCRIPT.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SCRIPT.slice(from, to + end.length);
}

function loadHelpers() {
  const body = [
    lift('const PROFILE_NODE_SERVICES = [', '\n];\n'),
    lift('const registryServiceFor = ', ';\n'),
    lift('const statusLabel = (service) => {', '\n};\n'),
    lift('const showsVerifySetting = ', ';\n'),
  ].join('\n');
  return new Function(
    `${body}\nreturn { PROFILE_NODE_SERVICES, registryServiceFor, statusLabel, showsVerifySetting };`
  )();
}

// The registry as main sends it (service-registry.js getRegistry).
const registry = (ant) => ({
  ipfs: { mode: 'bundled', statusMessage: 'Running' },
  myotis: { mode: 'none' },
  ant,
  radicle: { mode: 'none' },
  tor: { mode: 'none', socks: null },
});

describe("Settings > Nodes: each row's status from the registry", () => {
  test("the Swarm row reads the registry's ant service", () => {
    const { PROFILE_NODE_SERVICES, registryServiceFor, statusLabel } = loadHelpers();
    const swarm = PROFILE_NODE_SERVICES.find((definition) => definition.protocol === 'bee');
    expect(swarm.registryKey).toBe('ant');
    const external = { api: 'https://ant.example:1633', mode: 'external', statusMessage: 'External node: ant.example:1633' };
    expect(registryServiceFor(registry(external), swarm)).toBe(external);
    expect(statusLabel(registryServiceFor(registry(external), swarm))).toBe('External node: ant.example:1633');
    expect(statusLabel(registryServiceFor(registry({ mode: 'bundled', statusMessage: null }), swarm))).toBe(
      'Bundled'
    );
    // Not running only when the ant service says so.
    expect(statusLabel(registryServiceFor(registry({ mode: 'none' }), swarm))).toBe('Not running');
  });

  test('a reused Swarm node is seen, so its verification switch shows under "Managed by Freedom"', () => {
    const { PROFILE_NODE_SERVICES, registryServiceFor, showsVerifySetting } = loadHelpers();
    const swarm = PROFILE_NODE_SERVICES.find((definition) => definition.protocol === 'bee');
    const service = registryServiceFor(registry({ mode: 'reused', api: 'http://127.0.0.1:1633' }), swarm);
    expect(service.mode === 'reused').toBe(true);
    expect(showsVerifySetting(swarm, 'managed', service.mode === 'reused')).toBe(true);
  });

  test('the other rows still read their own protocol, and a missing registry reads as nothing', () => {
    const { PROFILE_NODE_SERVICES, registryServiceFor, statusLabel } = loadHelpers();
    const ipfs = PROFILE_NODE_SERVICES.find((definition) => definition.protocol === 'ipfs');
    expect(statusLabel(registryServiceFor(registry({ mode: 'none' }), ipfs))).toBe('Running');
    for (const definition of PROFILE_NODE_SERVICES) {
      expect(registryServiceFor(null, definition)).toEqual({});
      if (definition.protocol !== 'bee') expect(definition.registryKey).toBeUndefined();
    }
  });

  test('the rows render from that lookup', () => {
    expect(SCRIPT).toContain('    const service = registryServiceFor(registry, definition);\n');
    expect(SCRIPT).not.toContain('registry?.[protocol]');
  });
});
