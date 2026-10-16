'use strict';
const { VisualTargets } = require('./visual-targets');

function fixture() {
  let document = 'document-1';
  let zoom = 1;
  let pixels = 1;
  let sameHit = true;
  const viewport = {
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    dpr: 2,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  };
  const dispatch = jest.fn();
  const targets = new VisualTargets({
    identity: () => document,
    zoom: () => zoom,
    dispatch,
    capture: async () => {
      const png = Buffer.alloc(32, pixels);
      png.writeUInt32BE(1600, 16);
      png.writeUInt32BE(1200, 20);
      return png;
    },
    evaluate: async (fn) => (fn.name === 'readVisualViewport' ? { ...viewport } : sameHit),
  });
  return {
    targets,
    dispatch,
    viewport,
    navigate: () => (document = 'document-2'),
    changeZoom: () => (zoom = 1.5),
    paint: () => pixels++,
    cover: () => (sameHit = false),
  };
}

async function prepare(f) {
  const image = await f.targets.screenshot();
  return f.targets.target({ captureRef: image.captureRef, x: 0.5, y: 0.5 });
}

test('binds a single click to the owner viewport, independently of screenshot pixel density', async () => {
  const f = fixture();
  const { ref } = await prepare(f);
  const authorization = await f.targets.inspect(ref);
  await f.targets.click(ref, authorization);
  expect(f.dispatch).toHaveBeenCalledWith({ x: 400, y: 300 });
  await expect(f.targets.click(ref, authorization)).rejects.toMatchObject({
    code: 'STALE_ELEMENT_REFERENCE',
  });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

test.each(['navigate', 'changeZoom', 'paint', 'cover', 'cancel', 'scroll', 'expire'])(
  'rejects %s after visual preparation without input',
  async (change) => {
    const f = fixture();
    const { ref } = await prepare(f);
    const authorization = await f.targets.inspect(ref);
    if (change === 'cancel') f.targets.clear();
    else if (change === 'scroll') f.viewport.y = 100;
    else if (change === 'expire') f.targets.targets.get(ref).expires = 0;
    else f[change]();
    await expect(f.targets.click(ref, authorization)).rejects.toMatchObject({
      code: 'STALE_ELEMENT_REFERENCE',
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  }
);

test('requires host authorization and refuses another owner capture and reference', async () => {
  const f = fixture();
  const foreign = fixture();
  const image = await f.targets.screenshot();
  await expect(
    foreign.targets.target({ captureRef: image.captureRef, x: 0.5, y: 0.5 })
  ).rejects.toBeDefined();
  const { ref } = await prepare(f);
  await expect(f.targets.click(ref)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(foreign.targets.inspect(ref)).rejects.toBeDefined();
  expect(f.dispatch).not.toHaveBeenCalled();
});

test('changed image never produces an actionable target', async () => {
  const f = fixture();
  const image = await f.targets.screenshot();
  f.paint();
  await expect(
    f.targets.target({ captureRef: image.captureRef, x: 0.2, y: 0.2 })
  ).rejects.toMatchObject({ code: 'STALE_ELEMENT_REFERENCE' });
  expect(f.targets.targets.size).toBe(0);
});
