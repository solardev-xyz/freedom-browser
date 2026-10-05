const fs = require('fs');
const os = require('os');
const path = require('path');
const fsOffload = require('./fs-offload');

describe('fs-offload (#513)', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-fs-offload-'));
  });

  afterEach(() => {
    fsOffload.__setCreateWorkerForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedTree(dir, dirs = 20, filesPerDir = 50) {
    for (let d = 0; d < dirs; d += 1) {
      const sub = path.join(dir, `d${d}`, 'nested');
      fs.mkdirSync(sub, { recursive: true });
      for (let f = 0; f < filesPerDir; f += 1) {
        fs.writeFileSync(path.join(sub, `f${f}`), `data-${d}-${f}`);
      }
    }
  }

  test('removePath removes a tree without running rmSync on the main thread', async () => {
    const target = path.join(root, 'tree');
    seedTree(target);
    const rmSyncSpy = jest.spyOn(fs, 'rmSync');
    const rmSpy = jest.spyOn(fs.promises, 'rm');
    try {
      await fsOffload.removePath(target, { recursive: true, force: true });
    } finally {
      rmSyncSpy.mockRestore();
      rmSpy.mockRestore();
    }
    expect(fs.existsSync(target)).toBe(false);
    expect(rmSyncSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
  });

  test('removePath with force is a no-op for a missing path', async () => {
    await expect(
      fsOffload.removePath(path.join(root, 'missing'), { recursive: true, force: true })
    ).resolves.toBeUndefined();
  });

  test('errors come back with their code, syscall and path', async () => {
    const missing = path.join(root, 'missing');
    let caught;
    try {
      await fsOffload.removePath(missing, { recursive: true, force: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('ENOENT');
    expect(caught.path).toBe(missing);
    expect(typeof caught.syscall).toBe('string');
  });

  test('copyPath copies a tree and honours rmSync/cpSync options', async () => {
    const source = path.join(root, 'src');
    const destination = path.join(root, 'dst');
    seedTree(source, 3, 5);

    await fsOffload.copyPath(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    expect(fs.readFileSync(path.join(destination, 'd2', 'nested', 'f4'), 'utf-8')).toBe(
      'data-2-4'
    );

    // force:false + errorOnExist:true surfaces cpSync's own error code.
    await expect(
      fsOffload.copyPath(source, destination, { recursive: true, force: false, errorOnExist: true })
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EEXIST' });
  });

  test('the event loop keeps running while a removal is in flight', async () => {
    const target = path.join(root, 'tree');
    seedTree(target, 40, 100);
    let ticks = 0;
    let spinning = true;
    const spin = () => {
      if (!spinning) return;
      ticks += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    await fsOffload.removePath(target, { recursive: true, force: true });
    spinning = false;
    expect(fs.existsSync(target)).toBe(false);
    expect(ticks).toBeGreaterThan(0);
  });

  test('falls back to fs.promises when no worker can be created', async () => {
    fsOffload.__setCreateWorkerForTests(() => {
      throw new Error('no workers here');
    });
    const target = path.join(root, 'tree');
    const copy = path.join(root, 'copy');
    seedTree(target, 2, 2);

    await fsOffload.copyPath(target, copy, { recursive: true });
    await fsOffload.removePath(target, { recursive: true, force: true });

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(copy, 'd1', 'nested', 'f1'), 'utf-8')).toBe('data-1-1');
  });

  test('a worker that dies without replying rejects instead of hanging', async () => {
    const { EventEmitter } = require('events');
    fsOffload.__setCreateWorkerForTests(() => {
      const fake = new EventEmitter();
      setImmediate(() => fake.emit('exit', 1));
      return fake;
    });
    await expect(fsOffload.removePath(path.join(root, 'x'))).rejects.toThrow(
      /exited with code 1 before replying/
    );
  });
});
