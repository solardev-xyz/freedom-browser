'use strict';

const { WORKLOADS, policyForWorkload } = require('./qualify-agent-sandbox');

describe('Linux sandbox qualification workloads', () => {
  test('runs node and npm workloads only through the approved process runtime', () => {
    const runtimeCommands = new Set(['node', 'npm']);
    for (const workload of WORKLOADS) {
      const needsRuntime = runtimeCommands.has(workload.command);
      expect({ name: workload.name, runtime: workload.runtime === true }).toEqual({
        name: workload.name,
        runtime: needsRuntime,
      });
    }
    expect(
      WORKLOADS.filter((workload) => workload.runtime).map((workload) => workload.name)
    ).toEqual(['focused-jest', 'lint', 'babel-transform']);
    const baseline = WORKLOADS.find((workload) => workload.name === 'inherited-descriptor-closure');
    expect(baseline.command).toBe('/usr/bin/python3');
    expect(baseline.runtime).toBeUndefined();
  });

  test('selects the runtime policy only for workloads that request it', () => {
    const policies = { baseline: { id: 'baseline' }, runtime: { id: 'runtime' } };

    expect(policyForWorkload({ command: '/usr/bin/python3' }, policies)).toBe(policies.baseline);
    expect(policyForWorkload({ command: 'node', runtime: true }, policies)).toBe(policies.runtime);
  });
});
