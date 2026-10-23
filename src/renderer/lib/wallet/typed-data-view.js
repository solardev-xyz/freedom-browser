/**
 * The approval screen's text for typed data (freedom-core design 0002,
 * "What the user is shown", #88): the identity core's view of exactly what
 * is signed, never the dApp's own JSON.
 *
 * The view is ethers' getPayload with primaryType as `primary_type`:
 * `types` (EIP712Domain included), `domain` (the fields used, chainId as a
 * hex quantity), `message` (the declared fields only, in order, integers
 * as decimal strings, bytes and addresses as lowercase hex), plus the
 * reports `ignored`, `named_type` and `chain`. Everything is shown whole:
 * nothing is cut.
 */

const INDENT = '  ';

/** `uint8[2][]` → `uint8[2]`; `Mail` → null. */
function elementType(type) {
  if (!type.endsWith(']')) return null;
  return type.slice(0, type.lastIndexOf('['));
}

/** A JSON value from the view as a line of text. */
function scalar(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** A domain chainId (a hex quantity) as decimal digits. */
export function chainIdText(quantity) {
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
      if (types[inner] || elementType(inner) !== null) {
        lines.push(`${pad}[${index}]:`);
        valueLines(lines, types, inner, item, depth + 1);
      } else {
        lines.push(`${pad}[${index}]: ${scalar(item)}`);
      }
    });
    return;
  }
  const fields = types[type];
  if (!fields) {
    lines[lines.length - 1] += ` ${scalar(value)}`;
    return;
  }
  structLines(lines, types, type, value, depth);
}

function structLines(lines, types, type, value, depth) {
  const pad = INDENT.repeat(depth);
  const fields = types[type] || [];
  if (fields.length === 0) {
    lines.push(`${pad}(no fields)`);
    return;
  }
  for (const field of fields) {
    const fieldValue = value?.[field.name];
    const nested = types[field.type] || elementType(field.type) !== null;
    if (nested) {
      lines.push(`${pad}${field.name} (${field.type}):`);
      valueLines(lines, types, field.type, fieldValue, depth + 1);
    } else {
      lines.push(`${pad}${field.name}: ${scalar(fieldValue)}`);
    }
  }
}

/**
 * The view as text: the domain, the type signed, and its message.
 * @param {object} view
 * @returns {string}
 */
export function formatTypedDataView(view) {
  const lines = [];
  const domain = view?.domain || {};
  lines.push('Domain:');
  const domainFields = Object.keys(domain);
  if (domainFields.length === 0) {
    lines.push(`${INDENT}(empty)`);
  }
  for (const name of domainFields) {
    const value = name === 'chainId' ? chainIdText(domain[name]) : scalar(domain[name]);
    lines.push(`${INDENT}${name}: ${value}`);
  }
  lines.push('');
  lines.push(`${view?.primary_type}:`);
  structLines(lines, view?.types || {}, view?.primary_type, view?.message, 1);
  return lines.join('\n');
}

/** A chain for the warning: its name when known, and its id. */
export function chainLabel(id, chains = {}) {
  const name = chains?.[id]?.name;
  return name ? `${name} (chain ${id})` : `chain ${id}`;
}

/**
 * The warnings for a view's reports (`warnings` from main: 'named-type',
 * 'chain-mismatch', 'chain-absent'). Each one keeps auto-approve from
 * signing the request; approving still signs it.
 *
 * @param {string[]} warnings
 * @param {{view: object, siteChainId?: number, chains?: object}} context
 * @returns {string[]}
 */
export function typedDataWarningTexts(warnings, { view, siteChainId, chains } = {}) {
  const texts = [];
  if (warnings.includes('named-type')) {
    texts.push(
      'The site named a different type of data than the one shown here. This screen shows what you sign, but another wallet could sign something different for this request.'
    );
  }
  if (warnings.includes('chain-mismatch')) {
    const signedFor = chainLabel(chainIdText(view?.domain?.chainId), chains);
    const siteOn = chainLabel(String(siteChainId), chains);
    texts.push(`This data is for ${signedFor}, but the site is on ${siteOn}.`);
  }
  if (warnings.includes('chain-absent')) {
    texts.push(
      'This data names no chain. The signature is valid on every chain where the contract it is for exists.'
    );
  }
  return texts;
}

/** The message's top-level fields the site sent that aren't signed. */
export function ignoredText(view) {
  const ignored = Array.isArray(view?.ignored) ? view.ignored : [];
  if (ignored.length === 0) return null;
  return `The site also sent ${ignored.length === 1 ? 'this field' : 'these fields'}, which ${ignored.length === 1 ? "isn't" : "aren't"} signed: ${ignored.join(', ')}`;
}
