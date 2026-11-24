// Presentation of a domain transaction (register, renew, set a record) in the
// Agent approval card. Main describes the prepared transaction as typed data
// (src/main/domains/service.js presentPlan); this module only validates that
// description and words the heading, so no summary text is parsed for meaning.

const FORMAT = 'freedom-domain-approval/1';
const YEAR = 31536000;
const ACTIONS = new Set([
  'register_commit',
  'register',
  'renew',
  'set_website',
  'clear_website',
  'set_address',
  'set_text',
]);
const MAX_ITEMS = 20;

// Every control and line/paragraph separator, `\n` included, is shown as its
// code point: one summary item must never render as two.
export function domainDisplayText(value) {
  return String(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) =>
      `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`
  );
}

const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

// The typed description, or null when the request is not a domain transaction
// Freedom prepared (then the card stays the generic wallet transaction).
export function parseDomainApproval(request) {
  const wallet = request?.wallet;
  if (request?.operation !== 'domain_execute' || wallet?.kind !== 'transaction') return null;
  const value = wallet.domain;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.format !== FORMAT || !ACTIONS.has(value.action) || !isText(value.name, 255)) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) return null;
  const items = [];
  for (const item of value.items) {
    if (!item || !isText(item.label, 40) || typeof item.value !== 'string' || item.value.length > 4096)
      return null;
    items.push({ label: item.label, value: item.value });
  }
  const duration = value.durationSeconds;
  const contract = value.contract;
  // Only name the contract the wallet will actually call.
  const contractName =
    contract &&
    isText(contract.name, 80) &&
    typeof contract.address === 'string' &&
    typeof wallet.to === 'string' &&
    contract.address.toLowerCase() === wallet.to.toLowerCase()
      ? contract.name
      : '';
  return {
    action: value.action,
    name: value.name,
    durationSeconds: Number.isSafeInteger(duration) && duration > 0 ? duration : null,
    priceWei: typeof value.priceWei === 'string' && /^\d+$/.test(value.priceWei) ? value.priceWei : null,
    contractName,
    items,
  };
}

export function domainTermText(seconds) {
  if (!seconds) return '';
  if (seconds % YEAR === 0) {
    const years = seconds / YEAR;
    return `${years} ${years === 1 ? 'year' : 'years'}`;
  }
  return seconds % 86400 === 0 ? `${seconds / 86400} days` : `${seconds} seconds`;
}

export function domainApprovalHeading(domain) {
  const name = domainDisplayText(domain.name);
  const term = domainTermText(domain.durationSeconds);
  const forTerm = term ? ` for ${term}` : '';
  switch (domain.action) {
    case 'register_commit':
      return `Start registering ${name}${forTerm}?`;
    case 'register':
      return `Register ${name}${forTerm}?`;
    case 'renew':
      return `Renew ${name}${forTerm}?`;
    case 'set_website':
      return `Point ${name} to a Swarm website?`;
    case 'clear_website':
      return `Clear the website of ${name}?`;
    case 'set_address':
      return `Set the ETH address of ${name}?`;
    default:
      return `Set a text record on ${name}?`;
  }
}

export const DOMAIN_APPROVAL_SOURCE =
  'Prepared by Freedom from Agent’s domain request. The exact transaction below is held until you decide.';
