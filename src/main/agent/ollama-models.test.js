'use strict';

const { describeOllamaModel, checkOllamaTools } = require('./ollama-models');
const baseUrl = 'http://127.0.0.1:11434/v1';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

describe('Ollama installed model capabilities', () => {
  test.each([
    [{ capabilities: ['completion', 'tools'] }, true],
    [{ capabilities: ['completion', 'vision'] }, false],
    [{ capabilities: [] }, false],
    [{}, undefined],
    [{ capabilities: 'tools' }, undefined],
    [{ capabilities: ['tools', null] }, undefined],
  ])('uses explicit metadata without guessing from the model name: %j', async (body, tools) => {
    const fetch = jest.fn(async () => json(body));
    const result = await describeOllamaModel(fetch, baseUrl, 'gemma3:4b');
    expect(result).toEqual({ id: 'gemma3:4b', ...(typeof tools === 'boolean' && { tools }) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/show', expect.objectContaining({
      redirect: 'error', body: '{"model":"gemma3:4b"}',
    }));
  });

  test.each([
    () => json({}, 404),
    () => new Response('{broken'),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => { throw new Error('offline'); },
  ])('keeps unavailable or malformed metadata unknown', async response => {
    expect(await describeOllamaModel(async () => response(), baseUrl, 'local')).toEqual({ id: 'local' });
  });

  test('does not start a metadata request after cancellation', async () => {
    const fetch = jest.fn();
    await expect(describeOllamaModel(fetch, baseUrl, 'local', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Ollama synthetic tool check', () => {
  test('checks the requested function and exact arguments without dispatching a tool', async () => {
    const fetch = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).not.toContain('conversation');
      const value = body.tools[0].function.parameters.properties.value.enum[0];
      return json({ choices: [{ message: { tool_calls: [{ function: {
        name: 'freedom_compatibility_check', arguments: JSON.stringify({ value }),
      } }] } }] });
    });
    expect(await checkOllamaTools(fetch, baseUrl, 'local')).toEqual({ outcome: 'tools_verified' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${baseUrl}/chat/completions`);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });

  test.each([
    { choices: [{ message: { content: 'OK' } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: 'run_command', arguments: '{}' } }] } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: 'freedom_compatibility_check', arguments: '{broken' } }] } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: 'freedom_compatibility_check', arguments: '{"value":"wrong"}' } }] } }] },
  ])('does not mistake a malformed or unrelated response for tool support', async body => {
    await expect(checkOllamaTools(async () => json(body), baseUrl, 'local')).rejects.toThrow();
  });

  test('distinguishes an explicit capability rejection from a transient failure', async () => {
    await expect(checkOllamaTools(async () => json({ error: { message: 'local does not support tools' } }, 400), baseUrl, 'local'))
      .rejects.toMatchObject({ code: 'AGENT_OLLAMA_TOOLS_UNSUPPORTED' });
    await expect(checkOllamaTools(async () => json({ error: 'busy' }, 503), baseUrl, 'local'))
      .rejects.not.toHaveProperty('code', 'AGENT_OLLAMA_TOOLS_UNSUPPORTED');
  });
});
