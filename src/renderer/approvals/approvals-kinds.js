/**
 * The approvals document's kinds (freedom-core design 0011, "What a prompt
 * shows" and "Rendering a page's data"; APS-1, APS-2): for each prompt kind
 * main shows here, its closed schema, its heading and approve label, and
 * its fixed template.
 *
 * A template gets the checked view and the builders (approvals-core.js),
 * and nothing else: every element comes from a fixed tag and class, every
 * value goes in as text. A value main owns (the account, the chain, the fee
 * check's verdict, a warning code) is shown as main's (`ui.own`, or fixed
 * copy picked by a code from a fixed list); a value a page chose is shown
 * as the page's (`ui.page`), encoded, and cut when long. A template returns
 * what the page reads the user's choices from: `choices()`, the decision's
 * `choices`, or null while there is nothing to approve yet.
 *
 * The copy is the chrome's screens' own, which these replace. The Safe
 * signing boards (`eth.safe_message`, `eth.safe_send`) stay in the chrome
 * until APS-3: they collect the owners' signatures through device steps
 * only the chrome runs, after the Safe's request was approved here.
 *
 * A classic script, loaded after approvals-core.js.
 */
(function approvalsKinds(root, factory) {
  'use strict';
  const fromNode = typeof module === 'object' && module.exports;
  const api = factory(fromNode ? require('./approvals-core.js') : root.ApprovalsCore);
  if (fromNode) module.exports = api;
  else Object.defineProperty(root, 'ApprovalsKinds', { value: api });
})(typeof window === 'undefined' ? globalThis : window, function kinds(core) {
  'use strict';

  const { text, integer, boolean, oneOf, list, record, nullable, anyOf, json } = core.schema;
  const { isPlainObject, conforms, viewBytes, MAX_VIEW_BYTES } = core;

  const HANDLE = /^[0-9a-f]{64}$/;
  const MESSAGE_KEYS = ['handle', 'guest', 'kind', 'site', 'view'];
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  // --- Shapes several kinds share -------------------------------------------

  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
  const HASH = /^0x[0-9a-fA-F]{64}$/;
  const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
  const RATIO = /^[0-9]+(?:\.[0-9]+)?$/;
  // Every byte a page may send, as hex, within the view's 256 KiB.
  const MAX_HEX = 2 * MAX_VIEW_BYTES + 2;

  const SITE = record({ key: text(2048), label: text(2048) });
  const ACCOUNT = record({
    index: integer({ min: 0 }),
    name: text(256),
    address: nullable(text(42, { pattern: ADDRESS })),
    type: text(32, { pattern: /^[a-z][a-z0-9-]*$/ }),
  });
  const CHAIN = record({ id: integer({ min: 0 }), name: nullable(text(128)) });
  const decimal = () => text(80, { pattern: DECIMAL });

  // --- Formatting, main's values --------------------------------------------

  const chainText = (chain) => (chain.name ? `${chain.name} (chain ${chain.id})` : `chain ${chain.id}`);
  const accountText = (account) => {
    const name = account.name || 'Account';
    return account.address ? `${name}  ${account.address}` : name;
  };

  /** A decimal amount of base units in whole units, every digit kept. */
  function units(amount, decimals = 18) {
    let value;
    try {
      value = BigInt(amount);
    } catch {
      return String(amount);
    }
    const base = 10n ** BigInt(decimals);
    const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${value / base}.${fraction}` : String(value / base);
  }

  /** Wei rounded up at a gwei: "up to" never understates it. */
  function upTo(wei) {
    const gwei = 10n ** 9n;
    return units(((BigInt(wei) + gwei - 1n) / gwei) * gwei);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${parseFloat((bytes / 1024 ** i).toFixed(2))} ${sizes[i]}`;
  }

  const DEVICE_NOTES = Object.freeze({
    ledger: 'You confirm this on your Ledger after you approve here.',
    remote: 'You confirm this on your phone after you approve here: its code opens in the sidebar.',
  });

  // --- Typed data, as the core's view says it (design 0002, #88) -------------

  const INDENT = '  ';
  const elementType = (type) => (typeof type === 'string' && type.endsWith(']') ? type.slice(0, type.lastIndexOf('[')) : null);
  const scalar = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

  function chainIdText(quantity) {
    try {
      return BigInt(quantity).toString();
    } catch {
      return String(quantity);
    }
  }

  function valueLines(lines, types, type, value, depth) {
    const pad = INDENT.repeat(depth);
    const inner = elementType(type);
    if (inner !== null) {
      if (!Array.isArray(value) || value.length === 0) {
        lines[lines.length - 1] += ' (empty)';
        return;
      }
      value.forEach((item, index) => {
        if (hasOwn(types, inner) || elementType(inner) !== null) {
          lines.push(`${pad}[${index}]:`);
          valueLines(lines, types, inner, item, depth + 1);
        } else {
          lines.push(`${pad}[${index}]: ${scalar(item)}`);
        }
      });
      return;
    }
    if (!hasOwn(types, type)) {
      lines[lines.length - 1] += ` ${scalar(value)}`;
      return;
    }
    structLines(lines, types, type, value, depth);
  }

  function structLines(lines, types, type, value, depth) {
    const pad = INDENT.repeat(depth);
    const fields = Array.isArray(types[type]) ? types[type] : [];
    if (fields.length === 0) {
      lines.push(`${pad}(no fields)`);
      return;
    }
    for (const field of fields) {
      const name = String(field?.name);
      const fieldType = String(field?.type);
      const fieldValue = isPlainObject(value) && hasOwn(value, name) ? value[name] : undefined;
      if (hasOwn(types, fieldType) || elementType(fieldType) !== null) {
        lines.push(`${pad}${name} (${fieldType}):`);
        valueLines(lines, types, fieldType, fieldValue, depth + 1);
      } else {
        lines.push(`${pad}${name}: ${scalar(fieldValue)}`);
      }
    }
  }

  /** The core's typed-data view as text: the domain, the type, its message. */
  function typedDataText(view) {
    const lines = ['Domain:'];
    const domain = isPlainObject(view.domain) ? view.domain : {};
    if (Object.keys(domain).length === 0) lines.push(`${INDENT}(empty)`);
    for (const name of Object.keys(domain)) {
      lines.push(`${INDENT}${name}: ${name === 'chainId' ? chainIdText(domain[name]) : scalar(domain[name])}`);
    }
    lines.push('', `${view.primary_type}:`);
    structLines(lines, isPlainObject(view.types) ? view.types : {}, view.primary_type, view.message, 1);
    return lines.join('\n');
  }

  function typedDataWarnings(typedData, chain, chains) {
    const label = (id) => (chains?.[id]?.name ? `${chains[id].name} (chain ${id})` : `chain ${id}`);
    const out = [];
    if (typedData.warnings.includes('named-type')) {
      out.push(
        'The site named a different type of data than the one shown here. This screen shows what you sign, but another wallet could sign something different for this request.'
      );
    }
    if (typedData.warnings.includes('chain-mismatch')) {
      out.push(`This data is for ${label(chainIdText(typedData.view.domain?.chainId))}, but the site is on ${label(String(chain.id))}.`);
    }
    if (typedData.warnings.includes('chain-absent')) {
      out.push('This data names no chain. The signature is valid on every chain where the contract it is for exists.');
    }
    return out;
  }

  /** A personal_sign message as text when its bytes are UTF-8, else null. */
  function messageText(hex) {
    try {
      const bytes = new Uint8Array((hex.slice(2).match(/../g) || []).map((pair) => parseInt(pair, 16)));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  // --- The kinds --------------------------------------------------------------

  const checked = (box) => box.value();

  const ethConnect = Object.freeze({
    schema: record({ accounts: list(256, ACCOUNT), defaultIndex: nullable(integer({ min: 0 })), chain: CHAIN }),
    heading: () => 'Connect',
    approve: () => 'Connect',
    render(view, ui, body) {
      body.append(ui.note('wants to connect'));
      const picker = ui.radios(
        'account',
        view.accounts.map((account) => ({
          value: account.index,
          label: account.name || 'Account',
          detail: [account.address || '--', account.type === 'safe' ? 'Multi-owner account' : ''].filter(Boolean).join('  '),
        })),
        view.defaultIndex
      );
      body.append(ui.section('Select wallet to connect'), picker.element);
      if (view.accounts.length === 0) body.append(ui.warning('No account can connect to this site'));
      if (view.accounts.some((account) => account.type === 'safe')) {
        body.append(
          ui.note(
            "Multi-owner account: works on Gnosis Chain and signs as a smart contract. Some apps can't verify contract signatures."
          )
        );
      }
      body.append(
        ui.own('Network', chainText(view.chain)),
        ui.bullets('This will allow the site to:', [
          'View your wallet address',
          'Request transaction approval',
          'Request message signatures',
        ])
      );
      return {
        choices() {
          const walletIndex = picker.value();
          return view.accounts.some((account) => account.index === walletIndex) ? { walletIndex } : null;
        },
      };
    },
  });

  const TYPED_DATA_VIEW = record({
    types: json({ depth: 4 }),
    domain: json({ depth: 2 }),
    primary_type: text(256),
    message: json({ depth: 64 }),
    ignored: list(256, text(256)),
    named_type: oneOf('match', 'mismatch', 'unknown'),
    chain: oneOf('match', 'mismatch', 'absent', 'unknown'),
  });

  const ethSign = Object.freeze({
    schema: anyOf(
      record({
        method: oneOf('personal_sign'),
        account: ACCOUNT,
        chain: CHAIN,
        message: record({ hex: text(MAX_HEX, { pattern: HEX }), rawHash: boolean() }),
      }),
      record(
        {
          method: oneOf('eth_signTypedData_v4'),
          account: ACCOUNT,
          chain: CHAIN,
          typedData: record({
            hash: text(66, { pattern: HASH }),
            view: TYPED_DATA_VIEW,
            warnings: list(3, oneOf('named-type', 'chain-mismatch', 'chain-absent')),
          }),
          chains: json({ depth: 2 }),
        },
        { optional: ['chains'] }
      )
    ),
    heading: () => 'Sign Message',
    approve: () => 'Sign',
    render(view, ui, body) {
      body.append(ui.note('requests your signature'), ui.own('Account', accountText(view.account)), ui.own('Network', chainText(view.chain)));
      if (view.method === 'personal_sign') {
        const textForm = view.message.rawHash ? null : messageText(view.message.hex);
        body.append(
          ui.section('Message'),
          textForm === null
            ? ui.page('Bytes', view.message.hex, { mono: true })
            : ui.page('Text', textForm, { multiline: true })
        );
        if (view.message.rawHash) {
          body.append(
            ui.warning(
              "You're signing a raw 32-byte value. It can authorize things this screen can't show, such as a Swarm feed update."
            )
          );
        }
      } else {
        const typed = view.typedData;
        body.append(ui.section('Structured Data (EIP-712)'), ui.page('Data', typedDataText(typed.view), { multiline: true, mono: true }));
        const ignored = typed.view.ignored;
        if (ignored.length > 0) {
          body.append(
            ui.page(
              ignored.length === 1 ? 'The site also sent this field, which isn\'t signed' : 'The site also sent these fields, which aren\'t signed',
              ignored.join(', ')
            )
          );
        }
        for (const line of typedDataWarnings(typed, view.chain, view.chains || {})) body.append(ui.warning(line));
      }
      if (view.account.type === 'safe') {
        body.append(
          ui.note(
            "This multi-owner account signs as a smart contract. Some apps can't verify contract signatures. If the site rejects the signature, that's why."
          )
        );
      }
      if (DEVICE_NOTES[view.account.type]) body.append(ui.note(DEVICE_NOTES[view.account.type]));
      body.append(ui.warning('Only sign messages from sites you trust. Signing can authorize actions on your behalf.'));
      const always = ui.checkbox('Always allow this site to request signatures without asking');
      body.append(always.element);
      return { choices: () => ({ alwaysAllow: checked(always) }) };
    },
  });

  const FEE = anyOf(
    record({ gasLimit: decimal(), maxFeePerGas: decimal(), maxPriorityFeePerGas: decimal(), estimate: decimal() }),
    record({ gasLimit: decimal(), gasPrice: decimal(), estimate: decimal() }),
    record({ paidBy: oneOf('executor') })
  );
  const FEE_CHECK = record(
    {
      maxCost: nullable(decimal()),
      comparable: boolean(),
      ratio: nullable(text(32, { pattern: RATIO })),
      above: boolean(),
      oneEndpoint: boolean(),
      basis: nullable(oneOf('header', 'quote')),
      autoApprove: boolean(),
      askAgain: boolean(),
    },
    { optional: ['askAgain'] }
  );

  const ethSend = Object.freeze({
    schema: record({
      account: ACCOUNT,
      chain: record({ id: integer({ min: 0 }), name: nullable(text(128)), symbol: text(32) }),
      tx: record({ to: text(42, { pattern: ADDRESS }), value: decimal(), data: text(MAX_HEX, { pattern: HEX }) }),
      fee: nullable(FEE),
      feeCheck: nullable(FEE_CHECK),
      feeAskAgain: boolean(),
      alwaysAllow: boolean(),
    }),
    heading: () => 'Confirm Transaction',
    approve: (view) => (view.fee === null ? 'Try again' : view.feeAskAgain ? 'Send anyway' : 'Confirm'),
    render(view, ui, body) {
      const symbol = view.chain.symbol;
      body.append(
        ui.note('requests a transaction'),
        ui.own('Account', accountText(view.account)),
        ui.page('To', view.tx.to, { mono: true }),
        ui.page('Value', `${units(view.tx.value)} ${symbol}`),
        view.tx.data === '0x' ? ui.own('Data', 'No data') : ui.page('Data', view.tx.data, { mono: true }),
        ui.own('Network', chainText(view.chain))
      );
      if (view.fee === null) {
        body.append(ui.warning('Confirm needs the network fee.'));
      } else if (view.fee.paidBy === 'executor') {
        body.append(ui.own('Est. Fee', 'Paid by an owner account'));
      } else {
        body.append(ui.own('Est. Fee', `~${units(view.fee.estimate)} ${symbol}`));
      }
      const verdict = view.feeCheck;
      if (verdict) {
        if (verdict.maxCost) body.append(ui.own('Most it can cost', `Up to ${upTo(verdict.maxCost)} ${symbol}`));
        if (!verdict.comparable) body.append(ui.note("Couldn't compare this fee with today's network fee"));
        else if (!verdict.above) {
          body.append(
            ui.note(
              verdict.oneEndpoint
                ? `About ${verdict.ratio}× today's network fee, as one network source reports it`
                : `About ${verdict.ratio}× today's network fee`
            )
          );
        } else {
          body.append(
            ui.warning(
              view.feeAskAgain
                ? `This network fee is ${verdict.ratio}× today's network fee. Check the fee, then press Send anyway to pay it.`
                : `This network fee is ${verdict.ratio}× today's network fee.`
            )
          );
        }
      }
      if (view.tx.data !== '0x') body.append(ui.warning('This transaction interacts with a smart contract.'));
      if (DEVICE_NOTES[view.account.type]) body.append(ui.note(DEVICE_NOTES[view.account.type]));
      const always = view.alwaysAllow ? ui.checkbox('Always allow this site to call this function without asking') : null;
      if (always) body.append(always.element);
      return {
        choices() {
          // No fee yet: the approval asks main for the quote again.
          if (view.fee === null) return {};
          // A fee above the threshold is confirmed by a second press, on the
          // prompt main shows again (`feeAskAgain`), as the chrome's was.
          return { alwaysAllow: always ? checked(always) : false, feeAcknowledged: view.feeAskAgain === true };
        },
      };
    },
  });

  const vaultUnlock = Object.freeze({
    schema: record(
      { account: ACCOUNT, reason: oneOf('sign', 'send', 'feeds', 'signing'), failed: boolean() },
      { optional: ['account', 'failed'] }
    ),
    heading: () => 'Unlock Vault',
    approve: () => 'Unlock',
    render(view, ui, body) {
      const REASONS = {
        sign: 'to sign a message',
        send: 'to send a transaction',
        feeds: 'to manage its feeds',
        signing: 'to sign with your publisher identity',
      };
      body.append(ui.note('needs your vault unlocked to continue'), ui.own('Why', REASONS[view.reason]));
      if (view.account) body.append(ui.own('Account', accountText(view.account)));
      if (view.failed === true) body.append(ui.warning('Incorrect password'));
      const field = ui.password('Enter password');
      body.append(field.element);
      return {
        choices() {
          const password = field.value();
          return password.length > 0 ? { password } : null;
        },
      };
    },
  });

  const swarmConnect = Object.freeze({
    schema: record({}),
    heading: () => 'Swarm Access',
    approve: () => 'Allow',
    render(_view, ui, body) {
      body.append(
        ui.note('wants to publish through your Swarm node'),
        ui.bullets('This will allow the site to:', [
          'Publish content through your Swarm node',
          "Use your node's postage stamps",
          'Check node capabilities and upload status',
        ]),
        ui.note('Publishing uses your stamps and bandwidth. Each publish requires your approval.'),
        ui.bullets('This site cannot:', [
          'Access your wallet or private keys',
          'Manage your storage or stamps',
          'Read your files or browsing history',
        ])
      );
      return null;
    },
  });

  const SIZE = integer({ min: 0 });
  const swarmPublish = Object.freeze({
    schema: anyOf(
      record({ method: oneOf('swarm_publishFiles'), kind: oneOf('files'), count: SIZE, size: SIZE, paths: list(3, text(100)) }),
      record({ method: oneOf('swarm_publishChunk'), kind: oneOf('chunk'), size: SIZE }),
      record(
        { method: oneOf('swarm_publishData'), kind: oneOf('data'), size: SIZE, contentType: text(256), name: text(256) },
        { optional: ['contentType', 'name'] }
      )
    ),
    heading: () => 'Confirm Publish',
    approve: () => 'Publish',
    render(view, ui, body) {
      body.append(ui.note('wants to publish content'));
      if (view.kind === 'files') {
        body.append(ui.own('Type', `${view.count} ${view.count === 1 ? 'file' : 'files'}`), ui.own('Size', formatBytes(view.size)));
        const more = view.count - view.paths.length;
        body.append(ui.page('Files', `${view.paths.join(', ')}${more > 0 ? ` …and ${more} more` : ''}`));
      } else if (view.kind === 'chunk') {
        body.append(ui.own('Type', 'Swarm chunk'), ui.own('Size', formatBytes(view.size)));
      } else {
        body.append(
          view.contentType === undefined ? ui.own('Type', 'unknown') : ui.page('Type', view.contentType),
          ui.own('Size', formatBytes(view.size))
        );
        if (view.name !== undefined) body.append(ui.page('Name', view.name));
      }
      body.append(ui.warning('This will use your stamps and bandwidth. Content will be publicly accessible on Swarm.'));
      const always = ui.checkbox('Always allow this site to publish to Swarm without asking');
      body.append(always.element);
      return { choices: () => ({ alwaysAllow: checked(always) }) };
    },
  });

  const SWARM_METHOD = text(64, { pattern: /^swarm_[A-Za-z]+$/ });
  const MESSAGING_WANTS = Object.freeze({
    swarm_sendPss: 'wants to send a private message (PSS)',
    swarm_sendGsoc: 'wants to broadcast a message (GSOC)',
    swarm_subscribe: 'wants to receive real-time messages',
  });
  const swarmMessaging = Object.freeze({
    schema: record({ method: SWARM_METHOD, grantMode: boolean(), topic: text(256), size: SIZE }, { optional: ['topic', 'size'] }),
    heading: (view) => (view.grantMode ? 'Messaging Access' : 'Confirm Message'),
    approve: () => 'Allow',
    render(view, ui, body) {
      const wants = view.grantMode ? null : MESSAGING_WANTS[view.method];
      body.append(ui.note(wants || 'wants to send and receive real-time messages'));
      if (view.topic !== undefined) body.append(ui.page('Topic', view.topic));
      if (view.size !== undefined) body.append(ui.own('Size', formatBytes(view.size)));
      body.append(
        ui.warning(
          view.grantMode
            ? "Messaging discloses a stable identity key to this site. Sending uses your stamps; open subscriptions use bandwidth while the page is loaded. A subscription can also read any PSS traffic your node decrypts for the topic it joins, not only this site's own messages."
            : 'Sending this message uses your stamps and is visible to the Swarm network.'
        )
      );
      const offer = !view.grantMode && (view.method === 'swarm_sendPss' || view.method === 'swarm_sendGsoc');
      const always = offer ? ui.checkbox('Always allow this site to send messages without asking') : null;
      if (always) body.append(always.element);
      return { choices: () => (always ? { alwaysAllow: checked(always) } : {}) };
    },
  });

  const IDENTITY = record({
    id: text(128),
    mode: text(32),
    label: text(256),
    owner: nullable(text(64)),
    shared: boolean(),
    stored: boolean(),
    unavailable: boolean(),
  });
  const IDENTITY_MODES = Object.freeze({
    'bee-wallet': 'Ant wallet',
    'app-scoped': 'App-scoped',
    'user-wallet': 'Ethereum wallet',
  });
  const swarmFeed = Object.freeze({
    schema: record(
      {
        method: oneOf('swarm_createFeed', 'swarm_updateFeed', 'swarm_writeFeedEntry', 'swarm_writeSingleOwnerChunk', 'swarm_getSigningIdentity'),
        mode: oneOf('feeds', 'signing'),
        name: text(64),
        identifier: text(64, { pattern: /^[0-9a-fA-F]{64}$/ }),
        identities: list(256, IDENTITY),
        newIdentity: IDENTITY,
        activeIdentityId: text(128),
      },
      { optional: ['name', 'identifier'] }
    ),
    heading: (view) => (view.mode === 'feeds' ? 'Feed Access' : 'Publisher Signing'),
    approve: () => 'Allow',
    render(view, ui, body) {
      const feeds = view.mode === 'feeds';
      const soc = view.method === 'swarm_writeSingleOwnerChunk';
      body.append(ui.note(feeds ? 'wants to create and manage feeds' : 'wants to use your publisher identity'));
      if (feeds) {
        body.append(view.name === undefined ? ui.own('Feed name', 'Feed operation') : ui.page('Feed name', view.name));
      } else if (soc) {
        body.append(view.identifier === undefined ? ui.own('Request', 'Single Owner Chunk') : ui.page('Request', `Single Owner Chunk ${view.identifier}`));
      } else {
        body.append(ui.own('Request', 'Signing identity'));
      }
      body.append(
        ui.warning(
          feeds
            ? 'Feeds provide stable URLs that this app can update over time. Uses your stamps and bandwidth.'
            : 'Publisher signing can create Single Owner Chunks and reveal the active publisher owner for this site.'
        )
      );
      const option = (identity, label) => ({
        value: identity.id,
        label,
        detail: [
          IDENTITY_MODES[identity.mode] || 'Publisher',
          identity.owner || '',
          identity.unavailable ? "Can't sign feeds" : '',
          identity.shared ? 'Also used by other sites' : '',
        ]
          .filter(Boolean)
          .join('  '),
        disabled: identity.unavailable || (soc && identity.shared),
      });
      const options = view.identities.map((identity) => option(identity, identity.label || identity.id));
      if (!view.identities.some((identity) => identity.id === view.newIdentity.id)) {
        options.push(option(view.newIdentity, `Create new app-scoped identity: ${view.newIdentity.label || view.newIdentity.id}`));
      }
      const picker = ui.radios('identity', options, view.activeIdentityId);
      body.append(ui.section('Publisher identity'), picker.element);
      if (soc && view.identities.some((identity) => identity.shared)) {
        body.append(
          ui.note(
            'An identity also used by other sites cannot write Single Owner Chunks for this one. Choose or create an app-scoped identity for this site.'
          )
        );
      }
      const always = ui.checkbox(
        feeds
          ? 'Always allow this site to manage feeds without asking'
          : 'Always allow this site to use this publisher identity without asking'
      );
      body.append(always.element);
      return {
        choices() {
          const identity = picker.value();
          const picked = [...view.identities, view.newIdentity].find((candidate) => candidate.id === identity);
          if (!picked || picked.unavailable || (soc && picked.shared)) return null;
          return { identity, alwaysAllow: checked(always) };
        },
      };
    },
  });

  const swarmManifest = Object.freeze({
    schema: record({
      model: record({
        origin: text(2048),
        name: text(32),
        description: text(160),
        changed: list(4, record({ key: text(32), label: text(64), detail: text(256), why: text(140) })),
        removed: list(4, record({ key: text(32), label: text(64) })),
        createsIdentity: boolean(),
        preservedIdentity: boolean(),
        isUpdate: boolean(),
      }),
    }),
    heading: () => 'App permissions',
    approve: () => 'Connect',
    render(view, ui, body) {
      const model = view.model;
      body.append(ui.page('App', model.name));
      if (model.description) body.append(ui.page('Description', model.description, { multiline: true }));
      for (const removed of model.removed) {
        body.append(ui.own(`${removed.label} removed`, 'The app no longer requests this capability. Manifest-managed access has been removed.'));
      }
      for (const changed of model.changed) body.append(ui.page(changed.label, changed.why));
      if (model.createsIdentity) {
        body.append(ui.note('A new app-scoped signing identity will be created. Your vault still unlocks at signing time.'));
      } else if (model.preservedIdentity) {
        body.append(ui.note('Your existing publisher identity will be kept.'));
      }
      const outcome = ui.radios(
        'outcome',
        [
          { value: 'individual', label: 'Connect, but ask each time' },
          { value: 'allow', label: 'Allow all' },
        ],
        'individual'
      );
      body.append(
        outcome.element,
        ui.note('Allow all applies these permissions now. Asking each time keeps the normal per-action prompts.')
      );
      return {
        choices() {
          const picked = outcome.value();
          return picked === 'allow' || picked === 'individual' ? { outcome: picked } : null;
        },
      };
    },
  });

  const radicleConnect = Object.freeze({
    schema: record({}),
    heading: () => 'Connect Radicle node?',
    approve: () => 'Connect',
    render(_view, ui, body) {
      body.append(
        ui.note('wants to interact with your Radicle node'),
        ui.bullets('This will allow the site to:', [
          'See node status and your seeded repositories',
          'Ask to seed or sync repositories (with approval)',
        ]),
        ui.warning('This site cannot write anything as you without a separate approval for your Radicle identity.')
      );
      return null;
    },
  });

  const RID = text(64, { pattern: /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/ });
  const COB_ID = text(40, { pattern: /^[0-9a-f]{6,40}$/ });
  const radicleNode = Object.freeze({
    schema: record({ method: oneOf('radicle_seed', 'radicle_unseed'), rid: RID }),
    heading: (view) => (view.method === 'radicle_seed' ? 'Seed this repository?' : 'Stop seeding this repository?'),
    approve: (view) => (view.method === 'radicle_seed' ? 'Seed repository' : 'Stop seeding'),
    render(view, ui, body) {
      const seed = view.method === 'radicle_seed';
      body.append(
        ui.note(seed ? 'asks your node to seed this repository' : 'asks your node to stop seeding this repository'),
        ui.page('Repository', view.rid, { mono: true }),
        ui.bullets(
          'This will:',
          seed
            ? ['Download the repository to your node', 'Share it with the Radicle network from your node']
            : ['Remove the seeding policy for this repository', 'Cancel any fetch of it still in progress']
        ),
        ui.warning(
          seed
            ? 'Seeding uses disk space and bandwidth until you unseed the repository.'
            : 'Your node stops sharing this repository with the Radicle network until you seed it again.'
        )
      );
      return null;
    },
  });

  const WRITE_COPY = Object.freeze({
    radicle_createIssue: { heading: 'Open this issue as you?', wants: 'asks to open an issue', approve: 'Open issue' },
    radicle_commentIssue: { heading: 'Post this comment as you?', wants: 'asks to comment on an issue', approve: 'Post comment' },
    radicle_editIssueState: { heading: 'Change this issue as you?', wants: 'asks to change an issue', approve: 'Change state' },
    radicle_commentPatch: { heading: 'Post this comment as you?', wants: 'asks to comment on a patch', approve: 'Post comment' },
  });
  const radicleSign = Object.freeze({
    schema: anyOf(
      record({ mode: oneOf('grant'), method: text(64, { pattern: /^radicle_[A-Za-z]+$/ }) }),
      record(
        {
          mode: oneOf('write'),
          method: oneOf(...Object.keys(WRITE_COPY)),
          rid: RID,
          title: text(200),
          description: text(65536),
          labels: list(10, text(100)),
          issueId: COB_ID,
          body: text(65536),
          replyTo: COB_ID,
          state: oneOf('open', 'closed', 'solved'),
          patchId: COB_ID,
          revisionId: COB_ID,
          agentHeld: boolean(),
          alwaysAllow: boolean(),
        },
        { optional: ['title', 'description', 'labels', 'issueId', 'body', 'replyTo', 'state', 'patchId', 'revisionId'] }
      )
    ),
    heading: (view) => (view.mode === 'grant' ? 'Act as your Radicle identity?' : WRITE_COPY[view.method].heading),
    approve: (view) => (view.mode === 'grant' ? 'Allow' : WRITE_COPY[view.method].approve),
    render(view, ui, body) {
      if (view.mode === 'grant') {
        body.append(
          ui.note('wants to author content as your Radicle identity'),
          ui.bullets('This will allow the site to:', [
            'Know your Radicle DID and alias',
            'Ask to open issues, comment, and change issue states as you. You approve each one.',
          ]),
          ui.warning(
            'Everything it writes is signed with your Radicle identity, published to the Radicle network, and cannot be unpublished.'
          )
        );
        return null;
      }
      body.append(ui.note(WRITE_COPY[view.method].wants), ui.page('Repository', view.rid, { mono: true }));
      if (view.issueId !== undefined) body.append(ui.page('Issue', view.issueId, { mono: true }));
      if (view.patchId !== undefined) body.append(ui.page('Patch', view.patchId, { mono: true }));
      if (view.revisionId !== undefined) {
        body.append(ui.page('Revision (the page says it belongs to the patch above)', view.revisionId, { mono: true }));
      }
      if (view.title !== undefined) body.append(ui.page('Title', view.title));
      if (view.description !== undefined) body.append(ui.page('Description', view.description, { multiline: true }));
      for (const label of view.labels || []) body.append(ui.page('Label', label));
      if (view.body !== undefined) body.append(ui.page('Comment', view.body, { multiline: true }));
      if (view.replyTo !== undefined) body.append(ui.page('In reply to comment', view.replyTo, { mono: true }));
      if (view.state !== undefined) body.append(ui.page('Set its state to', view.state));
      body.append(
        ui.warning(
          `${view.agentHeld ? 'Freedom Agent is using this tab. ' : ''}This is signed with your Radicle identity and published to the Radicle network. It is public and permanent: it cannot be edited away or unpublished.`
        )
      );
      const always = view.agentHeld
        ? null
        : ui.checkbox('Always allow this site to write as you without asking (at most 50 writes a day)', {
          checked: view.alwaysAllow,
        });
      if (always) body.append(always.element);
      return { choices: () => (always ? { alwaysAllow: checked(always) } : {}) };
    },
  });

  const KINDS = Object.freeze({
    'eth.connect': ethConnect,
    'eth.sign': ethSign,
    'eth.send': ethSend,
    'vault.unlock': vaultUnlock,
    'swarm.connect': swarmConnect,
    'swarm.publish': swarmPublish,
    'swarm.messaging': swarmMessaging,
    'swarm.feed': swarmFeed,
    'swarm.manifest': swarmManifest,
    'radicle.connect': radicleConnect,
    'radicle.node': radicleNode,
    'radicle.sign': radicleSign,
    // The harness's prompt (APS-1): every field is the test's choice, and is
    // treated as a page's. Main issues it only under the E2E harness.
    'test.prompt': Object.freeze({
      schema: record({
        title: text(120),
        message: text(4096, { multiline: true }),
        rows: list(16, record({ label: text(64), value: text(4096) })),
      }),
      heading: () => 'Test request',
      approve: () => 'Approve',
      render(view, ui, body) {
        body.append(ui.page('Title', view.title), ui.page('Message', view.message, { multiline: true }));
        for (const row of view.rows) body.append(ui.page(row.label, row.value));
        return null;
      },
    }),
  });

  /**
   * A `page:prompt` message, checked. Null when it names no handle (there
   * is nothing to answer); otherwise the handle, and its site and view only
   * when the whole message fits its kind's schema (`valid`). An invalid one
   * shows the fixed error and can only be rejected.
   */
  function checkMessage(message) {
    if (!isPlainObject(message)) return null;
    const { handle } = message;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
    const keys = Object.keys(message);
    const kind = typeof message.kind === 'string' && hasOwn(KINDS, message.kind) ? message.kind : null;
    const valid =
      kind !== null &&
      keys.length === MESSAGE_KEYS.length &&
      keys.every((key) => MESSAGE_KEYS.includes(key)) &&
      Number.isInteger(message.guest) &&
      conforms(message.site, SITE) &&
      viewBytes(message.view) <= MAX_VIEW_BYTES &&
      conforms(message.view, KINDS[kind].schema);
    return valid
      ? { handle, kind, site: message.site, view: message.view, valid: true }
      : { handle, kind: null, site: null, view: null, valid: false };
  }

  return Object.freeze({ KINDS, SITE, checkMessage, typedDataText, units });
});
