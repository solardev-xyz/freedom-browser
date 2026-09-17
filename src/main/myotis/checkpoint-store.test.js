const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { loadOrCreateState, replaceCheckpoint, repairState } = require('./checkpoint-store');
const { CHECKPOINT_NETWORKS, MAX_AGE_MS } = require('./checkpoint-verifier');

const NOW = Date.UTC(2026, 8, 14, 21);
const STORAGE_ERROR = { code: 'CHECKPOINT_STORAGE' };

function checkpoint(chainId = 1, rootByte = '12') {
  const config = CHECKPOINT_NETWORKS[chainId];
  const slot =
    Math.floor((NOW / 1000 - config.genesis) / config.secondsPerSlot / config.slotsPerEpoch) *
      config.slotsPerEpoch -
    config.slotsPerEpoch;
  return {
    schemaVersion: 2,
    chainId,
    network: config.network,
    root: '0x' + rootByte.repeat(32),
    slot,
    verifiedAt: NOW,
    sources: config.sources.slice(0, config.participants),
    finalizedEpoch: slot / config.slotsPerEpoch,
  };
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, JSON.stringify(value) + '\n');
}

describe('checkpoint generation store on the real filesystem', () => {
  let temporary;
  let baseDir;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freedom-checkpoint-store-'));
    baseDir = path.join(temporary, 'myotis');
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  // Keep test artifacts in the OS temporary directory. In particular, symlink
  // tests preserve displaced files with rename rather than deleting user data.
  afterEach(() => jest.restoreAllMocks());

  test('legacy snapshots and peers remain untouched outside the new bundled generation', async () => {
    await fs.mkdir(baseDir);
    const legacy = {
      'sync-state.snapshot': Buffer.from('legacy state after an old risk override'),
      'sync-state-gnosis.snapshot': Buffer.from('legacy alternate chain state'),
      'cl-peers.cache': Buffer.from('legacy peers'),
    };
    for (const [name, bytes] of Object.entries(legacy)) {
      await fs.writeFile(path.join(baseDir, name), bytes);
    }

    const created = await loadOrCreateState(baseDir, 1);
    expect(created).toMatchObject({
      schemaVersion: 1,
      chainId: 1,
      origin: 'bundled',
      checkpoint: null,
    });
    expect(created.dataDir).toBe(path.join(baseDir, 'verified-sync', created.generation));
    expect(await fs.readdir(created.dataDir)).toEqual(['anchor.json']);
    for (const [name, bytes] of Object.entries(legacy)) {
      expect(await fs.readFile(path.join(baseDir, name))).toEqual(bytes);
    }
    expect(await readJson(path.join(baseDir, 'verified-sync.json'))).toEqual({
      schemaVersion: 1,
      chainId: 1,
      generation: created.generation,
    });
    expect(await loadOrCreateState(baseDir, 1)).toEqual(created);
  });

  test.each([1, 100])(
    'verified chain %i persists its anchor and reloads the same owned generation',
    async (chainId) => {
      const record = checkpoint(chainId);
      const created = await replaceCheckpoint(baseDir, chainId, record);
      expect(created).toMatchObject({
        chainId,
        origin: 'verified',
        checkpoint: record,
      });
      expect(await fs.readdir(created.dataDir)).toEqual(['anchor.json']);
      const persisted = await readJson(path.join(created.dataDir, 'anchor.json'));
      expect(persisted).toEqual({
        schemaVersion: 1,
        nativeCheckpointApi: 26,
        chainId,
        generation: created.generation,
        origin: 'verified',
        checkpoint: record,
      });
      const snapshotName = chainId === 1 ? 'sync-state.snapshot' : 'sync-state-gnosis.snapshot';
      await fs.writeFile(path.join(created.dataDir, snapshotName), 'native-owned snapshot bytes');
      const reloaded = await loadOrCreateState(baseDir, chainId);
      expect(reloaded).toEqual({ ...created });
      expect(await fs.readFile(path.join(reloaded.dataDir, snapshotName), 'utf8')).toBe(
        'native-owned snapshot bytes'
      );
    }
  );

  test('replacement creates a clean generation and retains the old snapshot and anchor', async () => {
    const old = await replaceCheckpoint(baseDir, 1, checkpoint());
    const oldAnchor = await fs.readFile(path.join(old.dataDir, 'anchor.json'));
    await fs.writeFile(path.join(old.dataDir, 'sync-state.snapshot'), 'old committee lineage');
    await fs.writeFile(path.join(old.dataDir, 'cl-peers.cache'), 'old peers');

    const replacement = await replaceCheckpoint(baseDir, 1, checkpoint(1, '34'));
    expect(replacement.generation).not.toBe(old.generation);
    expect(await fs.readdir(replacement.dataDir)).toEqual(['anchor.json']);
    expect(await fs.readFile(path.join(old.dataDir, 'anchor.json'))).toEqual(oldAnchor);
    expect(await fs.readFile(path.join(old.dataDir, 'sync-state.snapshot'), 'utf8')).toBe(
      'old committee lineage'
    );
    expect((await loadOrCreateState(baseDir, 1)).generation).toBe(replacement.generation);
  });

  test('an aged authenticated anchor reloads so native code can assess a newer saved snapshot', async () => {
    const created = await replaceCheckpoint(baseDir, 1, checkpoint());
    Date.now.mockReturnValue(NOW + 40 * 24 * MAX_AGE_MS);
    expect(await loadOrCreateState(baseDir, 1)).toEqual({
      ...created,
    });
    // Aging does not authorize creating a fresh generation from that old record.
    const before = await fs.readFile(path.join(baseDir, 'verified-sync.json'));
    await expect(replaceCheckpoint(baseDir, 1, checkpoint())).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'))).toEqual(before);
  });

  test.each([1, 100])('migrates a patched ABI 25 checkpoint generation on chain %i without adopting its snapshot', async (chainId) => {
    const old = await replaceCheckpoint(baseDir, chainId, checkpoint(chainId));
    const anchorPath = path.join(old.dataDir, 'anchor.json');
    const record = await readJson(anchorPath);
    delete record.nativeCheckpointApi;
    await writeJson(anchorPath, record);
    const original = await fs.readFile(anchorPath);
    const snapshot = path.join(old.dataDir, chainId === 1 ? 'sync-state.snapshot' : 'sync-state-gnosis.snapshot');
    await fs.writeFile(snapshot, 'old patched lineage');
    const current = await loadOrCreateState(baseDir, chainId);
    expect(current.generation).not.toBe(old.generation);
    expect(current).toMatchObject({ origin: 'bundled', checkpoint: null, nativeCheckpointApi: 26 });
    expect(await fs.readFile(anchorPath)).toEqual(original);
    expect(await fs.readFile(snapshot, 'utf8')).toBe('old patched lineage');
    expect(await fs.readdir(current.dataDir)).toEqual(['anchor.json']);
    expect((await loadOrCreateState(baseDir, chainId)).generation).toBe(current.generation);
  });

  test.each([25, 27, '26', null])('a generation recorded against native checkpoint API %s is never resumed', async (api) => {
    const created = await replaceCheckpoint(baseDir, 1, checkpoint());
    const anchorPath = path.join(created.dataDir, 'anchor.json');
    const record = await readJson(anchorPath);
    await writeJson(anchorPath, { ...record, nativeCheckpointApi: api });
    const stored = await fs.readFile(anchorPath);
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    // The pointer still names the refused generation; nothing is rewritten.
    expect(await fs.readFile(anchorPath)).toEqual(stored);
    expect(JSON.parse(await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8')).generation)
      .toBe(created.generation);
  });

  test('native marker must match the authenticated anchor and is never rewritten', async () => {
    const current = await replaceCheckpoint(baseDir, 1, checkpoint());
    const marker = path.join(current.dataDir, 'sync-anchor.json');
    await writeJson(marker, { checkpointRoot: current.checkpoint.root, checkpointSlot: current.checkpoint.slot });
    expect((await loadOrCreateState(baseDir, 1)).generation).toBe(current.generation);
    await writeJson(marker, { checkpointRoot: '0x' + 'ff'.repeat(32), checkpointSlot: current.checkpoint.slot });
    const before = await fs.readFile(marker);
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readFile(marker)).toEqual(before);
  });

  test('dangling native marker symlink fails closed without replacement', async () => {
    const current = await replaceCheckpoint(baseDir, 1, checkpoint());
    const marker = path.join(current.dataDir, 'sync-anchor.json');
    await fs.symlink(path.join(temporary, 'absent-marker-target'), marker, 'file');
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
  });

  test('a directory and pointer belonging to another chain fail closed', async () => {
    const created = await replaceCheckpoint(baseDir, 100, checkpoint(100));
    const pointer = await fs.readFile(path.join(baseDir, 'verified-sync.json'));
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'))).toEqual(pointer);
    expect((await loadOrCreateState(baseDir, 100)).generation).toBe(created.generation);
  });

  test.each([
    ['invalid JSON', '{'],
    ['wrong schema', { schemaVersion: 2, chainId: 1, generation: randomUUID() }],
    ['traversal', { schemaVersion: 1, chainId: 1, generation: '../../another-profile' }],
    ['missing generation', { schemaVersion: 1, chainId: 1, generation: randomUUID() }],
    ['oversized pointer', ' '.repeat(16385)],
  ])('rejects %s without treating corruption as a fresh installation', async (_name, value) => {
    await loadOrCreateState(baseDir, 1);
    const pointerPath = path.join(baseDir, 'verified-sync.json');
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    await fs.writeFile(pointerPath, bytes);
    const generationsBefore = await fs.readdir(path.join(baseDir, 'verified-sync'));
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readFile(pointerPath, 'utf8')).toBe(bytes);
    expect(await fs.readdir(path.join(baseDir, 'verified-sync'))).toEqual(generationsBefore);
  });

  test.each([
    [
      'manifest chain',
      (record) => {
        record.chainId = 100;
      },
    ],
    [
      'manifest generation',
      (record) => {
        record.generation = randomUUID();
      },
    ],
    [
      'unknown origin',
      (record) => {
        record.origin = 'accepted-stale';
      },
    ],
    [
      'bundled origin carrying a checkpoint',
      (record) => {
        record.origin = 'bundled';
      },
    ],
    [
      'checkpoint chain',
      (record) => {
        record.checkpoint.chainId = 100;
      },
    ],
    [
      'checkpoint source',
      (record) => {
        record.checkpoint.sources = ['https://unapproved.invalid'];
      },
    ],
    [
      'checkpoint root',
      (record) => {
        record.checkpoint.root = '0x' + '00'.repeat(32);
      },
    ],
  ])('rejects changed %s before returning a native storage path', async (_name, mutate) => {
    const created = await replaceCheckpoint(baseDir, 1, checkpoint());
    const anchorPath = path.join(created.dataDir, 'anchor.json');
    const anchor = await readJson(anchorPath);
    mutate(anchor);
    await writeJson(anchorPath, anchor);
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
  });

  test('corrupt manifest JSON is rejected', async () => {
    const created = await replaceCheckpoint(baseDir, 1, checkpoint());
    await fs.writeFile(path.join(created.dataDir, 'anchor.json'), '{');
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
  });

  test.each(['base', 'generation root', 'generation'])(
    'rejects symlinked %s directories',
    async (target) => {
      const created = await replaceCheckpoint(baseDir, 1, checkpoint());
      const linkPath =
        target === 'base'
          ? baseDir
          : target === 'generation root'
            ? path.join(baseDir, 'verified-sync')
            : created.dataDir;
      const moved = linkPath + '.preserved';
      await fs.rename(linkPath, moved);
      await fs.symlink(moved, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(moved)).isDirectory()).toBe(true);
    }
  );

  test.each([
    'verified-sync.json',
    'anchor.json',
    'sync-state.snapshot',
    'sync-state-gnosis.snapshot',
    'cl-peers.cache',
    'cl-peers-gnosis.cache',
    'sync-anchor.json',
  ])('rejects symlinked %s even when the target is a valid regular file', async (name) => {
    const created = await replaceCheckpoint(baseDir, 1, checkpoint());
    const filename =
      name === 'verified-sync.json' ? path.join(baseDir, name) : path.join(created.dataDir, name);
    const target = path.join(temporary, name + '.preserved');
    if (name === 'verified-sync.json' || name === 'anchor.json') {
      await fs.rename(filename, target);
    } else {
      await fs.writeFile(target, 'external state must not be read or replaced');
    }
    const before = await fs.readFile(target);
    await fs.symlink(target, filename, 'file');
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readFile(target)).toEqual(before);
  });

  test('failure at the atomic pointer switch preserves the current generation', async () => {
    const current = await replaceCheckpoint(baseDir, 1, checkpoint());
    await fs.writeFile(path.join(current.dataDir, 'sync-state.snapshot'), 'current snapshot');
    const pointerPath = path.join(baseDir, 'verified-sync.json');
    const originalPointer = await fs.readFile(pointerPath);
    const originalAnchor = await fs.readFile(path.join(current.dataDir, 'anchor.json'));
    const rename = fs.rename.bind(fs);
    const failSwitch = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === pointerPath) {
        const error = new Error('simulated pointer publication failure');
        error.code = 'EIO';
        throw error;
      }
      return rename(from, to);
    });

    await expect(replaceCheckpoint(baseDir, 1, checkpoint(1, '56'))).rejects.toMatchObject(
      { code: 'CHECKPOINT_STORAGE_IO' }
    );
    failSwitch.mockRestore();
    expect(await fs.readFile(pointerPath)).toEqual(originalPointer);
    expect(await fs.readFile(path.join(current.dataDir, 'anchor.json'))).toEqual(originalAnchor);
    expect(await fs.readFile(path.join(current.dataDir, 'sync-state.snapshot'), 'utf8')).toBe(
      'current snapshot'
    );
    expect(await loadOrCreateState(baseDir, 1)).toEqual({
      ...current,
    });
    // A complete but unpublished candidate is retained and is never selected by
    // directory order or by its newer checkpoint contents.
    expect((await fs.readdir(path.join(baseDir, 'verified-sync'))).length).toBe(2);
  });

  test('a wrong-chain replacement cannot advance the current pointer', async () => {
    const current = await replaceCheckpoint(baseDir, 1, checkpoint());
    await expect(replaceCheckpoint(baseDir, 1, checkpoint(100))).rejects.toMatchObject(
      STORAGE_ERROR
    );
    expect((await loadOrCreateState(baseDir, 1)).generation).toBe(current.generation);
    expect(await fs.readdir(path.join(baseDir, 'verified-sync'))).toEqual([current.generation]);
  });

  describe('durable native ownership during migration and replacement', () => {
    const ownerName = '.freedom-myotis-owner';
    // Native owner receipt UUIDs have no v4/variant restriction.
    const retired = 'v1 retired 01234567-89ab-0def-0123-456789abcdef\n';
    const active = 'v1 active 01234567-89ab-4def-8123-456789abcdef\n';

    test.each([
      ['active', active],
      ['unknown state', 'v1 unknown 01234567-89ab-4def-8123-456789abcdef\n'],
      ['partial retirement', retired.slice(0, -1)],
      ['extra data', retired + 'x'],
      ['malformed generation', retired.replace('01234567', 'ZZZZZZZZ')],
      ['unsupported version', retired.replace('v1', 'v2')],
      ['empty', ''],
    ])(
      'legacy %s ownership blocks fresh migration without rewriting the record',
      async (_name, bytes) => {
        await fs.mkdir(baseDir);
        const owner = path.join(baseDir, ownerName);
        await fs.writeFile(owner, bytes);
        await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({
          code: 'CHECKPOINT_OWNERSHIP',
        });
        await expect(replaceCheckpoint(baseDir, 1, checkpoint())).rejects.toMatchObject({
          code: 'CHECKPOINT_OWNERSHIP',
        });
        expect(await fs.readFile(owner, 'utf8')).toBe(bytes);
        await expect(fs.stat(path.join(baseDir, 'verified-sync.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await fs.readdir(baseDir)).toEqual([ownerName]);
      }
    );

    test('valid native retired history permits migration and remains unchanged', async () => {
      await fs.mkdir(baseDir);
      const owner = path.join(baseDir, ownerName);
      await fs.writeFile(owner, retired);
      const bundled = await loadOrCreateState(baseDir, 1);
      expect(bundled.origin).toBe('bundled');
      const verified = await replaceCheckpoint(baseDir, 1, checkpoint());
      expect((await loadOrCreateState(baseDir, 1)).generation).toBe(verified.generation);
      expect(await fs.readFile(owner, 'utf8')).toBe(retired);
    });

    test.each(['legacy', 'current generation'])(
      '%s quarantine cannot be bypassed with an existing pointer',
      async (location) => {
        const current = await replaceCheckpoint(baseDir, 1, checkpoint());
        const pointer = await fs.readFile(path.join(baseDir, 'verified-sync.json'));
        const owner = path.join(location === 'legacy' ? baseDir : current.dataDir, ownerName);
        await fs.writeFile(owner, active);
        await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({
          code: 'CHECKPOINT_OWNERSHIP',
        });
        await expect(replaceCheckpoint(baseDir, 1, checkpoint(1, '56'))).rejects.toMatchObject({
          code: 'CHECKPOINT_OWNERSHIP',
        });
        expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'))).toEqual(pointer);
        expect(await fs.readdir(path.join(baseDir, 'verified-sync'))).toEqual([current.generation]);
        expect(await fs.readFile(owner, 'utf8')).toBe(active);
      }
    );

    test('a retired current generation may resume or be replaced', async () => {
      const current = await replaceCheckpoint(baseDir, 1, checkpoint());
      const owner = path.join(current.dataDir, ownerName);
      await fs.writeFile(owner, retired);
      expect(await loadOrCreateState(baseDir, 1)).toMatchObject({
        generation: current.generation,
      });
      const replacement = await replaceCheckpoint(baseDir, 1, checkpoint(1, '78'));
      expect(replacement.generation).not.toBe(current.generation);
      expect(await fs.readFile(owner, 'utf8')).toBe(retired);
    });

    test.each(['legacy', 'current generation'])(
      'rejects a symlinked %s owner even if its target says retired',
      async (location) => {
        const current = await replaceCheckpoint(baseDir, 1, checkpoint());
        const target = path.join(temporary, 'external-owner');
        await fs.writeFile(target, retired);
        const owner = path.join(location === 'legacy' ? baseDir : current.dataDir, ownerName);
        await fs.symlink(target, owner, 'file');
        await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({
          code: 'CHECKPOINT_OWNERSHIP',
        });
        expect(await fs.readFile(target, 'utf8')).toBe(retired);
      }
    );

    test('rejects a multiply linked legacy owner, matching the native supervisor', async () => {
      await fs.mkdir(baseDir);
      const target = path.join(temporary, 'external-owner');
      await fs.writeFile(target, retired);
      await fs.link(target, path.join(baseDir, ownerName));
      await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({
        code: 'CHECKPOINT_OWNERSHIP',
      });
      expect(await fs.readFile(target, 'utf8')).toBe(retired);
    });

    test('unreadable ownership is unconfirmed, not equivalent to an absent record', async () => {
      await fs.mkdir(baseDir);
      const owner = path.join(baseDir, ownerName);
      await fs.writeFile(owner, retired);
      const open = fs.open.bind(fs);
      jest.spyOn(fs, 'open').mockImplementation(async (filename, ...args) => {
        if (filename === owner) {
          const error = new Error('simulated denied read');
          error.code = 'EACCES';
          throw error;
        }
        return open(filename, ...args);
      });
      await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({
        code: 'CHECKPOINT_OWNERSHIP',
      });
    });

    test('rechecks ownership before publishing a candidate generation', async () => {
      const current = await replaceCheckpoint(baseDir, 1, checkpoint());
      const pointer = await fs.readFile(path.join(baseDir, 'verified-sync.json'));
      const owner = path.join(baseDir, ownerName);
      const open = fs.open.bind(fs);
      jest.spyOn(fs, 'open').mockImplementation(async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (String(filename).endsWith('.tmp')) await fs.writeFile(owner, active);
        return handle;
      });
      await expect(replaceCheckpoint(baseDir, 1, checkpoint(1, '90'))).rejects.toMatchObject({
        code: 'CHECKPOINT_OWNERSHIP',
      });
      expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'))).toEqual(pointer);
      expect((await readJson(path.join(baseDir, 'verified-sync.json'))).generation).toBe(
        current.generation
      );
    });

    test('a corrupt pointer cannot hide an unknown prior generation during replacement', async () => {
      const current = await replaceCheckpoint(baseDir, 1, checkpoint());
      const pointer = path.join(baseDir, 'verified-sync.json');
      await fs.writeFile(pointer, '{');
      await expect(replaceCheckpoint(baseDir, 1, checkpoint(1, '34'))).rejects.toMatchObject(
        STORAGE_ERROR
      );
      expect(await fs.readFile(pointer, 'utf8')).toBe('{');
      expect(await fs.readdir(path.join(baseDir, 'verified-sync'))).toEqual([current.generation]);
    });
  });
  test.each(['pointer', 'anchor', 'marker'])('repair preserves inconsistent %s and starts a clean bundled generation', async target => {
    const first = await replaceCheckpoint(baseDir, 1, checkpoint());
    const filename = target === 'pointer' ? path.join(baseDir, 'verified-sync.json') :
      path.join(first.dataDir, target === 'anchor' ? 'anchor.json' : 'sync-anchor.json');
    await fs.writeFile(filename, 'broken metadata');
    await fs.writeFile(path.join(first.dataDir, 'sync-state.snapshot'), 'old snapshot');
    const repaired = await repairState(baseDir, 1);
    expect(repaired).toMatchObject({ origin: 'bundled', checkpoint: null });
    expect(repaired.dataDir).not.toBe(first.dataDir);
    expect(await loadOrCreateState(baseDir, 1)).toEqual(repaired);
    expect(await fs.readFile(path.join(first.dataDir, 'sync-state.snapshot'), 'utf8')).toBe('old snapshot');
    if (target !== 'pointer') expect(await fs.readFile(filename, 'utf8')).toBe('broken metadata');
    const backups = (await fs.readdir(baseDir)).filter(name => name.startsWith('verified-sync-backup-'));
    expect(backups).toHaveLength(1);
    if (target === 'pointer') expect(await fs.readFile(path.join(baseDir, backups[0]), 'utf8')).toBe('broken metadata');
  });

  test.each(['base', 'current', 'orphan'])('repair refuses unknown ownership in %s despite a corrupt pointer', async target => {
    const first = await loadOrCreateState(baseDir, 1);
    let ownerDir = target === 'base' ? baseDir : first.dataDir;
    if (target === 'orphan') {
      ownerDir = path.join(baseDir, 'verified-sync', randomUUID());
      await fs.mkdir(ownerDir);
    }
    await fs.writeFile(path.join(ownerDir, '.freedom-myotis-owner'), `v1 active ${randomUUID()}\n`);
    await fs.writeFile(path.join(baseDir, 'verified-sync.json'), 'bad pointer');
    await expect(repairState(baseDir, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_OWNERSHIP' });
    expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8')).toBe('bad pointer');
  });

  test('repair rechecks orphan ownership immediately before publishing its new pointer', async () => {
    const first = await loadOrCreateState(baseDir, 1);
    const before = await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8');
    const orphan = path.join(baseDir, 'verified-sync', randomUUID());
    await fs.mkdir(orphan);
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (filename, ...args) => {
      if (path.basename(filename).endsWith('.tmp'))
        await fs.writeFile(path.join(orphan, '.freedom-myotis-owner'), `v1 active ${randomUUID()}\n`);
      return open(filename, ...args);
    });
    await expect(repairState(baseDir, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_OWNERSHIP' });
    expect(await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(first.dataDir, 'anchor.json'), 'utf8')).toContain(first.generation);
  });

  test('repair refuses linked generation directories and leaves their target alone', async () => {
    await loadOrCreateState(baseDir, 1);
    const outside = path.join(temporary, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(baseDir, 'verified-sync', randomUUID()), 'dir');
    await expect(repairState(baseDir, 1)).rejects.toMatchObject(STORAGE_ERROR);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test.each(['ENOSPC', 'EACCES', 'EROFS'])('%s is a storage access failure, not inconsistent data', async code => {
    jest.spyOn(fs, 'mkdir').mockRejectedValue(Object.assign(new Error('private path'), { code }));
    await expect(loadOrCreateState(baseDir, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_STORAGE_IO' });
    await expect(repairState(baseDir, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_STORAGE_IO' });
  });

});
