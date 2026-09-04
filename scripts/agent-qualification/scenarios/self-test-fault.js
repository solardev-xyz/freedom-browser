'use strict';

// Controlled-failure self-test. This scenario deliberately throws after enabling a workspace and
// launching one live managed process, so the runner's finally-based teardown can be validated on
// the failure path: the harness must terminate the live namespace process and remove the uniquely
// owned temporary fixture directory even though the scenario itself errored. It always exits
// non-zero (the injected failure), and the runner's cleanup diagnostic plus the cleanup-root,
// cleanup-survivors, and cleanup-errors assertions show whether teardown succeeded regardless.
//
// It is never part of ordinary `npm test`; run it only with the qualify-agent-workspace runner.

module.exports = {
  id: 'self-test-fault',
  title: 'Controlled-failure self-test for finally-based cleanup',
  survivorPattern: 'hb-fault',
  async run(ctx) {
    const { check, decisions, startRun, callTool, bashText } = ctx;

    const run1 = await startRun('Controlled failure to validate cleanup');
    decisions.push(true);
    const enable = await callTool(run1, 'bash', { command: 'printf enabled' });
    if (!bashText(enable).includes('enabled')) throw new Error('workspace enable failed');

    // Launch a long-lived yielded process so teardown must terminate a live sandbox namespace.
    const proc = await callTool(run1, 'bash', {
      command: 'printf ready; while :; do printf y >> hb-fault; sleep 0.2; done',
      yield_time_ms: 400,
    });
    check(
      'F0',
      'a live managed process is running before the injected failure',
      /workspace_process_[a-f0-9]{24}/.test(bashText(proc)),
      { text: bashText(proc).slice(0, 80) }
    );

    // Inject a deliberate failure. The runner's finally block must still tear everything down.
    const error = new Error('Injected controlled failure to validate finally-based cleanup');
    error.code = 'QUALIFICATION_SELF_TEST_FAULT';
    throw error;
  },
};
