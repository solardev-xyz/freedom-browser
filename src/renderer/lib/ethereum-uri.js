import { isPotentialEnsName } from './origin-utils.js';

// EIP-681 "ethereum:" URI parser — native-asset subset.
// https://eips.ethereum.org/EIPS/eip-681
//
// Accepts:
//   ethereum:<0xAddress | ENS name>[@<chainId>][?value=<wei>][&label=<str>]
//
// Rejects function-call variants ("ethereum:<token>@<chain>/transfer?...")
// explicitly so a tip link can never be confused with an ERC-20 transfer.

const SCHEME = 'ethereum:';

// Accepts integer or scientific notation ("1e18", "1.5e17"). No signs, no
// fractional wei.
const VALUE_RE = /^[0-9]+(\.[0-9]+)?([eE][0-9]+)?$/;

// Convert an EIP-681 numeric value string to an exact wei BigInt (as a
// decimal string). Returns null on malformed input or non-integer wei
// (e.g. "0.1" without exponent, "1.5e0").
export function parseWeiValue(s) {
  if (typeof s !== 'string' || !VALUE_RE.test(s)) return null;
  const [mantissa, expStr] = s.toLowerCase().split('e');
  const exp = expStr ? parseInt(expStr, 10) : 0;
  const [intPart, fracPart = ''] = mantissa.split('.');
  const shift = exp - fracPart.length;
  if (shift < 0) return null;
  const wei = BigInt(intPart + fracPart) * 10n ** BigInt(shift);
  return wei.toString();
}

// Performs no ENS resolution, no address checksumming, no chain-registry
// lookup — the caller owns semantics.
export function parseEthereumUri(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'MALFORMED' };
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(SCHEME)) {
    return { ok: false, reason: 'NOT_ETHEREUM_URI' };
  }

  let body = trimmed.slice(SCHEME.length);

  let queryStr = '';
  const qIdx = body.indexOf('?');
  if (qIdx >= 0) {
    queryStr = body.slice(qIdx + 1);
    body = body.slice(0, qIdx);
  }

  if (body.includes('/')) {
    return { ok: false, reason: 'UNSUPPORTED_FUNCTION' };
  }

  let target = body;
  let chainId = 1;
  const atIdx = body.indexOf('@');
  if (atIdx >= 0) {
    target = body.slice(0, atIdx);
    const chainIdStr = body.slice(atIdx + 1);
    if (!/^[0-9]+$/.test(chainIdStr)) return { ok: false, reason: 'MALFORMED' };
    chainId = parseInt(chainIdStr, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return { ok: false, reason: 'MALFORMED' };
    }
  }

  if (!target) return { ok: false, reason: 'MALFORMED' };

  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(target);
  const isEnsLike = isPotentialEnsName(target);
  if (!isAddress && !isEnsLike) return { ok: false, reason: 'MALFORMED' };

  const params = new URLSearchParams(queryStr);
  let value = null;
  const valueRaw = params.get('value');
  if (valueRaw !== null) {
    value = parseWeiValue(valueRaw);
    if (value === null) return { ok: false, reason: 'MALFORMED' };
  }

  const label = params.get('label');

  return {
    ok: true,
    target,
    chainId,
    value,
    label: label || null,
  };
}
