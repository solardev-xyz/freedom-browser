const fs = require('node:fs');
const path = require('node:path');
const { parse, select, load } = require('./seed-pins');
const pin = (address = '1.2.3.4:30303', key = 'ab'.repeat(64)) => `enode://${key}@${address}`;

test('drops malformed entries, ambiguous addresses, DNS, IPv6 and invalid ranges', () => {
  const invalid = [
    null,
    1,
    {},
    'garbage',
    pin('host.test:30303'),
    pin('[::1]:30303'),
    pin('256.1.2.3:30303'),
    pin('01.2.3.4:30303'),
    pin('1.2.3.4:0'),
    pin('1.2.3.4:65536'),
    pin('1.2.3.4:30303?discport=30304'),
    pin('1.2.3.4:30303', 'ff'),
    pin().toUpperCase(),
  ];
  expect(parse(JSON.stringify([...invalid, pin()]))).toEqual([pin()]);
  for (const value of [undefined, null, '', '{', '{}', 'null', ' '.repeat(128 * 1024 + 1)])
    expect(parse(value)).toEqual([]);
});

test('deduplicates numeric addresses, preserving one pubkey on different addresses', () => {
  expect(
    parse(
      JSON.stringify([
        pin(),
        pin('1.2.3.4:30303', 'cd'.repeat(64)),
        pin('1.2.3.4:03030'),
        pin('1.2.3.4:3030'),
        pin('5.6.7.8:30303'),
      ])
    )
  ).toEqual([pin(), pin('1.2.3.4:3030'), pin('5.6.7.8:30303')]);
});

test('caps valid distinct pins at 64', () => {
  const pins = Array.from({ length: 80 }, (_, i) => pin(`1.2.3.${i + 1}:30303`));
  expect(parse(JSON.stringify(pins))).toEqual(pins.slice(0, 64));
});

test('selects a shuffled, deterministic subset without mutating the list', () => {
  const pins = Array.from({ length: 40 }, (_, i) => pin(`1.2.3.${i + 1}:30303`));
  const seeded = () => {
    let state = 123;
    return () => (state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32;
  };
  const selected = select(pins, 20, seeded());
  expect(selected).toHaveLength(20);
  expect(new Set(selected).size).toBe(20);
  expect(selected.every((value) => pins.includes(value))).toBe(true);
  expect(selected).toEqual(select(pins, 20, seeded()));
  expect(selected).not.toEqual(pins.slice(0, 20));
  expect(pins[0]).toBe(pin('1.2.3.1:30303'));
  expect(select(pins, 64)).toHaveLength(20);
  expect(select(pins, 3)).toHaveLength(3);
  expect(select([pin()], 20)).toEqual([pin()]);
  expect(select(pins, 0)).toEqual([]);
});

test.each([
  ['mainnet', 5],
  ['gnosis', 18],
])('bundled %s pins parse unchanged and ship in src resources', (network, count) => {
  const pins = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'seeds', `${network}.json`), 'utf8')
  );
  expect(pins).toHaveLength(count);
  expect(load(network, { env: {} })).toEqual(pins);
  expect(require('../../../package.json').build.files).toContain('src/**/*');
});

test('missing or unreadable resources are empty; per-network overrides replace the bundle', () => {
  expect(
    load('mainnet', {
      env: {},
      readFile: () => {
        throw new Error('missing');
      },
    })
  ).toEqual([]);
  expect(load('../other', { env: {} })).toEqual([]);
  const readFile = jest.fn();
  for (const value of ['[]', 'invalid', '{}', ''])
    expect(
      load('mainnet', { env: { FREEDOM_MYOTIS_BOOT_ENODES_MAINNET: value }, readFile })
    ).toEqual([]);
  expect(
    load('gnosis', {
      env: { FREEDOM_MYOTIS_BOOT_ENODES_GNOSIS: JSON.stringify([pin()]) },
      readFile,
    })
  ).toEqual([pin()]);
  expect(readFile).not.toHaveBeenCalled();
});
