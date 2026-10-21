'use strict';

// Mainnet v1 / NameNFT deployments. Versioned ABIs are bundled, never supplied
// by a model, page, downloaded ABI or transaction request.
const { Interface, AbiCoder, ZeroAddress, ZeroHash, keccak256, toUtf8Bytes, concat } = require('ethers');
const { ens_normalize } = require('@adraffy/ens-normalize');

class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function refuse(message, code = 'DOMAIN_UNAVAILABLE') { throw new DomainError(code, message); }
const ADDRESSES = Object.freeze({
  registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  base: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
  controller: '0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547',
  wrappedController: '0x253553366Da8546fC250F225fe3d25d0C782303b',
  wrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
  resolver: '0xF29100983E058B709F3D539b0c765937B804AC15',
  wei: '0x0000000000696760E15f265e828DB644A0c242EB',
  gwei: '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6',
});
const REGISTRATION = '(string label,address owner,uint256 duration,bytes32 secret,address resolver,bytes[] data,uint8 reverseRecord,bytes32 referrer)';
const ABI = Object.freeze({
  registry: new Interface(['function owner(bytes32) view returns(address)', 'function resolver(bytes32) view returns(address)']),
  base: new Interface(['function ownerOf(uint256) view returns(address)', 'function nameExpires(uint256) view returns(uint256)', 'function controllers(address) view returns(bool)']),
  wrapper: new Interface(['function getData(uint256) view returns(address owner,uint32 fuses,uint64 expiry)', 'function controllers(address) view returns(bool)']),
  controller: new Interface([
    'function available(string) view returns(bool)', 'function valid(string) pure returns(bool)',
    'function rentPrice(string,uint256) view returns((uint256 base,uint256 premium))',
    `function makeCommitment(${REGISTRATION}) pure returns(bytes32)`, `function register(${REGISTRATION}) payable`,
    'function commit(bytes32)', 'function renew(string,uint256,bytes32) payable',
    'function commitments(bytes32) view returns(uint256)', 'function minCommitmentAge() view returns(uint256)',
    'function maxCommitmentAge() view returns(uint256)', 'function MIN_REGISTRATION_DURATION() view returns(uint256)',
  ]),
  wrappedController: new Interface(['function renew(string,uint256) payable', 'function rentPrice(string,uint256) view returns((uint256 base,uint256 premium))']),
  resolver: new Interface([
    'function contenthash(bytes32) view returns(bytes)', 'function setContenthash(bytes32,bytes)',
    'function addr(bytes32) view returns(address)', 'function setAddr(bytes32,address)',
    'function text(bytes32,string) view returns(string)', 'function setText(bytes32,string,string)',
    'function isApprovedForAll(address,address) view returns(bool)',
    'function isApprovedFor(address,bytes32,address) view returns(bool)',
  ]),
  nft: new Interface([
    'function normalize(string) pure returns(string)', 'function computeId(string) pure returns(uint256)',
    'function isAvailable(string,uint256) view returns(bool)', 'function ownerOf(uint256) view returns(address)',
    'function records(uint256) view returns(string label,uint256 parent,uint64 expiresAt,uint64 epoch,uint64 parentEpoch)',
    'function recordVersion(uint256) view returns(uint256)', 'function expiresAt(uint256) view returns(uint256)',
    'function resolve(uint256) view returns(address)',
    'function getFee(uint256) view returns(uint256)', 'function getPremium(uint256) view returns(uint256)',
    'function makeCommitment(string,address,bytes32) pure returns(bytes32)', 'function commitments(bytes32) view returns(uint256)',
    'function commit(bytes32)', 'function reveal(string,bytes32) payable', 'function renew(uint256) payable',
    'function contenthash(uint256) view returns(bytes)', 'function setContenthash(uint256,bytes)',
    'function text(uint256,string) view returns(string)', 'function setText(uint256,string,string)', 'function setAddr(uint256,address)',
  ]),
});

// Pinned observed immutable runtime identities, rechecked on chain for writes.
// See docs/agent-domain-skills-research.md; no arbitrary resolver/proxy writes.
const CODE_HASHES = Object.freeze({
  registry: '0xd6bfd5d6f1384a1f6ea57b8a8412de5552f138d42021cf7c4941e33206f529e4',
  wrapper: '0xb2d3098f0579718d88a04ee65d3c6827a76823316ceed387945ad993fc6dbb6c',
  wrappedController: '0x56aa3e2c09a6a30222598db1cffa6e657a5e5e6eef765d3cd60e44372d005cab',
  controller: '0x64051f251ade7a7b7def7b199339ab1e6d44c28fabd824fe6523a658a0b9c93d',
  base: '0x15557327bea19f454db3ec207da1a440b6d9318af56e52e2a3eba440d4b62e0a',
  resolver: '0x186d03e26f6e0224269c8f7f13a6334d625f1b83812db2045ac7de4f292e9336',
  wei: '0x5b791c832d4373a8d4f977c37d6973a5dbe0924c6d287a2effaa549be31c0221',
  gwei: '0xb0e20c7e72a371b06d4456cc5056ea06ab2366da03f8cf49698a1f956e60b068',
});

function parseName(value) {
  if (typeof value !== 'string' || value.length > 255 || value !== value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) refuse('Use a full .eth, .wei or .gwei name.', 'DOMAIN_INVALID');
  const labels = value.split('.');
  const namespace = labels.at(-1)?.toLowerCase();
  if (!['eth', 'wei', 'gwei'].includes(namespace) || labels.length < 2 || labels.some(label => !label)) refuse('Use a full .eth, .wei or .gwei name.', 'DOMAIN_INVALID');
  let normalized;
  try { normalized = ens_normalize(value); } catch { refuse('That name is not valid under the supported naming rules.', 'DOMAIN_INVALID'); }
  if (namespace !== 'eth') {
    const asciiNormalized = value.replace(/[A-Z]/g, letter => letter.toLowerCase());
    // NameNFT preserves non-ASCII bytes; never silently turn a legacy name into
    // a different registered token through ENS Unicode normalization.
    if (asciiNormalized !== normalized) refuse('This legacy Unicode name needs the namespace’s own management app; Freedom will not change its registered spelling.', 'DOMAIN_UNSUPPORTED');
    normalized = asciiNormalized;
  }
  const parts = normalized.split('.');
  let node = ZeroHash;
  for (const label of [...parts].reverse()) node = keccak256(concat([node, keccak256(toUtf8Bytes(label))]));
  return { name: normalized, namespace, label: parts[0], topLevel: parts.length === 2, node,
    tokenId: BigInt(namespace === 'eth' ? keccak256(toUtf8Bytes(parts[0])) : node).toString() };
}

function swarmContenthash(reference) {
  if (typeof reference !== 'string' || !/^[a-f0-9]{64}$/.test(reference)) refuse('Use the verified 32-byte Swarm manifest reference.', 'DOMAIN_INVALID');
  return `0xe40101fa011b20${reference}`;
}
function registrationTuple(operation, secret) {
  return [operation.label, operation.account.address, operation.duration, secret, ADDRESSES.resolver, [], 0, ZeroHash];
}
function commitmentFor(operation, secret) {
  const coder = AbiCoder.defaultAbiCoder();
  return operation.namespace === 'eth'
    ? keccak256(coder.encode([REGISTRATION], [registrationTuple(operation, secret)]))
    : keccak256(coder.encode(['bytes', 'address', 'bytes32'], [toUtf8Bytes(operation.label), operation.account.address, secret]));
}

module.exports = { ADDRESSES, ABI, CODE_HASHES, REGISTRATION, DomainError, refuse, parseName, swarmContenthash, registrationTuple, commitmentFor, ZeroAddress, ZeroHash };
