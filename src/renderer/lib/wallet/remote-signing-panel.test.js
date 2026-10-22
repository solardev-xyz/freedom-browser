const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

// The panel renders the broker's job events. A payment the phone holds
// can't be asked for again with a new code (design 0005, "Retrying an
// intent"), nor recalled from here.

const IDS = [
  'sidebar-remote-signing',
  'remote-signing-request-label',
  'remote-signing-qr-image',
  'remote-signing-status-text',
  'remote-signing-new-code',
  'remote-signing-cancel',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function load() {
  jest.resetModules();
  const elements = Object.fromEntries(
    IDS.map((id) => [
      id,
      createElement(id === 'remote-signing-qr-image' ? 'img' : 'div', {
        classes: id === 'sidebar-remote-signing' ? ['hidden'] : [],
        textContent: id === 'remote-signing-cancel' ? 'Cancel' : '',
      }),
    ])
  );
  global.document = createDocument({ elementsById: elements });
  let emit;
  const broker = {
    onJobEvent: jest.fn((listener) => {
      emit = listener;
    }),
    retryJob: jest.fn(() => true),
    cancelJob: jest.fn(),
  };
  jest.doMock('./remote-session.js', () => ({
    getRemoteSessionBroker: () => broker,
    PHASE_STATUS_TEXT: {
      'awaiting-approval': 'Connected — confirm on your phone…',
    },
    PAYMENT_METHOD: 'eth_sendTransaction',
  }));
  jest.doMock('./wallet-utils.js', () => ({
    generateScannableQr: jest.fn(async () => ({
      success: true,
      dataUrl: 'data:image/png;base64,QR',
    })),
  }));
  const mod = await import('./remote-signing-panel.js');
  mod.initRemoteSigningPanel();
  return { elements, broker, emit: (event) => emit({ kind: 'signing', ...event }) };
}

const hidden = (element) => element.classList.contains('hidden');

afterEach(() => {
  jest.dontMock('./remote-session.js');
  jest.dontMock('./wallet-utils.js');
  delete global.document;
});

describe('remote-signing panel', () => {
  test('a payment on the phone loses its new code, and Cancel becomes Stop waiting', async () => {
    const { elements, broker, emit } = await load();
    emit({
      jobId: 'job-pay',
      phase: 'qr',
      method: 'eth_sendTransaction',
      bridgeUrl: 'https://b/#x',
    });
    await flush();
    expect(hidden(elements['sidebar-remote-signing'])).toBe(false);
    expect(hidden(elements['remote-signing-new-code'])).toBe(false);
    expect(elements['remote-signing-cancel'].textContent).toBe('Cancel');

    emit({ jobId: 'job-pay', phase: 'awaiting-approval', method: 'eth_sendTransaction' });
    expect(hidden(elements['remote-signing-new-code'])).toBe(true);
    expect(elements['remote-signing-cancel'].textContent).toBe('Stop waiting');
    expect(elements['remote-signing-status-text'].textContent).toBe(
      'Connected — confirm on your phone…'
    );

    elements['remote-signing-cancel'].dispatch('click');
    expect(broker.cancelJob).toHaveBeenCalledWith('job-pay');
  });

  test('a signature on the phone keeps its new code: it pays nothing', async () => {
    const { elements, broker, emit } = await load();
    emit({ jobId: 'job-sign', phase: 'qr', method: 'personal_sign', bridgeUrl: 'https://b/#x' });
    emit({ jobId: 'job-sign', phase: 'awaiting-approval', method: 'personal_sign' });
    expect(hidden(elements['remote-signing-new-code'])).toBe(false);
    expect(elements['remote-signing-cancel'].textContent).toBe('Cancel');

    elements['remote-signing-new-code'].dispatch('click');
    expect(broker.retryJob).toHaveBeenCalledWith('job-sign');
    expect(elements['remote-signing-status-text'].textContent).toBe('Preparing a new code…');
  });

  test('a new code the broker refuses changes nothing on screen', async () => {
    const { elements, broker, emit } = await load();
    emit({
      jobId: 'job-pay',
      phase: 'qr',
      method: 'eth_sendTransaction',
      bridgeUrl: 'https://b/#x',
    });
    await flush();
    emit({ jobId: 'job-pay', phase: 'linking', method: 'eth_sendTransaction' });
    elements['remote-signing-status-text'].textContent = 'Phone found — connecting…';
    broker.retryJob.mockReturnValue(false);

    elements['remote-signing-new-code'].dispatch('click');
    expect(broker.retryJob).toHaveBeenCalledWith('job-pay');
    expect(elements['remote-signing-status-text'].textContent).toBe('Phone found — connecting…');
    expect(elements['remote-signing-qr-image'].src).toBe('data:image/png;base64,QR');
  });

  test("the next job's code starts with both buttons as they were", async () => {
    const { elements, emit } = await load();
    emit({
      jobId: 'job-pay',
      phase: 'qr',
      method: 'eth_sendTransaction',
      bridgeUrl: 'https://b/#x',
    });
    emit({ jobId: 'job-pay', phase: 'awaiting-approval', method: 'eth_sendTransaction' });
    emit({ jobId: 'job-pay', phase: 'error', method: 'eth_sendTransaction' });
    expect(hidden(elements['sidebar-remote-signing'])).toBe(true);

    emit({
      jobId: 'job-next',
      phase: 'qr',
      method: 'eth_sendTransaction',
      bridgeUrl: 'https://b/#y',
    });
    expect(hidden(elements['sidebar-remote-signing'])).toBe(false);
    expect(hidden(elements['remote-signing-new-code'])).toBe(false);
    expect(elements['remote-signing-cancel'].textContent).toBe('Cancel');
  });

  test("another job's events leave the panel alone", async () => {
    const { elements, emit } = await load();
    emit({
      jobId: 'job-pay',
      phase: 'qr',
      method: 'eth_sendTransaction',
      bridgeUrl: 'https://b/#x',
    });
    emit({ jobId: 'job-other', phase: 'awaiting-approval', method: 'eth_sendTransaction' });
    expect(hidden(elements['remote-signing-new-code'])).toBe(false);
  });
});
