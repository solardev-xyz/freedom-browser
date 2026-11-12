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
 * The copy is the chrome's screens' own, which these replace. From APS-3b
 * the Safe signing boards (`eth.safe_message`, `eth.safe_send`,
 * `wallet.safe_board`) show here too, as main runs them
 * (`main/approvals/safe-boards.js`): a template may also name its Reject
 * label (`reject`), and return `watch(listener)`, which hears the Approve
 * label for the choice the user picks.
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
  const { isPlainObject, conforms, viewBytes, MAX_VIEW_BYTES, MAX_PARTED_VIEW_BYTES } = core;

  const HANDLE = /^[0-9a-f]{64}$/;
  const MESSAGE_KEYS = ['handle', 'guest', 'kind', 'site', 'view'];
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  // --- Shapes several kinds share -------------------------------------------

  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
  const HASH = /^0x[0-9a-fA-F]{64}$/;
  const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
  const RATIO = /^[0-9]+(?:\.[0-9]+)?$/;
  // Every byte a page may send, as hex: a field's bound is the whole view's.
  // A view within one message stays within 256 KiB however long a field's
  // bound; one main sends in parts, within 4 MiB (APS-4).
  const MAX_HEX = MAX_PARTED_VIEW_BYTES;
  // A view in parts (APS-4): how many, and its JSON's length in UTF-16 code
  // units, which is never more than its bytes.
  const PARTS = record({ count: integer({ min: 1, max: 256 }), length: integer({ min: 1, max: MAX_PARTED_VIEW_BYTES }) });

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
      { account: ACCOUNT, reason: oneOf('sign', 'send', 'feeds', 'signing'), failed: boolean(), touchId: boolean() },
      { optional: ['account', 'failed', 'touchId'] }
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
      if (view.failed === true) body.append(ui.warning(view.touchId ? "Couldn't unlock: try again" : 'Incorrect password'));
      const field = ui.password('Enter password');
      body.append(field.element);
      // Touch ID, where main offers it (macOS, quick unlock set up): main
      // asks the system for it, and the password never leaves main.
      if (view.touchId === true) body.append(ui.note('Leave the password empty to unlock with Touch ID.'));
      return {
        choices() {
          const password = field.value();
          if (password.length > 0) return { password };
          return view.touchId === true ? { touchId: true } : null;
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

  // --- The wallet's own (APS-3): main's view of the request a token binds ---

  const WALLET_ACCOUNT = record({
    index: nullable(integer({ min: 0 })),
    name: text(256),
    address: nullable(text(42, { pattern: ADDRESS })),
    type: text(32, { pattern: /^[a-z][a-z0-9-]*$/ }),
  });
  const SEND_CHAIN = record({ id: integer({ min: 1 }), name: nullable(text(128)), symbol: text(32) });
  const TX = record({ to: text(42, { pattern: ADDRESS }), value: decimal(), data: text(MAX_HEX, { pattern: HEX }) });
  const TRANSFER = nullable(record({ token: text(42, { pattern: ADDRESS }), recipient: text(42, { pattern: ADDRESS }), amount: decimal() }));
  const WALLET_FEE = nullable(
    anyOf(
      record({ gasLimit: decimal(), maxFeePerGas: decimal(), maxPriorityFeePerGas: decimal() }),
      record({ gasLimit: decimal(), gasPrice: decimal() })
    )
  );
  const NONCE = integer({ min: 0 });

  const walletAccountText = (account) => {
    if (account.index === null) return account.address ? `An account not in this wallet  ${account.address}` : 'An account not in this wallet';
    return accountText(account);
  };

  /** The fee: the most it can cost, and how it compares, as main judged it. */
  function feeLines(ui, body, view) {
    const symbol = view.chain.symbol;
    const verdict = view.feeCheck;
    const perGas = view.fee ? view.fee.maxFeePerGas || view.fee.gasPrice : null;
    const most = verdict?.maxCost || (view.fee ? (BigInt(view.fee.gasLimit) * BigInt(perGas)).toString() : null);
    body.append(most ? ui.own('Network fee', `Up to ${upTo(most)} ${symbol}`) : ui.own('Network fee', 'Your phone picks it'));
    if (!verdict) return;
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

  /** What a transaction sends: its recipient, value and data, and a token transfer read from the data. */
  function txLines(ui, body, view) {
    const symbol = view.chain.symbol;
    if (view.transfer) {
      body.append(
        ui.own('Token transfer', 'An ERC-20 transfer, read from the data below'),
        ui.page('Token contract', view.transfer.token, { mono: true }),
        ui.page('To', view.transfer.recipient, { mono: true }),
        ui.page('Amount, in the token\'s smallest units', view.transfer.amount)
      );
    } else {
      body.append(ui.page('To', view.tx.to, { mono: true }));
    }
    body.append(ui.page('Value', `${units(view.tx.value)} ${symbol}`));
    body.append(view.tx.data === '0x' ? ui.own('Data', 'No data') : ui.page('Data', view.tx.data, { mono: true }));
    body.append(ui.own('Network', chainText(view.chain)));
  }

  const noChoices = () => ({});
  const sendAgainLabel = (label) => (view) => (view.feeAskAgain ? 'Send anyway' : label);

  const walletSend = Object.freeze({
    schema: record({
      account: WALLET_ACCOUNT,
      chain: SEND_CHAIN,
      tx: TX,
      transfer: TRANSFER,
      fee: WALLET_FEE,
      feeCheck: nullable(FEE_CHECK),
      feeAskAgain: boolean(),
    }),
    heading: () => 'Confirm Send',
    approve: sendAgainLabel('Send'),
    render(view, ui, body) {
      body.append(ui.note('You are sending from your wallet'), ui.own('From', walletAccountText(view.account)));
      txLines(ui, body, view);
      feeLines(ui, body, view);
      if (DEVICE_NOTES[view.account.type]) body.append(ui.note(DEVICE_NOTES[view.account.type]));
      return { choices: noChoices };
    },
  });

  const walletSafeSend = Object.freeze({
    schema: record({ account: WALLET_ACCOUNT, chain: SEND_CHAIN, tx: TX, transfer: TRANSFER }),
    heading: () => 'Confirm Transaction',
    approve: () => 'Confirm',
    render(view, ui, body) {
      body.append(ui.note('Your multi-owner account starts a transaction'), ui.own('From', walletAccountText(view.account)));
      txLines(ui, body, view);
      body.append(
        ui.own('Network fee', 'Paid by an owner account when it executes'),
        ui.note('Its owners then sign it. It executes once enough of them have.')
      );
      return { choices: noChoices };
    },
  });

  const HASH_TEXT = text(66, { pattern: HASH });
  // `replaced`, main's own: the transaction a resend of this payment was
  // approved for moments ago, before the payment was replaced (APS-4).
  const walletIntentResend = Object.freeze({
    schema: record({ account: WALLET_ACCOUNT, chain: SEND_CHAIN, nonce: NONCE, hash: HASH_TEXT, replaced: nullable(HASH_TEXT) }),
    heading: () => 'Send again',
    approve: () => 'Send again',
    render(view, ui, body) {
      if (view.replaced) {
        body.append(
          ui.warning(
            'This payment was replaced with a higher fee after you approved sending it again, so that approval no longer applies. Approve again to send its latest transaction, below.'
          )
        );
      }
      body.append(
        ui.note('The same signed payment, sent to the network again'),
        ui.own('From', walletAccountText(view.account)),
        ui.own('Network', chainText(view.chain)),
        ui.own('Nonce', String(view.nonce)),
        ui.own('Transaction', view.hash)
      );
      if (view.replaced) body.append(ui.own('Approved before', view.replaced));
      return { choices: noChoices };
    },
  });

  const walletIntentReplace = Object.freeze({
    schema: record({
      account: WALLET_ACCOUNT,
      chain: SEND_CHAIN,
      nonce: NONCE,
      tx: TX,
      transfer: TRANSFER,
      fee: WALLET_FEE,
      feeCheck: nullable(FEE_CHECK),
      feeAskAgain: boolean(),
    }),
    heading: () => 'Replace with a higher fee',
    approve: sendAgainLabel('Replace'),
    render(view, ui, body) {
      body.append(
        ui.note('The same payment, signed again with a higher fee. Only one of the two can go through.'),
        ui.own('From', walletAccountText(view.account)),
        ui.own('Nonce', String(view.nonce))
      );
      txLines(ui, body, view);
      feeLines(ui, body, view);
      if (DEVICE_NOTES[view.account.type]) body.append(ui.note(DEVICE_NOTES[view.account.type]));
      return { choices: noChoices };
    },
  });

  const walletIntentClose = Object.freeze({
    schema: record({ account: WALLET_ACCOUNT, chain: SEND_CHAIN, nonce: NONCE, hashes: list(64, HASH_TEXT) }),
    heading: () => 'Close payment',
    approve: () => 'Close payment',
    render(view, ui, body) {
      body.append(
        ui.note(
          "We couldn't confirm whether this payment went through. Once closed, it can no longer be sent. Check the explorer for its transactions below."
        ),
        ui.own('From', walletAccountText(view.account)),
        ui.own('Network', chainText(view.chain)),
        ui.own('Nonce', String(view.nonce))
      );
      for (const hash of view.hashes) body.append(ui.own('Transaction', hash));
      return { choices: noChoices };
    },
  });

  const walletExecutorSend = Object.freeze({
    schema: record({
      account: WALLET_ACCOUNT,
      chain: SEND_CHAIN,
      tx: TX,
      fee: WALLET_FEE,
      feeCheck: nullable(FEE_CHECK),
      feeAskAgain: boolean(),
    }),
    heading: () => 'Confirm the network fee',
    approve: sendAgainLabel('Confirm fee and execute'),
    render(view, ui, body) {
      body.append(
        ui.note('An owner account pays the network fee to execute a multi-owner transaction'),
        ui.own('Paid by', walletAccountText(view.account)),
        ui.own('Multi-owner account', view.tx.to),
        ui.own('Network', chainText(view.chain))
      );
      feeLines(ui, body, view);
      return { choices: noChoices };
    },
  });


  // --- x402 (APS-5): a 402's payment and an auto-pay cap's edit, as main
  // holds them. The seller's entry (its scheme, network, asset, amount and
  // recipient) and the paid URL are the server's choice, shown as a page's;
  // the site key, the chain and the asset's symbol are main's.

  // A field's bound is the whole view's, as for hex: the paid URL is the
  // page's, and no shorter bound would let a payment the card shows through.
  const MAX_URL = MAX_PARTED_VIEW_BYTES;
  const X402_TOKEN = nullable(record({ symbol: text(32), decimals: integer({ min: 0, max: 77 }) }));
  const X402_TEXT = text(1024);
  const SECONDS = integer({ min: 1 });

  /** A span of seconds in the largest whole unit it divides into. */
  function durationText(seconds) {
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    const DAY = 24 * 60 * 60;
    if (seconds % (365 * DAY) === 0) return plural(seconds / (365 * DAY), 'year');
    if (seconds % DAY === 0) return plural(seconds / DAY, 'day');
    if (seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
    if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
    return plural(seconds, 'second');
  }

  /** A wall-clock time in seconds, in UTC to the minute. */
  function timeText(seconds) {
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? String(seconds) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }

  /** An amount of an asset's base units, in whole units when main knows the asset. */
  const assetAmount = (amount, token) => (token ? `${units(amount, token.decimals)} ${token.symbol}` : `${amount} base units`);

  const walletX402Payment = Object.freeze({
    schema: record({
      account: WALLET_ACCOUNT,
      site: text(2048),
      url: text(MAX_URL),
      payment: record({ scheme: X402_TEXT, network: X402_TEXT, asset: X402_TEXT, amount: decimal(), payTo: X402_TEXT }),
      chain: nullable(SEND_CHAIN),
      token: X402_TOKEN,
      grant: nullable(record({ capAmount: decimal(), windowSeconds: SECONDS })),
    }),
    heading: () => 'Payment Required',
    approve: () => 'Pay',
    render(view, ui, body) {
      const { payment, token } = view;
      body.append(
        ui.own('Requested by', view.site),
        ui.own('From', walletAccountText(view.account)),
        ui.page('Amount', assetAmount(payment.amount, token)),
        ui.page('To', payment.payTo, { mono: true })
      );
      if (!token) {
        body.append(
          ui.page('Asset', payment.asset, { mono: true }),
          ui.warning("This site asks for payment in an asset Freedom doesn't recognise.")
        );
      }
      body.append(
        view.chain ? ui.own('Network', chainText(view.chain)) : ui.page('Network', payment.network),
        ui.page('Payment scheme', payment.scheme),
        ui.page('Page', view.url)
      );
      if (view.grant) {
        body.append(
          ui.section('Auto-pay future payments to this site'),
          ui.own('Spend cap', assetAmount(view.grant.capAmount, token)),
          ui.own('For', durationText(view.grant.windowSeconds)),
          ui.warning('Until the cap is spent or the time is up, Freedom pays this site without asking.')
        );
      }
      if (DEVICE_NOTES[view.account.type]) body.append(ui.note(DEVICE_NOTES[view.account.type]));
      return { choices: noChoices };
    },
  });

  const walletX402CapUpdate = Object.freeze({
    schema: record({
      site: text(2048),
      chain: SEND_CHAIN,
      asset: X402_TEXT,
      token: X402_TOKEN,
      current: record({ capAmount: decimal(), spentAmount: decimal(), expiresAt: integer({ min: 0 }) }),
      change: record({
        capAmount: nullable(decimal()),
        windowSeconds: nullable(SECONDS),
        expiresAt: nullable(integer({ min: 0 })),
      }),
    }),
    heading: () => 'Change auto-pay',
    approve: () => 'Save',
    render(view, ui, body) {
      const { current, change, token } = view;
      body.append(
        ui.note('Auto-pay pays this site without asking, up to its spend cap, until its time is up.'),
        ui.own('Auto-pay for', view.site),
        ui.own('Network', chainText(view.chain)),
        token ? ui.own('Asset', token.symbol) : ui.page('Asset', view.asset, { mono: true }),
        ui.own('Spent so far', assetAmount(current.spentAmount, token))
      );
      let widens = false;
      if (change.capAmount !== null) {
        widens = widens || BigInt(change.capAmount) > BigInt(current.capAmount);
        body.append(
          ui.own('Spend cap now', assetAmount(current.capAmount, token)),
          ui.own('New spend cap', assetAmount(change.capAmount, token))
        );
      }
      if (change.windowSeconds !== null && change.expiresAt !== null) {
        widens = widens || change.expiresAt > current.expiresAt;
        body.append(
          ui.own('Ends now', timeText(current.expiresAt)),
          ui.own('New end', `${timeText(change.expiresAt)}, ${durationText(change.windowSeconds)} after it was granted`)
        );
      }
      body.append(
        widens
          ? ui.warning('This lets the site take more without asking.')
          : ui.note('This lowers what the site can take without asking.')
      );
      return { choices: noChoices };
    },
  });


  // --- The Safe signing boards (APS-3b): main's view of a board -------------

  const BOARD_ACCOUNT = record({ index: integer({ min: 0 }), name: text(256), address: nullable(text(42, { pattern: ADDRESS })) });
  const BOARD_OWNER = record({
    index: integer({ min: 0 }),
    name: text(256),
    address: nullable(text(42, { pattern: ADDRESS })),
    type: text(32, { pattern: /^[a-z][a-z0-9-]*$/ }),
    signed: boolean(),
  });
  const BOARD_FIELDS = Object.freeze({
    safe: BOARD_ACCOUNT,
    threshold: integer({ min: 1, max: 256 }),
    collected: integer({ min: 0, max: 256 }),
    owners: list(64, BOARD_OWNER),
    notes: list(64, record({ owner: integer({ min: 0 }), note: oneOf('declined', 'failed', 'locked'), message: nullable(text(300)) })),
    step: oneOf('collect', 'retry', 'superseded', 'discard'),
    error: nullable(record({ code: oneOf('needs-funds', 'fee', 'locked', 'failed'), message: nullable(text(300)) })),
  });
  const OWNER_TYPES = Object.freeze({ ledger: 'Ledger', remote: 'Phone', mnemonic: 'This browser' });
  const NOTE_COPY = Object.freeze({
    declined: 'Declined on the device',
    failed: 'Signing failed: try again',
    locked: 'Unlock your wallet to sign',
  });
  const ERROR_COPY = Object.freeze({
    'needs-funds': 'The owner account that pays the network fee needs funds. Add xDAI to it, then try again: the signatures are kept.',
    fee: "The network fee wasn't confirmed. The signatures are kept: you can try again.",
    locked: 'Your wallet is locked: unlock it to execute the transaction.',
    failed: "The transaction didn't execute. The signatures are kept: you can try again.",
  });
  const BOARD_HEADINGS = Object.freeze({
    collect: 'Collect signatures',
    retry: 'Collect signatures',
    superseded: 'Transaction outdated',
    discard: 'Discard transaction?',
  });

  const ownerName = (owner) => owner.name || `Account ${owner.index}`;
  const retryLabel = (view) => (view.error?.code === 'needs-funds' ? "I've added funds: try again" : 'Try again');

  /** A radio's value, as the decision's choices. */
  function boardChoice(value) {
    if (value === 'discard') return { action: 'discard' };
    if (value === 'retry') return { action: 'retry' };
    const owner = typeof value === 'string' ? /^owner:([0-9]{1,9})$/.exec(value) : null;
    return owner ? { action: 'sign', owner: Number(owner[1]) } : null;
  }

  /** The signatures: how many, and each owner's, with main's note for it. */
  function boardRows(view, ui, body) {
    const total = view.owners.length;
    const met = view.collected >= view.threshold;
    body.append(
      ui.own('Signatures', `${view.collected} of ${view.threshold}`),
      ui.note(total > view.threshold ? `Any ${view.threshold} of the ${total} owners can sign.` : `All ${view.threshold} owners must sign.`)
    );
    const notes = new Map(view.notes.map((note) => [note.owner, note]));
    for (const owner of view.owners) {
      const status = owner.signed ? 'Signed' : met ? 'Not needed' : 'Not signed yet';
      const note = notes.get(owner.index);
      const noted = note ? `${status}. ${note.note === 'failed' && note.message ? note.message : NOTE_COPY[note.note]}` : status;
      // The name is a value, shown with its escapes; the label is fixed copy.
      const named = `${ownerName(owner)}: ${noted}`;
      body.append(ui.own(`Owner (${OWNER_TYPES[owner.type] || owner.type})`, owner.address ? `${named}  ${owner.address}` : named));
    }
  }

  /** What the user can do next, and the reader of their choice. */
  function boardForm(view, ui, body, { send }) {
    if (view.step === 'discard') {
      body.append(ui.warning('The collected signatures will be deleted: devices that already signed would need to sign again.'));
      return { choices: () => ({ action: 'discard' }) };
    }
    if (view.step === 'superseded') {
      body.append(
        ui.warning(
          'This transaction can no longer be executed: the account has processed another transaction since it was created (possibly this one, from an earlier attempt).'
        ),
        ui.note("Check your payment history; if the send isn't there, discard this and start again.")
      );
      return { choices: () => ({ action: 'discard' }) };
    }
    const options = [];
    if (view.step === 'retry') {
      body.append(ui.warning(ERROR_COPY[view.error?.code] || ERROR_COPY.failed));
      if (view.error?.message) body.append(ui.own('Reason', view.error.message));
      options.push({ value: 'retry', label: retryLabel(view) });
    } else {
      for (const owner of view.owners) {
        if (!owner.signed) {
          options.push({ value: `owner:${owner.index}`, label: `Sign with ${ownerName(owner)}`, detail: OWNER_TYPES[owner.type] || owner.type });
        }
      }
    }
    if (send) options.push({ value: 'discard', label: 'Discard this transaction', detail: 'You are asked again first' });
    if (options.length === 0) return { choices: () => null };
    const picker = ui.radios('board', options, options[0].value);
    body.append(picker.element);
    const labelOf = (value) => {
      const choice = boardChoice(value);
      if (choice?.action === 'discard') return 'Discard';
      if (choice?.action === 'retry') return retryLabel(view);
      return 'Sign';
    };
    return {
      choices: () => boardChoice(picker.value()),
      watch: (listener) => picker.onChange((value) => listener(labelOf(value))),
    };
  }

  function boardApprove(view) {
    if (view.step === 'discard') return 'Discard';
    if (view.step === 'superseded') return 'Discard transaction';
    if (view.step === 'retry') return retryLabel(view);
    return view.owners.some((owner) => !owner.signed) ? 'Sign' : 'Discard';
  }

  const ethSafeMessage = Object.freeze({
    schema: record({ ...BOARD_FIELDS, method: oneOf('personal_sign', 'eth_signTypedData_v4') }),
    heading: (view) => BOARD_HEADINGS[view.step],
    approve: boardApprove,
    reject: () => 'Cancel request',
    render(view, ui, body) {
      body.append(
        ui.note('requests a signature from your multi-owner account'),
        ui.own('Account', accountText(view.safe)),
        ui.own('Signing', view.method === 'personal_sign' ? 'A message' : 'Structured data (EIP-712)')
      );
      boardRows(view, ui, body);
      body.append(ui.note('No transaction is sent: once enough owners have signed, the combined signature goes back to the site.'));
      return boardForm(view, ui, body, { send: false });
    },
  });

  // A send's board: the SafeTx main holds, as it executes it.
  const SAFE_SEND_BOARD = record({ ...BOARD_FIELDS, chain: SEND_CHAIN, tx: TX, transfer: TRANSFER, executor: nullable(BOARD_ACCOUNT) });

  function safeSendBoard(lead) {
    return Object.freeze({
      schema: SAFE_SEND_BOARD,
      heading: (view) => BOARD_HEADINGS[view.step],
      approve: boardApprove,
      reject: (view) => (view.step === 'discard' ? 'Keep' : 'Leave'),
      render(view, ui, body) {
        body.append(ui.note(lead), ui.own('From', accountText(view.safe)));
        txLines(ui, body, view);
        boardRows(view, ui, body);
        body.append(
          ui.own('Network fee', view.executor ? `Paid by ${accountText(view.executor)} when it executes` : 'Paid by an owner account when it executes'),
          ui.note('It executes once enough owners have signed. You can leave: the transaction waits, and you can continue it from the wallet.')
        );
        return boardForm(view, ui, body, { send: true });
      },
    });
  }

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
    'wallet.send': walletSend,
    'wallet.safe_send': walletSafeSend,
    'wallet.intent_resend': walletIntentResend,
    'wallet.intent_replace': walletIntentReplace,
    'wallet.intent_close': walletIntentClose,
    'wallet.executor_send': walletExecutorSend,
    'wallet.x402_payment': walletX402Payment,
    'wallet.x402_cap_update': walletX402CapUpdate,
    // The Safe signing boards (APS-3b), and the vault unlock a wallet board's
    // step asks for.
    'eth.safe_message': ethSafeMessage,
    'eth.safe_send': safeSendBoard('requests a transaction from your multi-owner account'),
    'wallet.safe_board': safeSendBoard("Your multi-owner account's transaction"),
    'wallet.vault_unlock': vaultUnlock,
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
   *
   * A view over 256 KiB comes in parts (APS-4): the message then has
   * `view: null` and `parts: { count, length }`, and, its other fields
   * checked, comes back with those `parts` and no view, not yet valid. The
   * page asks main for the parts and checks the joined view (`checkJoined`).
   */
  function checkMessage(message, { joined = false } = {}) {
    if (!isPlainObject(message)) return null;
    const { handle } = message;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
    const invalid = { handle, kind: null, site: null, view: null, valid: false };
    const keys = Object.keys(message);
    const kind = typeof message.kind === 'string' && hasOwn(KINDS, message.kind) ? message.kind : null;
    const parted = !joined && hasOwn(message, 'parts');
    const expected = parted ? [...MESSAGE_KEYS, 'parts'] : MESSAGE_KEYS;
    const framed =
      kind !== null &&
      keys.length === expected.length &&
      keys.every((key) => expected.includes(key)) &&
      // A page's prompt names its tab's guest; the wallet's own, none.
      (kind.startsWith('wallet.') ? message.guest === null : Number.isInteger(message.guest)) &&
      conforms(message.site, SITE);
    if (!framed) return invalid;
    if (parted) {
      return message.view === null && conforms(message.parts, PARTS)
        ? { handle, kind, site: message.site, view: null, valid: false, parts: { ...message.parts } }
        : invalid;
    }
    const valid =
      viewBytes(message.view) <= (joined ? MAX_PARTED_VIEW_BYTES : MAX_VIEW_BYTES) &&
      conforms(message.view, KINDS[kind].schema);
    return valid ? { handle, kind, site: message.site, view: message.view, valid: true } : invalid;
  }

  /**
   * A view main sent in parts (APS-4), joined: the message's view is the
   * JSON the parts make, checked as any view is, within 4 MiB. Invalid when
   * it doesn't parse.
   */
  function checkJoined(message, json) {
    if (!isPlainObject(message) || typeof json !== 'string') return null;
    let view;
    try {
      view = JSON.parse(json);
    } catch {
      return checkMessage({ handle: message.handle });
    }
    const framed = {};
    for (const key of MESSAGE_KEYS) framed[key] = key === 'view' ? view : message[key];
    return checkMessage(framed, { joined: true });
  }

  const BOARDS = new Set(['eth.safe_message', 'eth.safe_send', 'wallet.safe_board']);

  /**
   * The device an approval of this checked prompt, with these choices, waits
   * on while main signs (`ledger`, `remote`), or null. A page's prompt, by
   * its account; a Safe board, by the owner chosen to sign (APS-3b). Not the
   * wallet's other prompts (`wallet.*`): each is answered once its token is
   * minted, and the device step comes after, on the chrome's screen (design
   * 0011: "Device steps keep today's paths after the decision").
   */
  function deviceOf(prompt, choices) {
    if (!prompt?.valid || typeof prompt.kind !== 'string') return null;
    let type;
    if (BOARDS.has(prompt.kind)) {
      if (!isPlainObject(choices) || choices.action !== 'sign') return null;
      type = prompt.view.owners.find((owner) => owner.index === choices.owner && !owner.signed)?.type;
    } else {
      if (prompt.kind.startsWith('wallet.')) return null;
      type = prompt.view?.account?.type;
    }
    return type === 'ledger' || type === 'remote' ? type : null;
  }

  return Object.freeze({ KINDS, SITE, checkMessage, checkJoined, deviceOf, typedDataText, units });
});
