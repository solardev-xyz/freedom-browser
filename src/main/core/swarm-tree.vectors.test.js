/**
 * Main's BMT and file-tree reader (swarm-tree.js) against the pinned core's
 * vectors (freedom-core design 0015, Values main derives: "held to the same
 * vectors"; design 0009, Files):
 * - each `vectors/dweb-verify.json` file tree (Ant's and Bee's, every
 *   redundancy level, Ant's lone-reference wrappers) read with
 *   `intermediate`: the chunks read are exactly its `tree`, its leaves are
 *   its content's, and the parities its split wrote are never among them;
 * - `readData`'s admission over those trees: every intermediate and every
 *   leaf slot admitted, once, and nothing else, no parity, no padding;
 * - `vectors/swarm.json`'s `trees` rebuilt with a ChunkSplitter over
 *   main's BMT: the same roots, root chunks and chunk digests; and its
 *   bodies' chunk, SOC and wrapped-root addresses.
 *
 * Skipped unless the vectors are found (test/helpers/swarm-vectors.js), as
 * swarm-grammar.vectors.test.js finds them.
 */

const {
  CHUNK_SIZE,
  MAX_SLOTS,
  Occurrences,
  chunkAddress,
  decodeSpan,
  intermediate,
  isLeaf,
  spanBytes,
  wireAddress,
} = require('./swarm-tree');
const { Admission, B, socAddress } = require('./swarm-grammar');
const {
  content,
  contentSlice,
  dataOf,
  sha256,
  swarmVectors,
} = require('../../../test/helpers/swarm-vectors');

const swarm = swarmVectors('swarm.json');
const dwebVerify = swarmVectors('dweb-verify.json');
const describeIfVectors = swarm && dwebVerify ? describe : describe.skip;

const SLOW = 120_000;

/** A file's chunk from dweb-verify.json's store. */
const wireOf = (address) => {
  const wire = dwebVerify.swarm.chunks[address];
  if (!wire) throw new Error(`no chunk ${address} in dweb-verify.json`);
  return Buffer.from(wire, 'base64');
};

/** The data references an intermediate holds past its data children: its parities. */
function parityReferences(wire, node) {
  const payload = wire.subarray(8);
  const out = [];
  for (let i = node.children.length; i < node.children.length + node.parities; i++) {
    out.push(payload.subarray(i * 32, (i + 1) * 32).toString('hex'));
  }
  return out;
}

/**
 * A file's tree read in order, as 0009's walk reads it: the chunks read
 * (intermediates, and Ant's wrappers, which pass as leaves), its leaves
 * with their offsets, lengths and depths, and its parity references.
 */
const walks = new Map();
function walkFile(file) {
  if (!walks.has(file.id)) walks.set(file.id, readFile(file));
  return walks.get(file.id);
}

function readFile(file) {
  const wrappers = new Set(file.lone_leaf_wrappers || []);
  const out = { read: new Set(), leaves: [], parities: [], intermediates: [], offset: 0n };
  const node = (address, length, depth) => {
    if (isLeaf(length)) {
      if (wrappers.has(address)) out.read.add(address);
      out.leaves.push({
        address,
        length,
        depth,
        offset: out.offset,
        wrapper: wrappers.has(address),
      });
      out.offset += length;
      return;
    }
    out.read.add(address);
    const wire = wireOf(address);
    // Main's BMT over the chunk the node serves.
    expect(wireAddress(wire)).toBe(address);
    const parsed = intermediate(wire, length);
    expect(parsed).not.toBeNull();
    if (depth > 0) out.intermediates.push({ address, length, depth });
    out.parities.push(...parityReferences(wire, parsed));
    for (const child of parsed.children) node(child.address, child.length, depth + 1);
  };
  node(file.root, BigInt(file.size), 0);
  return out;
}

const big = (file) => file.size > B;
const leafChunk = (file, leaf) => {
  const length = Number(leaf.length);
  const offset = Number(leaf.offset);
  return Buffer.concat([spanBytes(length), contentSlice(file.seed, offset, offset + length)]);
};

/** `readData`'s admission over a file, its root and intermediates fetched and answered. */
function walkedAdmission(file) {
  const admission = new Admission({
    row: 'readData',
    params: { reference: file.root },
    key: 'https://app.example',
  });
  expect(admission.ready('reachable')).toBeNull();
  admission.readyAnswered(true);
  const fetch = (address, tree, body) => {
    const verdict = admission.admit({
      form: 'chunk',
      method: 'GET',
      path: `/chunks/${address}`,
      query: [],
      headers: [],
      max_bytes: 4201,
      stream: false,
      ...(tree && { tree }),
    });
    if (verdict.rule) return verdict.rule;
    admission.settle(verdict.ticket, { status: 200, headers: [], body: body || wireOf(address) });
    return null;
  };
  expect(fetch(file.root)).toBeNull();
  const fetched = [];
  // The core's walk: every unfetched intermediate slot, until none is left.
  for (;;) {
    const next = [...admission.tree.unfetched()].find(([, length]) => !isLeaf(length));
    if (!next) break;
    const [address, length, depth] = next;
    expect(fetch(address, { length: Number(length), depth })).toBeNull();
    fetched.push({ address, length, depth });
  }
  return { admission, fetch, fetched };
}

const leafKey = (leaf) => `${leaf.address}/${leaf.length}/${leaf.depth}`;
const sorted = (list) => [...list].sort();

describeIfVectors("dweb-verify.json's file trees through main's tree reader", () => {
  test(
    'each file: the chunks read are its tree, its leaves its content, none a parity',
    () => {
      let walked = 0;
      let coded = 0;
      for (const file of dwebVerify.swarm.files) {
        if (file.size <= CHUNK_SIZE) {
          // The root is the file's one leaf.
          const leaf = Buffer.concat([spanBytes(file.size), content(file.seed, file.size)]);
          expect({ id: file.id, root: wireAddress(leaf) }).toStrictEqual({
            id: file.id,
            root: file.root,
          });
          expect(file.tree).toStrictEqual([file.root]);
          expect(file.data_leaves).toBe(1);
          continue;
        }
        expect(decodeSpan(wireOf(file.root).subarray(0, 8)).size).toBe(BigInt(file.size));
        const walk = walkFile(file);
        expect({ id: file.id, read: sorted(walk.read) }).toStrictEqual({
          id: file.id,
          read: sorted(file.tree),
        });
        expect(walk.leaves.length).toBe(file.data_leaves);
        expect(walk.offset).toBe(BigInt(file.size));
        if (file.redundancy > 0) {
          expect({ id: file.id, parities: walk.parities.length }).toStrictEqual({
            id: file.id,
            parities: file.parities,
          });
          coded += 1;
        }
        const parities = new Set(walk.parities);
        expect(walk.leaves.filter((leaf) => parities.has(leaf.address))).toStrictEqual([]);
        expect([...walk.read].filter((address) => parities.has(address))).toStrictEqual([]);
        // Every leaf's address is its content's (past B, the first and last
        // two: a 64 MiB file's sixteen thousand leaves add nothing new).
        const leaves = big(file)
          ? [...walk.leaves.slice(0, 2), ...walk.leaves.slice(-2)]
          : walk.leaves;
        for (const leaf of leaves) {
          const chunk = leafChunk(file, leaf);
          if (leaf.wrapper) {
            // Ant's lone-reference wrapper (freedom-hq/ant#234): one
            // reference under the leaf's span. As a logical leaf it adds
            // nothing; its first bytes aren't the content's.
            const wrapper = wireOf(leaf.address);
            expect(wireAddress(wrapper)).toBe(leaf.address);
            expect(wrapper.subarray(0, 8)).toStrictEqual(chunk.subarray(0, 8));
            expect(wrapper.length).toBe(8 + 32);
            expect(wrapper.subarray(8, 8 + Number(leaf.length))).not.toStrictEqual(chunk.subarray(8));
          } else {
            expect({ id: file.id, at: leaf.offset, address: wireAddress(chunk) }).toStrictEqual({
              id: file.id,
              at: leaf.offset,
              address: leaf.address,
            });
          }
        }
        walked += 1;
      }
      expect(walked).toBeGreaterThanOrEqual(20);
      expect(coded).toBeGreaterThanOrEqual(16);
    },
    SLOW
  );

  test(
    "readData admits each file's intermediates and leaves once, and no parity",
    () => {
      let played = 0;
      for (const file of dwebVerify.swarm.files) {
        if (file.size <= CHUNK_SIZE || big(file)) continue;
        const walk = walkFile(file);
        const { admission, fetch, fetched } = walkedAdmission(file);
        // The intermediates fetched are the walk's (each occurrence once).
        const key = (n) => `${n.address}/${n.length}/${n.depth}`;
        expect(sorted(fetched.map(key))).toStrictEqual(sorted(walk.intermediates.map(key)));
        // The leaves' stream, ranged over the whole file.
        const stream = admission.admit({
          form: 'bytes',
          method: 'GET',
          path: `/bytes/${file.root}`,
          query: [],
          headers: [['range', `bytes=0-${file.size - 1}`]],
          max_bytes: file.size,
          stream: true,
        });
        expect(stream.rule).toBeUndefined();
        admission.settle(stream.ticket, { status: 206, headers: [] });
        // Every leaf slot is the walk's, and each is admitted once.
        const slots = [];
        for (const [address, length, depth, count] of admission.tree.unfetched()) {
          for (let i = 0; i < count; i++) slots.push(`${address}/${length}/${depth}`);
        }
        expect(sorted(slots)).toStrictEqual(sorted(walk.leaves.map(leafKey)));
        for (const leaf of walk.leaves) {
          const body = leafChunk(file, leaf);
          expect(
            fetch(leaf.address, { length: Number(leaf.length), depth: leaf.depth }, body)
          ).toBeNull();
        }
        expect([...admission.tree.unfetched()]).toStrictEqual([]);
        expect(admission.tree.slots).toBeLessThanOrEqual(MAX_SLOTS);
        // A leaf once more is past its count.
        const [leaf] = walk.leaves;
        expect(fetch(leaf.address, { length: Number(leaf.length), depth: leaf.depth })).toBe(
          'count'
        );
        // No parity is ever admitted, at any length or depth a slot has.
        const shapes = new Set(
          [...walk.leaves, ...walk.intermediates].map((n) => `${n.length}/${n.depth}`)
        );
        for (const parity of walk.parities) {
          for (const shape of shapes) {
            const [length, depth] = shape.split('/').map(Number);
            const fresh = walkedAdmission(file);
            expect(fresh.fetch(parity, { length, depth })).toBe('value');
          }
        }
        played += 1;
      }
      expect(played).toBeGreaterThanOrEqual(15);
    },
    SLOW
  );

  test(
    'a file past B: readData walks nothing, and its tree passes the cap',
    () => {
      for (const file of dwebVerify.swarm.files.filter(big)) {
        const { admission, fetched } = walkedAdmission(file);
        expect(fetched).toStrictEqual([]);
        const stream = admission.admit({
          form: 'bytes',
          method: 'GET',
          path: `/bytes/${file.root}`,
          query: [],
          headers: [['range', `bytes=0-${file.size - 1}`]],
          max_bytes: file.size,
          stream: true,
        });
        expect(stream.rule).toBe('order');
        // Read without the cap, the occurrences are the tree's; with it, the
        // tree is refused once its slots would pass 2,562.
        const walk = walkFile(file);
        const unbounded = new Occurrences({ maxSlots: Infinity });
        const capped = new Occurrences();
        for (const occurrences of [unbounded, capped]) {
          occurrences.addChildren(wireOf(file.root), BigInt(file.size), 0);
          for (const n of walk.intermediates) {
            if (occurrences.take(n.address, n.length, n.depth) === null) {
              occurrences.addChildren(wireOf(n.address), n.length, n.depth);
            }
          }
        }
        const leaves = [];
        for (const [address, length, depth, count] of unbounded.unfetched()) {
          for (let i = 0; i < count; i++) leaves.push(`${address}/${length}/${depth}`);
        }
        expect(sorted(leaves)).toStrictEqual(sorted(walk.leaves.map(leafKey)));
        expect(capped.over).toBe(true);
        expect(
          capped.take(walk.leaves[0].address, walk.leaves[0].length, walk.leaves[0].depth)
        ).toBe('count');
      }
    },
    SLOW
  );

  test("each shape: a leaf's length is its parent's geometry's, not its own span", () => {
    for (const shape of dwebVerify.swarm.shapes) {
      const wire = wireOf(shape.root);
      const size = decodeSpan(wire.subarray(0, 8)).size;
      const node = intermediate(wire, size);
      expect(node.children.map((c) => c.address)).toStrictEqual(shape.leaves.map((l) => l.address));
      expect(node.children.map((c) => c.length)).toStrictEqual([4096n, 60n]);
      const occurrences = new Occurrences();
      occurrences.addChildren(wire, size, 0);
      expect(occurrences.take(shape.leaves[1].address, 60, 1)).toBeNull();
      expect(occurrences.take(shape.leaves[1].address, shape.leaves[1].span ?? 100, 1)).toBe(
        'value'
      );
    }
  });
});

/**
 * core-sdk's ChunkSplitter over main's BMT: leaves of 4,096 bytes, then
 * intermediates of up to 128 references, each span the bytes below it; a
 * level's lone last reference is carried up as it is.
 */
function split(data) {
  const chunks = [];
  const chunk = (span, payload) => {
    const made = { address: chunkAddress(spanBytes(span), payload), span: BigInt(span), payload };
    chunks.push(made);
    return made;
  };
  let level = [];
  for (let at = 0; at < data.length || level.length === 0; at += CHUNK_SIZE) {
    const piece = data.subarray(at, Math.min(data.length, at + CHUNK_SIZE));
    level.push(chunk(piece.length, piece));
  }
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 128) {
      const group = level.slice(i, i + 128);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const span = group.reduce((total, c) => total + c.span, 0n);
      next.push(chunk(span, Buffer.concat(group.map((c) => Buffer.from(c.address, 'hex')))));
    }
    level = next;
  }
  return { root: level[0], chunks };
}

/** swarm.json's chunk digest: SHA-256 over address ‖ u64_le(span) ‖ payload, by address. */
function chunksDigest(chunks) {
  const ordered = [...chunks].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0
  );
  return sha256(
    Buffer.concat(
      ordered.flatMap((c) => [Buffer.from(c.address, 'hex'), spanBytes(c.span), c.payload])
    )
  );
}

describeIfVectors("swarm.json's chunks over main's BMT", () => {
  test(
    "each tree, rebuilt with main's BMT, is the reference's",
    () => {
      expect(swarm.trees.length).toBeGreaterThanOrEqual(8);
      for (const tree of swarm.trees) {
        const { root, chunks } = split(content(tree.data.seed, tree.data.length));
        expect({
          id: tree.id,
          root: root.address,
          span: Number(root.span),
          payload: root.payload.toString('hex'),
          chunks: { count: chunks.length, sha256: chunksDigest(chunks) },
        }).toStrictEqual({
          id: tree.id,
          root: tree.root,
          span: tree.span,
          payload: tree.payload,
          chunks: tree.chunks,
        });
      }
    },
    SLOW
  );

  test("each chunk, SOC and wrapped-root body's addresses are main's", () => {
    const bodies = swarm.bodies.filter((b) => ['chunk', 'soc', 'bytes'].includes(b.kind));
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) {
      if (body.kind === 'chunk') {
        expect({ id: body.id, address: wireAddress(Buffer.from(body.body, 'hex')) }).toStrictEqual({
          id: body.id,
          address: body.address,
        });
      } else if (body.kind === 'soc') {
        const { result } = body;
        const chunk = chunkAddress(spanBytes(BigInt(result.span)), dataOf(body.data));
        expect({
          id: body.id,
          chunk,
          address: socAddress(body.identifier, result.owner),
        }).toStrictEqual({
          id: body.id,
          chunk: result.chunk_address,
          address: result.address,
        });
      } else {
        const { root } = body;
        const payload = Buffer.from(root.payload, 'hex');
        expect(chunkAddress(spanBytes(BigInt(root.span)), payload)).toBe(root.address);
        // The SOC a large feed write uploads wraps that root.
        expect(wireAddress(Buffer.from(body.soc_body, 'hex'))).toBe(root.address);
      }
    }
  });
});
