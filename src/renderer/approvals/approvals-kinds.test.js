/**
 * The approvals document's kinds (freedom-core design 0011, "What a prompt
 * shows" and "Rendering a page's data"; APS-2): every view main builds for
 * a dApp prompt fits its kind's closed schema, a view off it does not, and
 * each template renders hostile data in every field a page chooses as
 * literal text, with no element the template doesn't make for the same
 * shape of view. The choices each template sends are the ones main's
 * checkers take. The real document runs these in real Electron
 * (test-e2e/approvals-dapp.spec.js).
 */

const core = require('./approvals-core.js');
const kinds = require('./approvals-kinds.js');

const { checkMessage, KINDS } = kinds;

// --- A small DOM: what the builders use, and nothing that parses markup ----

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.children = [];
    this.text = '';
    this.listeners = {};
    this.checked = false;
    this.disabled = false;
    this.value = '';
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  /** Every node under this one, this one first. */
  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const doc = { createElement: (tag) => new Node(tag) };

function render(kind, view) {
  const body = new Node('div');
  const form = KINDS[kind].render(view, core.createBuilders(doc), body);
  return { body, form, heading: KINDS[kind].heading(view), approve: KINDS[kind].approve(view) };
}

const shape = (node) => node.all().map((n) => `${n.tagName}.${n.className}`);
const inputs = (body, type) => body.all().filter((n) => n.tagName === 'INPUT' && n.type === type);

// --- Views as main builds them ------------------------------------------------

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333';
const ACCOUNT = { index: 0, name: 'Main Wallet', address: ADDRESS, type: 'mnemonic' };
const CHAIN = { id: 100, name: 'Gnosis Chain' };
const message = (kind, view) => ({
  handle: 'a'.repeat(64),
  guest: kind.startsWith('wallet.') ? null : 4,
  kind,
  site: { key: 'bzz://x', label: 'bzz://x' },
  view,
});

const TYPED_VIEW = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
    Mail: [{ name: 'from', type: 'string' }, { name: 'contents', type: 'string' }, { name: 'tags', type: 'string[]' }],
  },
  domain: { name: 'Ether Mail', chainId: '0x64' },
  primary_type: 'Mail',
  message: { from: 'Alice', contents: 'Hello', tags: ['a', 'b'] },
  ignored: [],
  named_type: 'match',
  chain: 'match',
};

const IDENTITY = { id: 'bee-wallet', mode: 'bee-wallet', label: 'Ant wallet', owner: OTHER, shared: true, stored: true, unavailable: false };
const NEW_IDENTITY = { id: 'app-scoped:3', mode: 'app-scoped', label: 'App identity 3', owner: SAFE, shared: false, stored: false, unavailable: false };

const VIEWS = {
  'eth.connect': {
    accounts: [ACCOUNT, { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe' }],
    defaultIndex: 0,
    chain: CHAIN,
  },
  'eth.sign:personal': { method: 'personal_sign', account: ACCOUNT, chain: CHAIN, message: { hex: '0x48656c6c6f', rawHash: false } },
  'eth.sign:typed': {
    method: 'eth_signTypedData_v4',
    account: ACCOUNT,
    chain: CHAIN,
    typedData: { hash: `0x${'b'.repeat(64)}`, view: TYPED_VIEW, warnings: [] },
    chains: {},
  },
  'eth.send': {
    account: ACCOUNT,
    chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
    tx: { to: OTHER, value: '1500000000000000000', data: '0x' },
    fee: { gasLimit: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000', estimate: '21000000000000' },
    feeCheck: { maxCost: '21000000000000', comparable: true, ratio: '1.0', above: false, oneEndpoint: false, basis: 'header', autoApprove: true },
    feeAskAgain: false,
    alwaysAllow: false,
  },
  'vault.unlock': { account: ACCOUNT, reason: 'sign' },
  'swarm.connect': {},
  'swarm.publish:files': { method: 'swarm_publishFiles', kind: 'files', count: 5, size: 2048, paths: ['index.html', 'a.css', 'b.js'] },
  'swarm.publish:data': { method: 'swarm_publishData', kind: 'data', size: 12, contentType: 'text/plain', name: 'note.txt' },
  'swarm.publish:chunk': { method: 'swarm_publishChunk', kind: 'chunk', size: 4096 },
  'swarm.messaging': { method: 'swarm_sendPss', grantMode: false, topic: 'chat', size: 64 },
  'swarm.feed': {
    method: 'swarm_writeSingleOwnerChunk',
    mode: 'signing',
    identifier: 'c'.repeat(64),
    identities: [IDENTITY],
    newIdentity: NEW_IDENTITY,
    activeIdentityId: 'app-scoped:3',
  },
  'swarm.manifest': {
    model: {
      origin: 'bzz://x',
      name: 'Notes',
      description: 'Keeps notes',
      changed: [{ key: 'publish', label: 'Publish', detail: 'Publish through your node', why: 'To save notes' }],
      removed: [{ key: 'messaging', label: 'Messaging' }],
      createsIdentity: true,
      preservedIdentity: false,
      isUpdate: true,
    },
  },
  'radicle.connect': {},
  'radicle.node': { method: 'radicle_seed', rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5' },
  'radicle.sign:grant': { mode: 'grant', method: 'radicle_getIdentity' },
  'radicle.sign:write': {
    mode: 'write',
    method: 'radicle_createIssue',
    rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
    title: 'Bug',
    description: 'Steps',
    labels: ['ui'],
    agentHeld: false,
    alwaysAllow: false,
  },
};

// The Safe signing boards (APS-3b), as `main/approvals/safe-boards.js` builds them.
const BOARD = {
  safe: { index: 1000, name: 'Team Safe', address: SAFE },
  threshold: 2,
  collected: 1,
  owners: [
    { index: 0, name: 'Main Wallet', address: ADDRESS, type: 'mnemonic', signed: true },
    { index: 5, name: 'Ledger 1', address: OTHER, type: 'ledger', signed: false },
    { index: 6, name: '', address: null, type: 'remote', signed: false },
  ],
  notes: [{ owner: 5, note: 'declined', message: null }],
  step: 'collect',
  error: null,
};
const SEND_BOARD = {
  ...BOARD,
  chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
  tx: { to: OTHER, value: '400000000000000000', data: '0x' },
  transfer: null,
  executor: { index: 0, name: 'Main Wallet', address: ADDRESS },
};
Object.assign(VIEWS, {
  'eth.safe_message': { ...BOARD, method: 'personal_sign' },
  'eth.safe_send': SEND_BOARD,
  'wallet.safe_board': SEND_BOARD,
  'wallet.vault_unlock': { reason: 'send' },
});
const kindOf = (name) => name.split(':')[0];

// --- Hostile data: what a page may put in every field it chooses -----------------

const cp = (code) => String.fromCodePoint(code);
const HOSTILE = [
  '<script>window.__xss=1</script>',
  '<img src=x onerror="window.__xss=1">',
  '<svg onload="window.__xss=1">',
  'javascript:alert(1)',
  'data:text/html,<b>x</b>',
  '</style><style>*{display:none}</style>',
  `rev${cp(0x202e)}erse ${cp(0x2066)}iso${cp(0x2069)} zero${cp(0x200b)}width`,
].join(' ');

const hostileViews = {
  'eth.sign:personal': {
    ...VIEWS['eth.sign:personal'],
    message: { hex: `0x${Buffer.from(HOSTILE, 'utf8').toString('hex')}`, rawHash: false },
  },
  'eth.sign:typed': {
    ...VIEWS['eth.sign:typed'],
    typedData: {
      ...VIEWS['eth.sign:typed'].typedData,
      view: {
        ...TYPED_VIEW,
        domain: { name: HOSTILE, chainId: '0x64' },
        primary_type: 'Mail',
        message: { from: HOSTILE, contents: HOSTILE.repeat(3), tags: [HOSTILE, HOSTILE] },
        ignored: [HOSTILE],
      },
    },
  },
  'eth.send': { ...VIEWS['eth.send'], tx: { ...VIEWS['eth.send'].tx, data: `0x${Buffer.from(HOSTILE, 'utf8').toString('hex')}` } },
  'swarm.publish:files': { ...VIEWS['swarm.publish:files'], paths: [HOSTILE.slice(0, 100), HOSTILE.slice(100, 200), 'x'] },
  'swarm.publish:data': { ...VIEWS['swarm.publish:data'], contentType: HOSTILE.slice(0, 256), name: HOSTILE.slice(0, 256) },
  'swarm.messaging': { ...VIEWS['swarm.messaging'], topic: HOSTILE.slice(0, 256) },
  'swarm.feed': {
    ...VIEWS['swarm.feed'],
    method: 'swarm_updateFeed',
    mode: 'feeds',
    name: HOSTILE.slice(0, 64),
    identifier: undefined,
  },
  'swarm.manifest': {
    model: {
      ...VIEWS['swarm.manifest'].model,
      name: HOSTILE.slice(0, 32),
      description: HOSTILE.slice(0, 160),
      changed: [{ ...VIEWS['swarm.manifest'].model.changed[0], why: HOSTILE.slice(0, 140) }],
    },
  },
  'radicle.sign:write': {
    ...VIEWS['radicle.sign:write'],
    title: HOSTILE.slice(0, 200),
    description: HOSTILE.repeat(20),
    labels: [HOSTILE.slice(0, 100)],
  },
};
// A board: the page's transaction data, and every text field a name or a
// message can fill.
const hostileBoard = (view) => ({
  ...view,
  safe: { ...view.safe, name: HOSTILE.slice(0, 256) },
  owners: view.owners.map((owner) => ({ ...owner, name: HOSTILE.slice(0, 256) })),
  notes: [{ owner: 5, note: 'failed', message: HOSTILE.slice(0, 300) }],
});
Object.assign(hostileViews, {
  'eth.safe_message': hostileBoard(VIEWS['eth.safe_message']),
  'eth.safe_send': {
    ...hostileBoard(SEND_BOARD),
    tx: { ...SEND_BOARD.tx, data: `0x${Buffer.from(HOSTILE, 'utf8').toString('hex')}` },
    step: 'retry',
    error: { code: 'failed', message: HOSTILE.slice(0, 300) },
  },
});
// `undefined` marks a field the hostile view leaves out.
for (const view of Object.values(hostileViews)) {
  for (const key of Object.keys(view)) if (view[key] === undefined) delete view[key];
}

// The same view with plain words where the page's hostile data was: the
// shape the template must keep.
function plainOf(value) {
  if (typeof value === 'string') {
    if (value.startsWith('0x') && Buffer.from(value.slice(2), 'hex').toString('utf8').includes('<script')) {
      return `0x${Buffer.from('plain words', 'utf8').toString('hex')}`;
    }
    return value.includes('<script') || value.includes('onerror') || value.includes(cp(0x202e)) ? 'plain words' : value;
  }
  if (Array.isArray(value)) return value.map(plainOf);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainOf(v)]));
  return value;
}

describe('every view main builds fits its kind\'s schema', () => {
  test.each(Object.keys(VIEWS))('%s', (name) => {
    expect(checkMessage(message(kindOf(name), VIEWS[name])).valid).toBe(true);
  });

  test.each(Object.keys(hostileViews))('%s, with a page\'s hostile data', (name) => {
    expect(checkMessage(message(kindOf(name), hostileViews[name])).valid).toBe(true);
  });

  test('the dApp kinds, the wallet\'s own, and the Safe boards (APS-3b)', () => {
    expect(Object.keys(KINDS).sort()).toEqual(
      [
        'eth.connect',
        'eth.safe_message',
        'eth.safe_send',
        'eth.send',
        'eth.sign',
        'radicle.connect',
        'radicle.node',
        'radicle.sign',
        'swarm.connect',
        'swarm.feed',
        'swarm.manifest',
        'swarm.messaging',
        'swarm.publish',
        'test.prompt',
        'vault.unlock',
        'wallet.executor_send',
        'wallet.intent_close',
        'wallet.intent_replace',
        'wallet.intent_resend',
        'wallet.safe_board',
        'wallet.safe_send',
        'wallet.send',
        'wallet.vault_unlock',
      ].sort()
    );
  });
});

describe('a view off its schema shows the error, and can only be rejected', () => {
  const off = {
    'eth.connect': { ...VIEWS['eth.connect'], extra: 1 },
    'eth.sign': { ...VIEWS['eth.sign:personal'], message: { hex: '0x123', rawHash: false } },
    'eth.send': { ...VIEWS['eth.send'], tx: { ...VIEWS['eth.send'].tx, to: 'javascript:alert(1)' } },
    'vault.unlock': { reason: 'export' },
    'swarm.connect': { href: 'https://example.com' },
    'swarm.publish': { ...VIEWS['swarm.publish:files'], paths: ['a', 'b', 'c', 'd'] },
    'swarm.messaging': { ...VIEWS['swarm.messaging'], topic: 'x'.repeat(257) },
    'swarm.feed': { ...VIEWS['swarm.feed'], identities: [{ ...IDENTITY, style: 'color:red' }] },
    'swarm.manifest': { model: { ...VIEWS['swarm.manifest'].model, name: 'x'.repeat(33) } },
    'radicle.connect': { url: 'x' },
    'radicle.node': { method: 'radicle_seed', rid: 'rad:<img>' },
    'radicle.sign': { ...VIEWS['radicle.sign:write'], method: 'radicle_deleteRepo' },
  };
  test.each(Object.keys(off))('%s', (kind) => {
    expect(checkMessage(message(kind, off[kind]))).toEqual({ handle: 'a'.repeat(64), kind: null, site: null, view: null, valid: false });
  });
});

describe('hostile data shows as literal text and adds no element', () => {
  test.each(Object.keys(hostileViews))('%s', (name) => {
    const kind = kindOf(name);
    const benign = render(kind, plainOf(hostileViews[name]));
    expect(checkMessage(message(kind, plainOf(hostileViews[name]))).valid).toBe(true);
    const hostile = render(kind, hostileViews[name]);
    const text = hostile.body.textContent;
    // Nothing a value names becomes an element; every element is the
    // template's own.
    const tags = new Set(hostile.body.all().map((n) => n.tagName));
    for (const tag of ['SCRIPT', 'IMG', 'SVG', 'STYLE', 'A', 'IFRAME', 'FORM', 'OBJECT']) expect(tags.has(tag)).toBe(false);
    for (const node of hostile.body.all()) expect(node.className).toMatch(/^[a-z -]*$/);
    // The markup is there as text; the bidi controls as escapes.
    if (!name.startsWith('eth.send')) {
      expect(text).toContain('<img src=x onerror=');
      expect(text).not.toContain(cp(0x202e));
      expect(text).not.toContain(cp(0x200b));
    }
    if (name === 'eth.sign:personal' || name === 'eth.sign:typed' || name === 'radicle.sign:write') {
      expect(text).toContain(`${String.fromCharCode(92)}u{202E}`);
    }
    // Same shape of view, same elements, but for a long value's full-text box.
    const strip = (list) => list.filter((entry) => entry !== 'DIV.field-full');
    expect(strip(shape(hostile.body))).toEqual(strip(shape(benign.body)));
  });

  test('a transaction\'s data is shown as hex, cut with its whole text below', () => {
    const { body } = render('eth.send', hostileViews['eth.send']);
    const full = body.all().find((n) => n.className === 'field-full');
    expect(full.textContent).toBe(hostileViews['eth.send'].tx.data);
  });
});

describe('what each template shows and sends', () => {
  test('eth.connect: the account picked, as main checks it', () => {
    const { body, form, heading, approve } = render('eth.connect', VIEWS['eth.connect']);
    expect([heading, approve]).toEqual(['Connect', 'Connect']);
    const radios = inputs(body, 'radio');
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(form.choices()).toEqual({ walletIndex: 0 });
    radios[0].checked = false;
    radios[1].checked = true;
    expect(form.choices()).toEqual({ walletIndex: 1000 });
    expect(body.textContent).toContain('Multi-owner account');
    // No account: nothing to approve.
    expect(render('eth.connect', { ...VIEWS['eth.connect'], accounts: [], defaultIndex: null }).form.choices()).toBeNull();
  });

  test('eth.sign: a message as text when it is UTF-8, else as hex; a raw hash warned; "always allow"', () => {
    const plain = render('eth.sign', VIEWS['eth.sign:personal']);
    expect(plain.body.textContent).toContain('Hello');
    expect(plain.form.choices()).toEqual({ alwaysAllow: false });
    inputs(plain.body, 'checkbox')[0].checked = true;
    expect(plain.form.choices()).toEqual({ alwaysAllow: true });
    const raw = render('eth.sign', { ...VIEWS['eth.sign:personal'], message: { hex: `0x${'ab'.repeat(32)}`, rawHash: true } });
    expect(raw.body.textContent).toContain(`0x${'ab'.repeat(32)}`);
    expect(raw.body.textContent).toContain("You're signing a raw 32-byte value");
    const bytes = render('eth.sign', { ...VIEWS['eth.sign:personal'], message: { hex: '0xff00', rawHash: false } });
    expect(bytes.body.textContent).toContain('0xff00');
  });

  test('eth.sign: typed data as the core\'s view, its ignored fields and its warnings', () => {
    const typed = render('eth.sign', {
      ...VIEWS['eth.sign:typed'],
      typedData: {
        ...VIEWS['eth.sign:typed'].typedData,
        view: { ...TYPED_VIEW, ignored: ['extra'] },
        warnings: ['named-type', 'chain-mismatch', 'chain-absent'],
      },
      chains: { 1: { name: 'Ethereum' } },
      chain: { id: 1, name: 'Ethereum' },
    });
    const text = typed.body.textContent;
    expect(text).toContain('Domain:\n  name: Ether Mail\n  chainId: 100\n\nMail:\n  from: Alice\n  contents: Hello\n  tags (string[]):\n    [0]: a\n    [1]: b');
    expect(text).toContain("The site also sent this field, which isn't signed");
    expect(text).toContain('The site named a different type of data');
    expect(text).toContain('This data is for chain 100, but the site is on Ethereum (chain 1).');
    expect(text).toContain('This data names no chain.');
  });

  test('eth.send: the fee, its check, and the second press a fee above the threshold needs', () => {
    const plain = render('eth.send', VIEWS['eth.send']);
    expect(plain.approve).toBe('Confirm');
    expect(plain.body.textContent).toContain('1.5 xDAI');
    expect(plain.body.textContent).toContain('~0.000021 xDAI');
    expect(plain.body.textContent).toContain('Up to 0.000021 xDAI');
    expect(plain.body.textContent).toContain("About 1.0× today's network fee");
    expect(inputs(plain.body, 'checkbox')).toEqual([]);
    expect(plain.form.choices()).toEqual({ alwaysAllow: false, feeAcknowledged: false });
    const above = { ...VIEWS['eth.send'].feeCheck, ratio: '4.2', above: true, autoApprove: false };
    const first = render('eth.send', { ...VIEWS['eth.send'], feeCheck: above, alwaysAllow: true, tx: { ...VIEWS['eth.send'].tx, data: '0xa9059cbb' } });
    expect(first.body.textContent).toContain("This network fee is 4.2× today's network fee.");
    expect(first.body.textContent).toContain('This transaction interacts with a smart contract.');
    // The first press asks main again; the prompt it shows again takes the second.
    expect(first.form.choices()).toEqual({ alwaysAllow: false, feeAcknowledged: false });
    const again = render('eth.send', { ...VIEWS['eth.send'], feeCheck: { ...above, askAgain: true }, feeAskAgain: true });
    expect(again.approve).toBe('Send anyway');
    expect(again.body.textContent).toContain('Check the fee, then press Send anyway to pay it.');
    expect(again.form.choices()).toEqual({ alwaysAllow: false, feeAcknowledged: true });
    // No quote: the approval asks for it again.
    const noFee = render('eth.send', { ...VIEWS['eth.send'], fee: null, feeCheck: null });
    expect(noFee.approve).toBe('Try again');
    expect(noFee.form.choices()).toEqual({});
    // A Safe's executor pays.
    expect(render('eth.send', { ...VIEWS['eth.send'], fee: { paidBy: 'executor' }, feeCheck: null }).body.textContent).toContain(
      'Paid by an owner account'
    );
  });

  test('vault.unlock: the password, never empty; a wrong one said so', () => {
    const { body, form, approve } = render('vault.unlock', { ...VIEWS['vault.unlock'], failed: true });
    expect(approve).toBe('Unlock');
    expect(body.textContent).toContain('Incorrect password');
    const [field] = inputs(body, 'password');
    expect(form.choices()).toBeNull();
    field.value = 'correct horse';
    expect(form.choices()).toEqual({ password: 'correct horse' });
  });

  test('swarm.publish and swarm.messaging: "always allow" where main offers it', () => {
    const publish = render('swarm.publish', VIEWS['swarm.publish:files']);
    expect(publish.body.textContent).toContain('index.html, a.css, b.js …and 2 more');
    expect(publish.form.choices()).toEqual({ alwaysAllow: false });
    const send = render('swarm.messaging', VIEWS['swarm.messaging']);
    expect(send.heading).toBe('Confirm Message');
    expect(send.form.choices()).toEqual({ alwaysAllow: false });
    const grant = render('swarm.messaging', { method: 'swarm_subscribe', grantMode: true });
    expect(grant.heading).toBe('Messaging Access');
    expect(inputs(grant.body, 'checkbox')).toEqual([]);
    expect(grant.form.choices()).toEqual({});
  });

  test('swarm.feed: an identity main offers; a shared one never writes a raw chunk', () => {
    const { body, form } = render('swarm.feed', VIEWS['swarm.feed']);
    const radios = inputs(body, 'radio');
    expect(radios.map((r) => [r.disabled, r.checked])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(form.choices()).toEqual({ identity: 'app-scoped:3', alwaysAllow: false });
    radios[0].checked = true;
    radios[1].checked = false;
    expect(form.choices()).toBeNull();
    const feeds = render('swarm.feed', { ...VIEWS['swarm.feed'], method: 'swarm_createFeed', mode: 'feeds', name: 'blog', identifier: undefined });
    expect(feeds.heading).toBe('Feed Access');
  });

  test('swarm.manifest: asking each time unless the user allows all', () => {
    const { body, form } = render('swarm.manifest', VIEWS['swarm.manifest']);
    expect(form.choices()).toEqual({ outcome: 'individual' });
    const radios = inputs(body, 'radio');
    radios[0].checked = false;
    radios[1].checked = true;
    expect(form.choices()).toEqual({ outcome: 'allow' });
    expect(body.textContent).toContain('Messaging removed');
  });

  test('radicle: each prompt\'s copy, and the writing rule as the box says', () => {
    expect(render('radicle.node', VIEWS['radicle.node']).approve).toBe('Seed repository');
    expect(render('radicle.node', { ...VIEWS['radicle.node'], method: 'radicle_unseed' }).heading).toBe('Stop seeding this repository?');
    expect(render('radicle.sign', VIEWS['radicle.sign:grant']).form).toBeNull();
    const write = render('radicle.sign', { ...VIEWS['radicle.sign:write'], alwaysAllow: true });
    expect(write.heading).toBe('Open this issue as you?');
    expect(write.form.choices()).toEqual({ alwaysAllow: true });
    inputs(write.body, 'checkbox')[0].checked = false;
    expect(write.form.choices()).toEqual({ alwaysAllow: false });
    const held = render('radicle.sign', { ...VIEWS['radicle.sign:write'], agentHeld: true });
    expect(held.body.textContent).toContain('Freedom Agent is using this tab.');
    expect(held.form.choices()).toEqual({});
  });

  test('the connect prompts\' copy', () => {
    expect(render('swarm.connect', {}).body.textContent).toContain('Publish content through your Swarm node');
    expect(render('radicle.connect', {}).heading).toBe('Connect Radicle node?');
  });
});

// The wallet's own prompts (APS-3): main's view of the request a token binds.
describe('the wallet\'s own kinds', () => {
  const TO = '0x2222222222222222222222222222222222222222';
  const HASH = `0x${'ab'.repeat(32)}`;
  const GNOSIS = { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' };
  const FEE = { gasLimit: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' };
  const VERDICT = { maxCost: '21000000000000', comparable: true, ratio: '4.5', above: true, oneEndpoint: false, basis: 'header', autoApprove: false };
  const hostileData = `0x${Buffer.from(HOSTILE, 'utf8').toString('hex')}`;
  const WALLET = {
    'wallet.send': { account: ACCOUNT, chain: GNOSIS, tx: { to: TO, value: '0', data: hostileData }, transfer: null, fee: FEE, feeCheck: VERDICT, feeAskAgain: false },
    'wallet.safe_send': { account: { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe' }, chain: GNOSIS, tx: { to: TO, value: '5', data: '0x' }, transfer: null },
    'wallet.intent_resend': { account: ACCOUNT, chain: GNOSIS, nonce: 7, hash: HASH, replaced: null },
    'wallet.intent_replace': { account: { ...ACCOUNT, type: 'ledger' }, chain: GNOSIS, nonce: 7, tx: { to: TO, value: '0', data: '0x' }, transfer: null, fee: { gasLimit: '21000', gasPrice: '3' }, feeCheck: null, feeAskAgain: false },
    'wallet.intent_close': { account: { index: null, name: '', address: TO, type: 'unknown' }, chain: GNOSIS, nonce: 7, hashes: [HASH, HASH] },
    'wallet.executor_send': { account: ACCOUNT, chain: GNOSIS, tx: { to: SAFE, value: '0', data: '0x6a761202' }, fee: { gasLimit: '90000', gasPrice: '2000000000' }, feeCheck: VERDICT, feeAskAgain: true },
  };

  test.each(Object.keys(WALLET))('%s fits its schema, and its page-free fields render as text', (kind) => {
    expect(checkMessage(message(kind, WALLET[kind])).valid).toBe(true);
    const { body, form } = render(kind, WALLET[kind]);
    expect(form.choices()).toEqual({});
    const tags = new Set(body.all().map((n) => n.tagName));
    for (const tag of ['SCRIPT', 'IMG', 'SVG', 'STYLE', 'A', 'INPUT']) expect(tags.has(tag)).toBe(false);
  });

  test('a send shows its data as hex, cut; its fee above the threshold; the second press labelled', () => {
    const first = render('wallet.send', WALLET['wallet.send']);
    expect(first.approve).toBe('Send');
    expect(first.body.textContent).toContain("This network fee is 4.5× today's network fee.");
    expect(first.body.textContent).toContain('Up to 0.000021 xDAI');
    expect(first.body.all().find((n) => n.className === 'field-full').textContent).toBe(hostileData);
    expect(render('wallet.send', { ...WALLET['wallet.send'], feeAskAgain: true }).approve).toBe('Send anyway');
    expect(render('wallet.executor_send', WALLET['wallet.executor_send']).approve).toBe('Send anyway');
    expect(render('wallet.executor_send', { ...WALLET['wallet.executor_send'], feeAskAgain: false }).approve).toBe('Confirm fee and execute');
  });

  test('a token transfer is read from the data; an account not in the wallet says so; a device says where to confirm', () => {
    const amount = (5n * 10n ** 18n).toString();
    const transfer = render('wallet.send', { ...WALLET['wallet.send'], transfer: { token: TO, recipient: SAFE, amount } });
    expect(transfer.body.textContent).toContain('An ERC-20 transfer, read from the data below');
    expect(transfer.body.textContent).toContain(amount);
    expect(render('wallet.intent_close', WALLET['wallet.intent_close']).body.textContent).toContain('An account not in this wallet');
    expect(render('wallet.intent_replace', WALLET['wallet.intent_replace']).body.textContent).toContain('You confirm this on your Ledger');
  });

  // APS-4: a resend asked again because the payment was replaced says so.
  test('a resend asked again after a replacement says why, and names the transaction approved before', () => {
    const plain = render('wallet.intent_resend', WALLET['wallet.intent_resend']);
    expect(plain.body.textContent).not.toContain('replaced');
    const before = `0x${'cd'.repeat(32)}`;
    const view = { ...WALLET['wallet.intent_resend'], replaced: before };
    expect(checkMessage(message('wallet.intent_resend', view)).valid).toBe(true);
    const again = render('wallet.intent_resend', view);
    expect(again.body.textContent).toContain('This payment was replaced with a higher fee after you approved sending it again');
    expect(again.body.textContent).toContain(before);
    expect(again.body.textContent).toContain(HASH);
    expect(again.approve).toBe('Send again');
  });

  // Codex, #1210: the wallet's own decision is answered once its token is
  // minted, and the device step comes after, on the chrome's screen.
  test('an approval waits on a device for a page\'s prompt only, never for the wallet\'s own', () => {
    const on = (type) => ({ ...ACCOUNT, type });
    expect(kinds.deviceOf(checkMessage(message('eth.send', { ...VIEWS['eth.send'], account: on('ledger') })))).toBe('ledger');
    expect(kinds.deviceOf(checkMessage(message('eth.send', { ...VIEWS['eth.send'], account: on('remote') })))).toBe('remote');
    expect(kinds.deviceOf(checkMessage(message('eth.send', VIEWS['eth.send'])))).toBeNull();
    for (const kind of ['wallet.send', 'wallet.intent_replace', 'wallet.executor_send']) {
      const prompt = checkMessage(message(kind, { ...WALLET[kind], account: on('ledger') }));
      expect(prompt.valid).toBe(true);
      expect(kinds.deviceOf(prompt)).toBeNull();
    }
    expect(kinds.deviceOf(checkMessage(message('eth.send', { ...VIEWS['eth.send'], account: on('ledger'), extra: 1 })))).toBeNull();
    expect(kinds.deviceOf(null)).toBeNull();
  });

  test('off its schema: an unknown field, a bad hash, a page\'s choice in the account, a guest named', () => {
    expect(checkMessage({ ...message('wallet.send', WALLET['wallet.send']), guest: 4 }).valid).toBe(false);
    expect(checkMessage({ ...message('eth.connect', VIEWS['eth.connect']), guest: null }).valid).toBe(false);
    for (const [kind, view] of [
      ['wallet.send', { ...WALLET['wallet.send'], memo: 'x' }],
      ['wallet.intent_resend', { ...WALLET['wallet.intent_resend'], hash: '0x12' }],
      ['wallet.intent_resend', { ...WALLET['wallet.intent_resend'], replaced: '<b>replaced</b>' }],
      ['wallet.intent_resend', { account: ACCOUNT, chain: GNOSIS, nonce: 7, hash: HASH }],
      ['wallet.intent_close', { ...WALLET['wallet.intent_close'], hashes: Array.from({ length: 65 }, () => HASH) }],
      ['wallet.safe_send', { ...WALLET['wallet.safe_send'], account: { ...ACCOUNT, type: 'Safe <b>' } }],
    ]) {
      expect(checkMessage(message(kind, view)).valid).toBe(false);
    }
  });
});

// Touch ID, where main offers it (APS-3): the panel asks main to use it.
describe('vault.unlock with Touch ID', () => {
  test('an empty password means Touch ID only where main offers it', () => {
    const offered = render('vault.unlock', { reason: 'send', touchId: true });
    expect(checkMessage(message('vault.unlock', { reason: 'send', touchId: true })).valid).toBe(true);
    expect(offered.body.textContent).toContain('Leave the password empty to unlock with Touch ID.');
    expect(offered.form.choices()).toEqual({ touchId: true });
    inputs(offered.body, 'password')[0].value = 'pw';
    expect(offered.form.choices()).toEqual({ password: 'pw' });
    expect(render('vault.unlock', { reason: 'send' }).form.choices()).toBeNull();
  });
});

describe('the Safe signing boards (APS-3b)', () => {
  const { boardChoices } = require('../../main/approvals/safe-boards');
  const radiosOf = (body) => inputs(body, 'radio');
  const pick = (body, index) => {
    radiosOf(body).forEach((radio, i) => {
      radio.checked = i === index;
    });
    for (const fn of radiosOf(body)[index].listeners.change || []) fn();
  };

  test('a message\'s board: the owners still to sign as choices, main\'s checker takes each; Reject cancels', () => {
    const view = VIEWS['eth.safe_message'];
    const { body, form, heading, approve } = render('eth.safe_message', view);
    expect([heading, approve, KINDS['eth.safe_message'].reject(view)]).toEqual(['Collect signatures', 'Sign', 'Cancel request']);
    const text = body.textContent;
    expect(text).toContain('1 of 2');
    expect(text).toContain('Any 2 of the 3 owners can sign.');
    expect(text).toContain('Declined on the device');
    expect(text).toContain('Team Safe');
    expect(text).not.toContain('session');
    expect(radiosOf(body)).toHaveLength(2);
    expect(form.choices()).toEqual({ action: 'sign', owner: 5 });
    expect(boardChoices('message', view)(form.choices())).toEqual({ action: 'sign', owner: 5 });
    pick(body, 1);
    expect(form.choices()).toEqual({ action: 'sign', owner: 6 });
    expect(boardChoices('message', view)(form.choices())).toEqual({ action: 'sign', owner: 6 });
    // No discard for a message; no owner who has signed.
    expect(boardChoices('message', view)({ action: 'discard' })).toBeNull();
    expect(boardChoices('message', view)({ action: 'sign', owner: 0 })).toBeNull();
    expect(boardChoices('message', view)({ action: 'sign', owner: 5, extra: 1 })).toBeNull();
  });

  test('a send\'s board: the SafeTx main holds, its executor, discard as its own choice; the Approve label follows the choice', () => {
    const view = VIEWS['eth.safe_send'];
    const { body, form } = render('eth.safe_send', view);
    expect(KINDS['eth.safe_send'].reject(view)).toBe('Leave');
    const text = body.textContent;
    expect(text).toContain(OTHER);
    expect(text).toContain('0.4 xDAI');
    expect(text).toContain('Paid by Main Wallet');
    const labels = [];
    form.watch((label) => labels.push(label));
    expect(radiosOf(body)).toHaveLength(3);
    pick(body, 2);
    expect(form.choices()).toEqual({ action: 'discard' });
    expect(boardChoices('send', view)(form.choices())).toEqual({ action: 'discard' });
    pick(body, 0);
    expect(labels).toEqual(['Discard', 'Sign']);
    // The wallet's own board is the same board, with no site.
    expect(render('wallet.safe_board', view).body.textContent).toContain("Your multi-owner account's transaction");
  });

  test('a discard asked again, a superseded SafeTx, and an execution to try again', () => {
    const discard = { ...SEND_BOARD, step: 'discard' };
    const asked = render('eth.safe_send', discard);
    expect([asked.heading, asked.approve, KINDS['eth.safe_send'].reject(discard)]).toEqual(['Discard transaction?', 'Discard', 'Keep']);
    expect(asked.form.choices()).toEqual({ action: 'discard' });
    expect(radiosOf(asked.body)).toHaveLength(0);
    const outdated = render('wallet.safe_board', { ...SEND_BOARD, step: 'superseded' });
    expect([outdated.heading, outdated.approve]).toEqual(['Transaction outdated', 'Discard transaction']);
    expect(outdated.form.choices()).toEqual({ action: 'discard' });
    const funds = { ...SEND_BOARD, collected: 2, step: 'retry', error: { code: 'needs-funds', message: 'insufficient funds' } };
    const retry = render('eth.safe_send', funds);
    expect(retry.approve).toBe("I've added funds: try again");
    expect(retry.body.textContent).toContain('insufficient funds');
    expect(retry.form.choices()).toEqual({ action: 'retry' });
    expect(boardChoices('send', funds)(retry.form.choices())).toEqual({ action: 'retry' });
    // Signing isn't a choice on this step.
    expect(boardChoices('send', funds)({ action: 'sign', owner: 5 })).toBeNull();
  });

  test('an approval waits on the device of the owner chosen to sign', () => {
    for (const kind of ['eth.safe_message', 'eth.safe_send', 'wallet.safe_board']) {
      const prompt = checkMessage(message(kind, VIEWS[kind]));
      expect(prompt.valid).toBe(true);
      expect(kinds.deviceOf(prompt, { action: 'sign', owner: 5 })).toBe('ledger');
      expect(kinds.deviceOf(prompt, { action: 'sign', owner: 6 })).toBe('remote');
      expect(kinds.deviceOf(prompt, { action: 'sign', owner: 0 })).toBeNull();
      expect(kinds.deviceOf(prompt, { action: 'discard' })).toBeNull();
      expect(kinds.deviceOf(prompt)).toBeNull();
    }
  });

  test('off its schema: a token, a display, an unknown step, a guest named for the wallet\'s board', () => {
    const off = [
      ['eth.safe_message', { ...VIEWS['eth.safe_message'], token: 'session-1' }],
      ['eth.safe_send', { ...SEND_BOARD, display: { label: 'x' } }],
      ['eth.safe_send', { ...SEND_BOARD, step: 'execute' }],
      ['eth.safe_send', { ...SEND_BOARD, owners: [{ ...SEND_BOARD.owners[0], type: 'Ledger <b>' }] }],
      ['eth.safe_send', { ...SEND_BOARD, tx: { ...SEND_BOARD.tx, to: 'javascript:alert(1)' } }],
    ];
    for (const [kind, view] of off) expect(checkMessage(message(kind, view)).valid).toBe(false);
    expect(checkMessage({ ...message('wallet.safe_board', SEND_BOARD), guest: 4 }).valid).toBe(false);
    expect(checkMessage({ ...message('eth.safe_send', SEND_BOARD), guest: null }).valid).toBe(false);
  });
});
