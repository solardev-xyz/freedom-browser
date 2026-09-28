jest.mock('./ppv2-deposit-policy', () => ({ ARTIFACTS: [], validWitness: () => true, validProof: () => true }));
jest.mock('./ppv2-ragequit-policy', () => ({ ARTIFACTS: [], validWitness: () => true }));
jest.mock('./ppv2-transact-policy', () => ({ ARTIFACTS: [], validWitness: () => true }));
const mockExecute = jest.fn();
jest.mock('/unreviewed/sdk.cjs', () => { mockExecute(); return {}; }, { virtual: true });
test.each(['deposit', 'ragequit', 'transact'])('%s job rejects unreviewed code before requiring it', async (kind) => {
  await expect(require(`./ppv2-${kind}-job`).run({ sdkEntry: '/unreviewed/sdk.cjs', proverEntry: '/unreviewed/prover.cjs' }, {}))
    .rejects.toMatchObject({ code: 'PRIVATE_PPV2_RUNTIME_INVALID' });
  expect(mockExecute).not.toHaveBeenCalled();
});
