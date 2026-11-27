'use strict';

// Official ENSv2 deployments and ABI fragments, contracts-v2 (MIT), pinned at
// 4f47cbcc11462fb413196e6b5c0f8090247a6c08. Runtime hashes independently checked
// at mainnet block 0x192817e against two RPCs and the source's immutable masks.
const { Interface } = require('ethers');
const V2_ADDRESSES = Object.freeze({
  'ensRegistrar': '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81',
  'ensRenewerV1': '0x56c447f308f463a01121c41e72b0e7e7557fcb68',
  'ensRegistry': '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2',
  'ensPublicResolver': '0x66f9f566ff2f26309c1bd9134388478a801da3e1',
  'ensOracle': '0x76f29609a363a8a1a2a6abe2e859c0f8916af469',
  'ensResolverImpl': '0x565b0f456a04ac9b48758190e90030623cff57c5',
  'ensFactory': '0x77510ba162dfea3d8989e3f0928a691b345730d2',
  'usdc': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'dai': '0x6B175474E89094C44Da98b954EedeAC495271d0F'
});
const V2_CODE_HASHES = Object.freeze({
  'ensRegistrar': '0x48986eb4c6aad9469e9eb2e8b016a03c32bcdf129333a1ff9e44b83710b3893a',
  'ensRenewerV1': '0x15b939946a5d819f59ea02031fa480b2a8f3b4aa50a2f4d6319b6d7d20038118',
  'ensRegistry': '0xe2873b2a7becb1c9f1d017027d5b528ea4e797e609acaa7a4194694e718a0273',
  'ensPublicResolver': '0x2dbdf4cd030ed70fe9bc81dcf29f618d6e1c08438c45c4fb9e2e5a6c040bd99f',
  'ensOracle': '0x69ea77f5ed37a8fd60ee59d82fbaad59dbd02995d59b462139c02f0cc0009f88',
  'ensResolverImpl': '0x25df12e14187ae568dca1861b918e01b6e24a671dea6089a6dbbe60c5d3ef640',
  'ensFactory': '0xc251b434fe75ce3ca024e85883aafd7c1d0b8e382d747b537c5930018b144a91'
});
const V2_ABI = Object.freeze({
  ensRegistrar: new Interface([
    'function ETH_REGISTRY() view returns (address)',
    'function GRACE_PERIOD() view returns (uint64)',
    'function MAX_COMMITMENT_AGE() view returns (uint64)',
    'function MIN_COMMITMENT_AGE() view returns (uint64)',
    'function MIN_REGISTER_DURATION() view returns (uint64)',
    'function commit(bytes32 commitment)',
    'function commitmentAt(bytes32 commitment) view returns (uint64 commitTime)',
    'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
    'function getRenewPrice(string label, uint64 duration, address paymentToken) view returns (uint256)',
    'function isAvailable(string label) view returns (bool)',
    'function isRenewable(string label) view returns (bool)',
    'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
    'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)',
    'function rentPriceOracle() view returns (address)',
    'function renew((string label, uint64 duration, bytes32 referrer) rd, address paymentToken)'
  ]),
  ensRenewerV1: new Interface([
    'function BASE_REGISTRAR() view returns (address)',
    'function ETH_REGISTRY() view returns (address)',
    'function NAME_WRAPPER() view returns (address)',
    'function WRAPPED_CONTROLLER() view returns (address)',
    'function getRenewPrice(string label, uint64 duration, address paymentToken) view returns (uint256)',
    'function isRenewable(string label) view returns (bool)',
    'function renew((string label, uint64 duration, bytes32 referrer) rd, address paymentToken)',
    'function rentPriceOracle() view returns (address)'
  ]),
  ensRegistry: new Interface([
    'function ROOT_RESOURCE() view returns (uint256)',
    'function findExpiry(string label) view returns (uint64)',
    'function findOwner(string label) view returns (address)',
    'function getResolver(string label) view returns (address)',
    'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource) state)',
    'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)'
  ]),
  ensPublicResolver: new Interface([
    'function addr(bytes32 node) view returns (address)',
    'function addr(bytes32 node, uint256 coinType) view returns (bytes addressBytes)',
    'function canModifyName(bytes32 node, address operator) view returns (bool)',
    'function contenthash(bytes32 node) view returns (bytes)',
    'function setAddr(bytes32 node, uint256 coinType, bytes addressBytes)',
    'function setAddr(bytes32 node, address _addr)',
    'function setContenthash(bytes32 node, bytes hash)',
    'function setText(bytes32 node, string key, string value)',
    'function text(bytes32 node, string key) view returns (string)'
  ]),
  ensOracle: new Interface([
    'function isPaymentToken(address paymentToken) view returns (bool)'
  ]),
  ensResolverImpl: new Interface([
    'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
    'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
    'function resolve(bytes name, bytes data) view returns (bytes)',
    'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
    'function setContenthash(bytes name, bytes hash)',
    'function setText(bytes name, string key, string value)'
  ]),
  ensFactory: new Interface([
    'error VerificationFailed(address proxy)',
    'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
    'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
    'function predictProxyAddress(address deployer, uint256 salt) view returns (address proxy)',
    'function verifyContract(address proxy) view returns (address implementation)'
  ]),
  usdc: new Interface([
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function decimals() view returns (uint8)'
  ]),
  dai: new Interface([
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function decimals() view returns (uint8)'
  ]),
});
const PAYMENT_TOKENS = Object.freeze({ USDC: { role: 'usdc', symbol: 'USDC', decimals: 6 }, DAI: { role: 'dai', symbol: 'DAI', decimals: 18 } });
const V2_CONTRACT_NAMES = Object.freeze({ ensRegistrar: 'ENSv2 ETH Registrar', ensRenewerV1: 'ENS Legacy Renewer',
  ensRegistry: 'ENSv2 ETH Registry', ensPublicResolver: 'ENS PublicResolverV2', ensOracle: 'ENSv2 Price Oracle',
  ensResolverImpl: 'ENS Permissioned Resolver', ensFactory: 'ENS Verifiable Factory', usdc: 'USDC', dai: 'DAI' });
module.exports = { V2_ADDRESSES, V2_CODE_HASHES, V2_ABI, PAYMENT_TOKENS, V2_CONTRACT_NAMES };
