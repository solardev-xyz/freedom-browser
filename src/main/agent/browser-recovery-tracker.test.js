'use strict';

const { BrowserRecoveryTracker } = require('./browser-recovery-tracker');
const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');

function observation(index, patch = {}) {
  return {
    ok: true,
    tabId: 'tab_one',
    navigationId: 1,
    result: {
      documentId: 'document_one',
      url: 'https://example.test/private',
      text: 'Unchanged returned text',
      elements: [
        {
          ref: `ref_${index}`,
          frameId: `frame_${index}`,
          role: 'button',
          name: 'Continue',
          checked: false,
        },
      ],
      frames: [
        {
          frameId: `frame_${index}`,
          url: 'https://example.test/private',
          viewport: { ref: `viewport_${index}`, scrollY: 0 },
        },
      ],
      ...patch,
    },
  };
}

function read(tracker, index, patch, input = {}) {
  return tracker.record(
    OPERATIONS.SNAPSHOT,
    { tabId: 'tab_one', ...input },
    observation(index, patch)
  );
}

const failure = { code: ERROR_CODES.ELEMENT_NOT_INTERACTABLE, retryable: true };

test('nudges on four and eight matching observations despite fresh element/frame references', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 9; index += 1) {
    const result = read(tracker, index);
    if ([4, 8].includes(index)) {
      expect(result).toContain(`${index} times`);
      expect(result).toContain('does not establish whether an interaction had side effects');
    } else expect(result).toBeNull();
  }
});

test('equivalent literal searches ignore case and whitespace but preserve words and punctuation', () => {
  const tracker = new BrowserRecoveryTracker();
  for (const textQuery of ['Hello world', 'hello world', ' hello   world ']) {
    expect(read(tracker, 1, { textQuery }, { textQuery })).toBeNull();
  }
  expect(read(tracker, 2, { textQuery: 'HELLO WORLD' }, { textQuery: 'HELLO WORLD' })).toContain(
    '4 times'
  );
  for (const textQuery of ['world hello', 'hello, world', 'hello world!']) {
    expect(read(tracker, 1, { textQuery }, { textQuery })).toBeNull();
  }
});

test.each([
  ['text', { text: 'Changed returned text' }],
  ['focus', { elements: [{ ref: 'new', role: 'button', name: 'Continue', focused: true }] }],
  ['document', { documentId: 'document_replacement' }],
  ['URL', { url: 'https://example.test/next' }],
  [
    'control state',
    { elements: [{ ref: 'new', role: 'button', name: 'Continue', checked: true }] },
  ],
  [
    'scroll position',
    { frames: [{ frameId: 'new', viewport: { ref: 'new_view', scrollY: 120 } }] },
  ],
])('%s changes reset observation repetition', (_name, patch) => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 3; index += 1) read(tracker, index);
  expect(read(tracker, 4, patch)).toBeNull();
});

test('continuation, different frame reads and other tabs remain separate', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 9; index += 1) {
    expect(read(tracker, index, {}, { textOffset: index * 12000 })).toBeNull();
    expect(
      tracker.record(
        OPERATIONS.READ_FRAME,
        { tabId: 'tab_one', frameRef: `frame_${index}` },
        observation(index)
      )
    ).toBeNull();
    expect(read(tracker, index, {}, { tabId: `tab_${index}` })).toBeNull();
  }
});

test('repeated click/read cycles warn without interpreting unchanged content as failure', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 4; index += 1) {
    tracker.record(
      OPERATIONS.CLICK,
      { tabId: 'tab_one', ref: `ref_${index}` },
      { ok: true, result: { clicked: true } }
    );
    const guidance = read(tracker, index);
    if (index === 4) expect(guidance).toContain('Check previous action receipts');
    else expect(guidance).toBeNull();
  }
});

test('failed attempts identify the same observed control across fresh references', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 4; index += 1) {
    read(tracker, index);
    const result = tracker.record(
      OPERATIONS.CLICK,
      { tabId: 'tab_one', ref: `ref_${index}` },
      null,
      failure
    );
    if (index === 4) expect(result).toContain('same retryable error 4 times');
    else expect(result).toBeNull();
  }
});

test('distinct controls, typed values and error categories do not become the same attempt', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 10; index += 1) {
    expect(
      tracker.record(
        OPERATIONS.CLICK,
        { tabId: 'tab_one', ref: `distinct_${index}` },
        null,
        failure
      )
    ).toBeNull();
    expect(
      tracker.record(
        OPERATIONS.TYPE,
        { tabId: 'tab_one', ref: 'same', text: `value_${index}` },
        null,
        failure
      )
    ).toBeNull();
  }
  const errors = [failure, { ...failure, code: ERROR_CODES.STALE_ELEMENT_REFERENCE }];
  for (let index = 0; index < 6; index += 1) {
    expect(
      tracker.record(OPERATIONS.CLICK, { tabId: 'tab_one', ref: 'same' }, null, errors[index % 2])
    ).toBeNull();
  }
});

test('actual scrolling and successful field editing reset repetitions; boundary repeats get a hint', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 10; index += 1) {
    read(tracker, index);
    expect(
      tracker.record(
        OPERATIONS.SCROLL,
        { tabId: 'tab_one', ref: `viewport_${index}`, direction: 'down' },
        { ok: true, result: { moved: true, outcome: 'moved' } }
      )
    ).toBeNull();
  }
  for (let index = 1; index <= 4; index += 1) {
    const guidance = tracker.record(
      OPERATIONS.SCROLL,
      { tabId: 'tab_one', ref: 'viewport_10', direction: 'down' },
      { ok: true, result: { moved: false, outcome: 'boundary' } }
    );
    if (index === 4) expect(guidance).toContain('no movement 4 times');
    else expect(guidance).toBeNull();
  }
  tracker.record(OPERATIONS.TYPE, { tabId: 'tab_one', text: 'new value' }, { ok: true });
  expect(read(tracker, 20)).toBeNull();
});

test('permissions, cancellation and privileged operations never get retry guidance', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 0; index < 12; index += 1) {
    expect(
      tracker.record(OPERATIONS.CLICK, { tabId: 'tab_one', ref: 'same' }, null, {
        code: ERROR_CODES.POLICY_DENIED,
        retryable: false,
      })
    ).toBeNull();
    expect(
      tracker.record(OPERATIONS.DOWNLOAD, { tabId: 'tab_one', ref: 'same' }, null, failure)
    ).toBeNull();
    expect(
      tracker.record(OPERATIONS.WALLET_TRANSFER, { tabId: 'tab_one' }, null, failure)
    ).toBeNull();
  }
});

test('transient errors, stop, idle gaps and new tool sessions do not inherit repetition', () => {
  let now = 1;
  const tracker = new BrowserRecoveryTracker(() => now);
  for (let index = 1; index <= 3; index += 1) read(tracker, index);
  now += 120001;
  expect(read(tracker, 4)).toBeNull();
  for (let index = 1; index <= 2; index += 1) read(tracker, index);
  tracker.record(OPERATIONS.STOP_LOADING, { tabId: 'tab_one' }, { ok: true });
  expect(read(tracker, 5)).toBeNull();
  expect(read(new BrowserRecoveryTracker(), 1)).toBeNull();
  for (let index = 0; index < 3; index += 1)
    tracker.record(OPERATIONS.CLICK, { tabId: 'tab_one', ref: 'same' }, null, failure);
  read(tracker, 6, { text: 'Recovered state' });
  expect(
    tracker.record(OPERATIONS.CLICK, { tabId: 'tab_one', ref: 'same' }, null, failure)
  ).toBeNull();
});

test('retains no public raw text, input, reference or digest and bounds old page history', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let index = 1; index <= 3; index += 1) read(tracker, index, { text: 'PRIVATE-PAGE-TOKEN' });
  tracker.record(
    OPERATIONS.TYPE,
    { tabId: 'tab_one', ref: 'PRIVATE-REF', text: 'PRIVATE-PASSWORD' },
    null,
    failure
  );
  expect(JSON.stringify(tracker)).toBe('{}');
  for (let index = 0; index < 9; index += 1) read(tracker, index, {}, { tabId: `other_${index}` });
  expect(read(tracker, 4, { text: 'PRIVATE-PAGE-TOKEN' })).toBeNull();
});

test('unexpected observation shapes cannot turn successful operations into failures', () => {
  const tracker = new BrowserRecoveryTracker();
  expect(read(tracker, 1, { frames: {} })).toBeNull();
  expect(read(tracker, 2)).toBeNull();
});

test('detects a two-state cycle only within the same observation scope, without repeating the action', () => {
  const tracker = new BrowserRecoveryTracker();
  for (let i = 0; i < 5; i++)
    expect(read(tracker, i, { text: i % 2 ? 'State B' : 'State A' })).toBeNull();
  expect(read(tracker, 5, { text: 'State B' })).toContain('alternated three times');
  const paginated = new BrowserRecoveryTracker();
  for (let i = 0; i < 8; i++)
    expect(
      read(paginated, i, { text: i % 2 ? 'State B' : 'State A' }, { textOffset: i % 2 ? 12000 : 0 })
    ).toBeNull();
  const progressed = new BrowserRecoveryTracker();
  for (let i = 0; i < 5; i++) read(progressed, i, { text: i % 2 ? 'State B' : 'State A' });
  progressed.record(OPERATIONS.NAVIGATE, { tabId: 'tab_one' }, { ok: true });
  expect(read(progressed, 5, { text: 'State B' })).toBeNull();
});
