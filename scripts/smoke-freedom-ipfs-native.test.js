const { fetchLiveWithRetry } = require('./smoke-freedom-ipfs-native');

function fakeNode(responses) {
  const calls = [];
  return {
    calls,
    isHealthy: () => true,
    request: async (req) => {
      calls.push(req.path);
      const next = responses.shift();
      return new Response(next.body, { status: next.status });
    },
  };
}

describe('fetchLiveWithRetry', () => {
  const base = { smokePath: '/ipfs/x', expectedText: '', label: 'live page', attempts: 5 };

  // budgetMs: 0 pins the case a tiny FREEDOM_IPFS_NATIVE_SMOKE_BUDGET_MS reaches
  // nondeterministically: the deadline has already passed at loop start.
  test('still makes the first attempt when the budget is already spent', async () => {
    const node = fakeNode([{ status: 200, body: 'hello' }]);
    const result = await fetchLiveWithRetry(node, { ...base, budgetMs: 0 });
    expect(node.calls).toEqual(['/ipfs/x']);
    expect(result.page).toMatchObject({ status: 200, attempt: 1 });
  });

  test('a network failure on a tiny budget is reported with one real attempt, not zero', async () => {
    const node = fakeNode([{ status: 504, body: 'timeout' }]);
    const result = await fetchLiveWithRetry(node, { ...base, budgetMs: 0 });
    expect(node.calls).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.summary).toMatch(/after 1 attempt\(s\)/);
  });
});
