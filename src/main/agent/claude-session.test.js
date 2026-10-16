'use strict';

const { execFileSync } = require('child_process');

test('Claude session preserves scoped codemode, validation, history, guidance, cancellation and request accounting', () => {
  const script = String.raw`
(async () => {
  const assert = require('node:assert/strict');
  const { loadPiSdk } = require('./src/main/agent/pi-sdk');
  const { createClaudeSession } = require('./src/main/agent/claude-session');
  const { CLAUDE_MODELS } = require('./src/main/agent/claude-cli');
  const sdk = await loadPiSdk();
  let transport, starts = 0, executions = 0, requests = 0, written = [], events = [];
  const pending = [];
  const { session } = await createClaudeSession({ sdk, model: CLAUDE_MODELS[0], executable: '/fixture/claude',
    systemPrompt: 'Fixture', restoredTranscript: [{ userText: 'Earlier question', assistantText: 'Earlier answer', status: 'completed' }], enableCodemode: true, onRequest: () => requests++,
    customTools: [{ name: 'read_number', description: 'Read a number', parameters: { type: 'object',
      properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false },
      execute: async (_id, args) => { executions++; return { content: [{ type: 'text', text: String(args.number) }] }; } }],
    startProcess: async options => {
      transport = options; starts++;
      return { write: value => { written.push(value); pending.shift()?.(); }, close: async () => options.onClose(null) };
    },
  });
  session.subscribe(event => events.push(event));
  const waitWrite = () => new Promise(resolve => pending.push(resolve));
  const finish = text => {
    const emit = transport.onEvent;
    emit({ type: 'stream_event', event: { type: 'message_start' } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2, output_tokens: 3 } } });
    emit({ type: 'stream_event', event: { type: 'message_stop' } });
    emit({ type: 'result', subtype: 'success', result: text });
  };
  let ready = waitWrite(); const run = session.prompt('remember ORBIT', { images: [{ mimeType: 'image/png', data: 'fixture' }] }); await ready;
  assert.match(written[0].message.content[0].text, /Earlier answer/);
  assert.deepEqual(written[0].message.content[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } });
  const getTool = name => transport.tools.find(t => t.name === name);
  const invalid = await getTool('read_number').execute('invalid', { number: 'no' }, transport.signal);
  assert.equal(invalid.isError, true); assert.equal(executions, 0);
  const scriptResult = await getTool('codemode').execute('script', { code: 'const value = await tools.read_number({number:73}); text(value); store("number", value);' }, transport.signal);
  assert.equal(scriptResult.isError, false);
  assert.match(scriptResult.content.filter(c => c.type === 'text').map(c => c.text).join(''), /73/);
  assert.equal(executions, 1);
  assert(events.some(e => e.toolName === 'read_number' && e.parentToolCallId));
  finish('Ready'); await run;
  assert.equal(events.filter(e => e.type === 'message_update').map(e => e.assistantMessageEvent.delta).join(''), 'Ready');
  assert.equal(requests, 1);
  ready = waitWrite(); const follow = session.prompt('next'); await ready;
  assert.equal(starts, 1);
  assert.equal(written.at(-1).message.content.length, 1);
  await session.steer('new guidance');
  ready = waitWrite(); finish('Next'); await ready;
  assert.equal(written.at(-1).message.content[0].text, 'new guidance');
  finish('Guided'); await follow;
  ready = waitWrite(); const stop = session.prompt('pending'); const stopped = assert.rejects(stop, { name: 'AbortError' }); await ready;
  await session.abort(); await stopped;
  ready = waitWrite(); const resumed = session.prompt('resume'); await ready;
  assert.equal(starts, 2);
  assert.match(written.at(-1).message.content[0].text, /Earlier Freedom conversation/);
  assert.match(written.at(-1).message.content[0].text, /remember ORBIT/);
  finish('Resumed'); await resumed;
  await session.dispose();
  await assert.rejects(session.prompt('closed'));
  console.log('qualified');
})().catch(error => { console.error(error); process.exitCode = 1; });`;
  expect(execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 })).toContain('qualified');
}, 35000);
