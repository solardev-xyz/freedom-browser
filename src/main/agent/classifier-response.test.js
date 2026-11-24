'use strict';

const { InteractionIntentClassifier, parseInteractionClassification } = require('./interaction-intent-classifier');
const { EffectClassifier, parseClassification } = require('./effect-classifier');
const { structuredClassifierRuntime } = require('./classifier-response');
const log = require('../logger');

const interaction = { kind: 'ordinary', confidence: 0.98, summary: 'Enter a search query.', uncertainties: [] };
const effect = { effect: 'read', confidence: 0.98, summary: 'Read status.', resources: [], uncertainties: [] };

function sessionFor(output, stopReason = 'stop') {
  let listener;
  return {
    subscribe: fn => { listener = fn; return () => { listener = null; }; },
    prompt: jest.fn(async () => {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: output } });
      listener({ type: 'message_end', message: { role: 'assistant', stopReason } });
    }),
    abort: jest.fn(), dispose: jest.fn(),
  };
}

describe.each([
  [InteractionIntentClassifier, parseInteractionClassification, interaction, 'kind', 'uncertain'],
  [EffectClassifier, parseClassification, effect, 'effect', 'unknown'],
])('%p response contract', (Classifier, parse, valid, field, unknown) => {
  test.each(['', 'json', 'JSON'])('accepts only a complete valid object inside one %s fence', label => {
    expect(parse(` \n\`\`\`${label}\r\n${JSON.stringify(valid)}\r\n\`\`\`\n `)).toEqual(valid);
  });

  test.each([
    json => `Here is the answer: ${json}`,
    json => `${json}\n${json}`,
    json => `\`\`\`json\n${json}\n\`\`\`\nExplanation`,
    json => `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
    json => `<think>analysis</think>${json}`,
    json => `\`\`\`javascript\n${json}\n\`\`\``,
  ])('does not extract JSON or strip reasoning from an ambiguous response', wrap => {
    expect(parse(wrap(JSON.stringify(valid)))).toMatchObject({ [field]: unknown, confidence: 0, uncertainties: ['classifier_invalid_json'] });
  });

  test.each([
    { confidence: '0.99' }, { confidence: null }, { confidence: true }, { confidence: 2 },
    { uncertainties: [null] }, { uncertainties: [''] }, { uncertainties: undefined },
    { summary: '' }, { summary: 42 }, { extra: 'allow' },
  ])('rejects malformed fields without coercion or dropping uncertainty', patch => {
    expect(parse(JSON.stringify({ ...valid, ...patch }))).toMatchObject({ [field]: unknown, confidence: 0, uncertainties: ['classifier_invalid_schema'] });
  });

  test('retries malformed output once in a fresh tool-free session with the same model', async () => {
    const bad = sessionFor('private invalid reply'), good = sessionFor(JSON.stringify(valid));
    const createSession = jest.fn().mockResolvedValueOnce({ session: bad }).mockResolvedValueOnce({ session: good });
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const model = { provider: 'near-ai', id: 'test' }, modelRuntime = {};
    const result = await new Classifier({ createSession }).classify({ action: { secret: 'private input' } }, { model, modelRuntime });
    expect(result).toEqual(valid);
    expect(createSession).toHaveBeenCalledTimes(2);
    for (const [options] of createSession.mock.calls) expect(options).toMatchObject({ model, modelRuntime, customTools: [] });
    expect(bad.dispose).toHaveBeenCalledTimes(1);
    expect(good.prompt.mock.calls[0][0]).not.toContain('private invalid reply');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private input|private invalid reply/);
    expect(warn).toHaveBeenCalledWith('[AgentClassifier]', expect.objectContaining({ attempt: 1, reason: 'classifier_invalid_json', provider: 'near-ai' }));
    warn.mockRestore();
  });

  test('stops after two invalid replies and leaves approval required', async () => {
    const createSession = jest.fn(async () => ({ session: sessionFor('bad') }));
    expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {} })).toMatchObject({ [field]: unknown, confidence: 0 });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  test('distinguishes empty and oversized replies without accepting either', async () => {
    expect(parse('')).toMatchObject({ uncertainties: ['classifier_empty_output'] });
    expect(parse('x'.repeat(8193))).toMatchObject({ uncertainties: ['classifier_output_too_large'] });
    const createSession = jest.fn(async () => ({ session: sessionFor('x'.repeat(8193)) }));
    expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {} })).toMatchObject({ uncertainties: ['classifier_output_too_large'] });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test.each(['error', 'aborted', 'length', 'toolUse'])('does not accept valid-looking text or retry after %s', async stopReason => {
    const createSession = jest.fn(async () => ({ session: sessionFor(JSON.stringify(valid), stopReason) }));
    expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {} })).toMatchObject({ [field]: unknown, confidence: 0 });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test('does not retry a valid uncertain decision', async () => {
    const judgment = { ...valid, [field]: unknown, confidence: 0.4, uncertainties: ['The target is ambiguous.'] };
    const createSession = jest.fn(async () => ({ session: sessionFor(JSON.stringify(judgment)) }));
    expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {} })).toEqual(judgment);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test('Stop prevents the retry', async () => {
    const abort = new AbortController(), session = sessionFor('bad');
    const prompt = session.prompt;
    session.prompt = async (...args) => { await prompt(...args); abort.abort(); };
    const createSession = jest.fn(async () => ({ session }));
    expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {}, signal: abort.signal })).toMatchObject({ uncertainties: ['classifier_cancelled'] });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test('both attempts share a single time budget', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const session = sessionFor('bad'), prompt = session.prompt;
    session.prompt = async (...args) => { await prompt(...args); now.mockReturnValue(16001); };
    const createSession = jest.fn(async () => ({ session }));
    try {
      expect(await new Classifier({ createSession }).classify({}, { model: {}, modelRuntime: {} })).toMatchObject({ uncertainties: ['classifier_timeout'] });
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });
});

test('structured output is opt-in per model and preserves payload hooks without mutating the runtime', async () => {
  const model = { api: 'openai-completions', provider: 'near-ai', id: 'test' };
  const runtime = { supportsClassifierSchema: () => true, streamSimple: jest.fn((_model, _context, options) => options) };
  const schema = { type: 'object' };
  const wrapped = structuredClassifierRuntime(runtime, model, schema);
  const options = wrapped.streamSimple(model, {}, { onPayload: payload => ({ ...payload, keep: true }) });
  expect(await options.onPayload({ model: 'test' }, model)).toEqual({ model: 'test', keep: true, response_format: { type: 'json_schema', json_schema: { name: 'freedom_classification', strict: true, schema } } });
  expect(runtime.streamSimple).toHaveBeenCalledTimes(1);
  const routedModel = { ...model, provider: 'openrouter' };
  const routed = structuredClassifierRuntime(runtime, routedModel, schema).streamSimple(routedModel, {}, {});
  expect(await routed.onPayload({ provider: { zdr: true } }, routedModel)).toMatchObject({ provider: { zdr: true, require_parameters: true } });
  expect(structuredClassifierRuntime(runtime, { ...model, api: 'other' }, schema)).toBe(runtime);
  runtime.supportsClassifierSchema = () => false;
  expect(structuredClassifierRuntime(runtime, model, schema)).toBe(runtime);
});
