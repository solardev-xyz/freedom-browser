/** Pure hardened Railgun derivation, used only inside the trusted host. Public
 * capabilities must restrict paths before calling this helper. Caller owns and
 * must wipe the returned key; this function does not take ownership of the seed.
 */
const { createHmac } = require('crypto');
function deriveRailgunKey(seed, path) {
  if (
    !(seed instanceof Uint8Array) ||
    seed.length !== 64 ||
    typeof path !== 'string' ||
    !/^m(?:\/(?:0|[1-9][0-9]{0,9})'){1,5}$/.test(path)
  )
    throw new Error('Invalid Railgun derivation input');
  const indices = path
    .split('/')
    .slice(1)
    .map((s) => Number(s.slice(0, -1)));
  if (indices.some((i) => i >= 0x80000000)) throw new Error('Invalid Railgun derivation input');
  let node;
  try {
    node = createHmac('sha512', 'babyjubjub seed').update(seed).digest();
    for (const index of indices) {
      const input = Buffer.alloc(37);
      try {
        node.copy(input, 1, 0, 32);
        input.writeUInt32BE(index + 0x80000000, 33);
        const next = createHmac('sha512', node.subarray(32)).update(input).digest();
        node.fill(0);
        node = next;
      } finally {
        input.fill(0);
      }
    }
    const result = Buffer.alloc(32);
    node.copy(result, 0, 0, 32);
    return result;
  } finally {
    node?.fill(0);
  }
}
module.exports = { deriveRailgunKey };
