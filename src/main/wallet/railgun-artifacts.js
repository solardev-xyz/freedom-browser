/** Pinned public Railgun artifacts. WASM/zkey hashes match upstream wallet
 * 5c9d04c8; vkeys are independently derived from those zkeys before pinning.
 * Local loading never downloads. Verifier equality does not establish chain trust.
 */
const { Interface } = require('ethers');
const { getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
const manifest = {
  '01x01': [
    {
      kind: 'wasm',
      name: '01x01.wasm',
      size: 3602116,
      sha256: '37a1528543305c64805e3c607940341abf61ba8516f73cfeb625cd09e5bda7a6',
    },
    {
      kind: 'zkey',
      name: '01x01.zkey',
      size: 5888790,
      sha256: '27443e834f807f0d4ce8a0c2a0e028d1d540cba9c3e4d64b864b367e797215f4',
    },
    {
      kind: 'vkey',
      name: '01x01.vkey',
      size: 3089,
      sha256: 'b1295384591b05481ad16d579a64d0d4a4e014e251e90f1027d2bdf2dcc1a8f7',
    },
  ],
  '01x02': [
    {
      kind: 'wasm',
      name: '01x02.wasm',
      size: 3007613,
      sha256: '6ce87ddb4e33cff9564338a8b1f58047b22809e5d198f243c777d1aa4eaaa1e3',
    },
    {
      kind: 'zkey',
      name: '01x02.zkey',
      size: 6121318,
      sha256: '8ef8e7abcfb5e60fb593d4d961657465f498435a0835adef05acc09534d7557b',
    },
    {
      kind: 'vkey',
      name: '01x02.vkey',
      size: 3256,
      sha256: '9369fa6ad3d7a1becf4b10cf4bd6a7eb83725cfb5cf75a08b191c5bc2cd479f4',
    },
  ],
  '02x02': [
    {
      kind: 'wasm',
      name: '02x02.wasm',
      size: 3936627,
      sha256: '8595023762a3067b70960be81e1a983c1630c9900d4caef3d608b9d849568829',
    },
    {
      kind: 'zkey',
      name: '02x02.zkey',
      size: 8461426,
      sha256: '47c279ec3fcc8bdcc7a2fb80078e38ba8ca3a7bbaa608967c3c3af82f1d454e5',
    },
    {
      kind: 'vkey',
      name: '02x02.vkey',
      size: 3422,
      sha256: '27ac4fc50fde0ca2dc62046f5f38715b6094676bcdbe4e2987875aba65cac620',
    },
  ],
  POI_3x3: [
    {
      kind: 'wasm',
      name: 'POI_3x3.wasm',
      size: 4520908,
      sha256: '831aad53c05d19f9854ed27429610da724fbdf9e1e7023aa7a90666f50b0da78',
    },
    {
      kind: 'zkey',
      name: 'POI_3x3.zkey',
      size: 13605800,
      sha256: '667984c51df2122956107c11c3c606e4e4688f70fb25515b9388cbd5140e48b3',
    },
    {
      kind: 'vkey',
      name: 'POI_3x3.vkey',
      size: 4207,
      sha256: '2f4dcbf58d383204e09240863a6f6eff249071849e5161801ebfe83691037b23',
    },
  ],
  '01x03': [
    {
      kind: 'wasm',
      name: '01x03.wasm',
      size: 3918931,
      sha256: '72e55865fccca077f443bae9f1e6762a156ea478a137efc1324fb79153050276',
    },
    {
      kind: 'zkey',
      name: '01x03.zkey',
      size: 6361742,
      sha256: '477aeca6a8ed3706f572bce0e99a7054e700a4e3c2ee4499d7013a4d7770e0d0',
    },
    {
      kind: 'vkey',
      name: '01x03.vkey',
      size: 3420,
      sha256: '649561f264ee8dc6cfbf78a989d2978d848f6a5c730bb1817659edfa54266130',
    },
  ],
  '02x03': [
    {
      kind: 'wasm',
      name: '02x03.wasm',
      size: 4098477,
      sha256: '20ab2f0987f94b6e959fcf11c9d37415c98848acd6a900a0ca75768db3938afa',
    },
    {
      kind: 'zkey',
      name: '02x03.zkey',
      size: 8700194,
      sha256: '75611fffbc675993e55964404136df2a4e59821b40103ebe7afafc6c76863d11',
    },
    {
      kind: 'vkey',
      name: '02x03.vkey',
      size: 3585,
      sha256: '2c9162607a77773b5d030012bf0d87eecf27201ad8f2f0a319a7c1661df2fb71',
    },
  ],
};
for (const entries of Object.values(manifest)) {
  entries.forEach(Object.freeze);
  Object.freeze(entries);
}
Object.freeze(manifest);
const abi = new Interface([
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
const issued = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun artifacts unavailable'), { code: 'RAILGUN_ARTIFACTS_REFUSED' });
const check = (v) => {
  if (!v) throw fail();
};
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
async function loadRailgunArtifacts({ handle, directory, variant }) {
  const context = getPrivacyContext(handle);
  check(context.subject.protocol === 'railgun' && Object.hasOwn(manifest, variant));
  const loader = createPrivacyArtifactLoader({ handle, directory, manifest: manifest[variant] });
  const buffers = {};
  try {
    for (const entry of manifest[variant]) buffers[entry.kind] = await loader.load(entry.name);
    getPrivacyContext(handle);
    const vkey = freeze(JSON.parse(buffers.vkey.toString()));
    const shape = variant.startsWith('POI_') ? null : variant.split('x').map(Number);
    check(vkey.protocol === 'groth16' && vkey.curve === 'bn128');
    check(vkey.nPublic === (shape ? 2 + shape[0] + shape[1] : 8));
    check(vkey.IC.length === vkey.nPublic + 1);
    const result = Object.freeze({ variant, wasm: buffers.wasm, zkey: buffers.zkey, vkey });
    issued.set(result, { handle, shape });
    return result;
  } catch {
    buffers.wasm?.fill(0);
    buffers.zkey?.fill(0);
    throw fail();
  } finally {
    buffers.vkey?.fill(0);
  }
}
function assertRailgunArtifactVerifier(artifacts, encoded) {
  try {
    const binding = issued.get(artifacts);
    check(
      binding?.shape &&
        typeof encoded === 'string' &&
        /^0x[0-9a-f]+$/i.test(encoded) &&
        encoded.length <= 32768
    );
    getPrivacyContext(binding.handle);
    const decoded = abi.decodeFunctionResult('getVerificationKey', encoded)[0];
    const v = artifacts.vkey;
    const g1 = (p) => ({ x: BigInt(p[0]), y: BigInt(p[1]) });
    const g2 = (p) => ({
      x: [BigInt(p[0][1]), BigInt(p[0][0])],
      y: [BigInt(p[1][1]), BigInt(p[1][0])],
    });
    // The CID is descriptive metadata; equality binds every curve point and IC.
    const expected = {
      artifactsIPFSHash: decoded.artifactsIPFSHash,
      alpha1: g1(v.vk_alpha_1),
      beta2: g2(v.vk_beta_2),
      gamma2: g2(v.vk_gamma_2),
      delta2: g2(v.vk_delta_2),
      ic: v.IC.map(g1),
    };
    check(
      abi.encodeFunctionResult('getVerificationKey', [expected]).toLowerCase() ===
        encoded.toLowerCase()
    );
  } catch {
    throw fail();
  }
}
module.exports = { manifest, loadRailgunArtifacts, assertRailgunArtifactVerifier };
