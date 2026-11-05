const { carryOverPrompt } = require('./agent-carry-over');

describe('carryOverPrompt', () => {
  test('a single failed turn carries only its request', () => {
    expect(carryOverPrompt([{ userText: ' Summarize this page ', assistantText: '' }]))
      .toBe('Summarize this page');
  });

  test('earlier turns travel with the failed request so the new chat keeps the context', () => {
    expect(carryOverPrompt([
      { userText: 'My budget is 40 euros.', assistantText: 'Noted, 40 euros.' },
      { userText: 'Which of these fits?', assistantText: 'partial failed answer' },
    ])).toBe([
      'Continue from this earlier conversation:',
      'User: My budget is 40 euros.\n\nAssistant: Noted, 40 euros.',
      'Request: Which of these fits?',
    ].join('\n\n'));
  });

  test('drops the oldest exchanges first and says so when the context is too long', () => {
    const turns = [
      { userText: 'old '.repeat(50), assistantText: 'reply' },
      { userText: 'recent', assistantText: 'recent reply' },
      { userText: 'final request', assistantText: '' },
    ];
    const text = carryOverPrompt(turns, 140);
    expect(text).toContain('(Earlier messages omitted.)');
    expect(text).toContain('User: recent\n\nAssistant: recent reply');
    expect(text).not.toContain('old old');
    expect(text.endsWith('Request: final request')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(140);
  });

  test('keeps the request alone when no earlier exchange fits', () => {
    expect(carryOverPrompt([{ userText: 'x'.repeat(500) }, { userText: 'go' }], 60)).toBe('go');
  });
});
