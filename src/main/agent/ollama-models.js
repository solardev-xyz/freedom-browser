'use strict';

const { randomUUID } = require('node:crypto');

const toolsUnsupported = () => Object.assign(
  new Error('This model does not support Agent actions in Ollama. Choose a compatible model.'),
  { code: 'AGENT_OLLAMA_TOOLS_UNSUPPORTED' }
);

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('Response too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Response too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// The caller validates the loopback URL. This endpoint reports the installed
// model's actual capabilities without loading it or sending an inference.
async function describeOllamaModel(fetch, baseUrl, modelId, signal) {
  signal?.throwIfAborted();
  try {
    const response = await fetch(`${baseUrl.slice(0, -3)}/api/show`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: modelId }),
    });
    if (!response.ok) return { id: modelId };
    const body = await readJson(response);
    const capabilities = body.capabilities;
    return {
      id: modelId,
      ...(Array.isArray(capabilities) && capabilities.every(value => typeof value === 'string') && {
        tools: capabilities.includes('tools'),
      }),
    };
  } catch {
    signal?.throwIfAborted();
    // Old servers and malformed metadata mean unknown, never unsupported.
    return { id: modelId };
  }
}

async function checkOllamaTools(fetch, baseUrl, modelId, signal) {
  const value = randomUUID();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      // Reserve enough output for reasoning-only models; where supported,
      // disable thinking so the check exercises tool calling immediately.
      model: modelId, stream: false, max_tokens: 512, reasoning_effort: 'none',
      messages: [{ role: 'user', content: `Call freedom_compatibility_check with value ${value}. Do not answer in text.` }],
      tools: [{ type: 'function', function: {
        name: 'freedom_compatibility_check', description: 'A synthetic compatibility check. No action is performed.',
        parameters: { type: 'object', properties: { value: { type: 'string', enum: [value] } }, required: ['value'] },
      } }],
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = body?.error?.message || body?.error || body?.message;
    if (response.status === 400 && typeof message === 'string' && /does not support tools|tools? (?:are |is )?not supported/i.test(message)) throw toolsUnsupported();
    throw new Error('Ollama compatibility check failed');
  }
  const calls = body?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== 'freedom_compatibility_check') {
    throw new Error('Ollama did not return the requested tool call');
  }
  const args = JSON.parse(calls[0].function.arguments);
  if (args?.value !== value || Object.keys(args).length !== 1) throw new Error('Ollama returned invalid tool arguments');
  // Deliberately do not dispatch any function, even if the model asks for one.
  return { outcome: 'tools_verified' };
}

module.exports = { describeOllamaModel, checkOllamaTools, toolsUnsupported };
